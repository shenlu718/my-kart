// ============================================================================
//  kart-math.js —— 车的运动与速度计算
//
//  这个文件只做「输入数字 → 输出数字」，不碰浏览器、不碰 3D 库，
//  所以全部可以被自动化测试覆盖（见 kart-math.test.js）。
//
//  分工：底层定基准（这个文件），上层调口味（main.js 的实时调节）。
// ============================================================================


// ---------------------------------------------------------------------------
//  车辆参数：想改手感就改这些数
// ---------------------------------------------------------------------------

/** 前进的峰值速度（米/秒）。8 ≈ 29 km/h，×1.5 倍率后约 43 km/h */
export const MAX_SPEED = 8;

/** 倒车的峰值速度（米/秒） */
export const REVERSE_SPEED = 3;

/** 加速度（米/秒²）—— 踩油门时每秒能涨多少速度。越大起步越猛 */
export const ACCEL = 5;

/** 刹车减速度（米/秒²）—— 比自然滑行快得多，才叫刹车 */
export const BRAKE = 14;

/** 松开油门后的自然阻力（米/秒²） */
export const COAST = 3;

/** 转弯时的速度损耗系数：转得越急、开得越快，掉得越多 */
export const TURN_DRAG = 0.55;

/** 转向速度（弧度/秒），2.5 ≈ 143°/秒，街机赛车那种利落手感 */
export const TURN_SPEED = 2.5;


/**
 * 车的初始状态。
 * 坐标约定沿用 Three.js：yaw = 0 时车头朝 -Z 方向（默认的"前方"）。
 */
export function createKartState() {
  return { x: 0, z: 0, yaw: 0, speed: 0 };
}


/**
 * 算下一帧的速度。
 *
 * 用户实测反馈原话：
 *   「赛车的速度不应该是固定的，他会有一个加速的过程然后到达峰值，
 *     然后转弯的时候速度肯定是会衰减，不应该过弯的速度跟直行的速度一样快。」
 *
 * 所以速度是一个会被"养起来"的状态：踩油门慢慢涨到峰值、松油门慢慢掉、
 * 转弯时额外损失一部分。
 *
 * @param {number} current 当前速度（米/秒，倒车为负）
 * @param {{forward:number, turn:number}} input
 *        forward：正数踩油门、负数刹车/倒车、0 松开。这个数就是"油门踩多深"
 *        turn：   +1 左转，-1 右转，0 不转
 * @param {number} dt 距上一帧过了多少秒
 * @param {number} maxSpeed 前进峰值，默认用 MAX_SPEED
 * @returns {number} 新的速度
 */
export function nextSpeed(current, input, dt, maxSpeed = MAX_SPEED) {
  let speed = current;

  // ---- 第一段：油门 / 刹车 / 滑行 ----
  if (input.forward > 0) {
    speed = Math.min(maxSpeed, speed + ACCEL * input.forward * dt);
  } else if (input.forward < 0) {
    speed = Math.max(-REVERSE_SPEED, speed + BRAKE * input.forward * dt);
  } else {
    // 松开油门：靠自然阻力慢慢停下来。
    // 那个 Math.abs(speed) <= drop 的判断不能省——少了它，
    // 车速会从 +0.05 一下变成 -0.1，然后一路"倒着加速"，永远停不下来。
    const drop = COAST * dt;
    speed = Math.abs(speed) <= drop ? 0 : speed - Math.sign(speed) * drop;
  }

  // ---- 第二段：转弯消耗速度 ----
  // 这就是「过弯要收油」的物理来源：转得越急、开得越快，掉得越多。
  // Math.min(loss, Math.abs(speed)) 保证速度不会被扣过头变成反方向。
  if (input.turn !== 0 && speed !== 0) {
    const loss = Math.abs(speed) * TURN_DRAG * Math.abs(input.turn) * dt;
    speed -= Math.sign(speed) * Math.min(loss, Math.abs(speed));
  }

  return speed;
}


/**
 * 走一步：根据「这一帧的输入」和「这一帧过了多少秒」，算出新状态。
 *
 * @param {{x:number, z:number, yaw:number, speed:number}} state 当前状态（本函数不修改它）
 * @param {{forward:number, turn:number}} input
 * @param {number} dt 距上一帧过了多少秒
 * @param {number} maxSpeed 前进峰值速度。上层可以调（游戏里的"速度倍率"就靠它）
 * @returns {{x:number, z:number, yaw:number, speed:number}} 全新的状态对象
 */
export function stepKart(state, input, dt, maxSpeed = MAX_SPEED) {
  // 先转方向。这一步必须排在前头，否则车会走出"先直行、再拐弯"的折线
  const yaw = state.yaw + input.turn * TURN_SPEED * dt;

  // 速度是累积出来的，不是按一下油门就到顶
  const speed = nextSpeed(state.speed, input, dt, maxSpeed);

  // 这一帧走多远 = 当前速度 × 这一帧占了几秒。
  // 乘 dt 是整段代码里最关键的一处：不乘的话，60 帧的电脑会比 30 帧的快一倍。
  const distance = speed * dt;

  // yaw = 0 朝 -Z 方向，用 -sin / -cos 把角度换算成实际的移动方向
  return {
    x: state.x - Math.sin(yaw) * distance,
    z: state.z - Math.cos(yaw) * distance,
    yaw,
    speed,
  };
}


/**
 * 把「相机俯角」换算成「相机高度」。
 *
 * 相机在车后 distance 米，要从上往下看 angleDeg 度，它该抬多高？
 * 直角三角形：tan(俯角) = 高 / 底 → 高 = 底 × tan(俯角)
 *
 * 这里有个极易搞错的点：Math.tan 收的是**弧度**，不是角度。
 * 少写那个 * Math.PI / 180，45° 会算出 tan(45 弧度) ≈ 1.62 而不是 1，
 * 相机跑到天上去。测试里专门钉了这一条。
 *
 * @param {{distance:number, angleDeg:number}} cam
 * @returns {number} 相机应该离地多高
 */
export function camHeightOf(cam) {
  return cam.distance * Math.tan((cam.angleDeg * Math.PI) / 180);
}


/**
 * 「每帧向目标靠近多少比例」——帧率无关的平滑逼近系数。
 *
 * 想让一个值平滑地追向目标，新手最容易写成：
 *
 *     value += (target - value) * 0.1      // ❌ 每帧固定 10%
 *
 * 这样 60fps 的电脑会追得比 30fps 快一倍，和之前踩过的坑同一类。
 *
 * 正确写法是把它变成时间的函数：
 *
 *     value += (target - value) * approachFactor(rate, dt)
 *
 * 这样无论拆成多少帧，经过同样长的时间，追上的程度完全一样
 * （数学上它精确等于 1 - e^(-rate × 经过的秒数)）。
 *
 * @param {number} rate 追赶速度，越大追得越紧（7 大约是 0.14 秒追上一半）
 * @param {number} dt   这一帧过了多少秒
 * @returns {number} 这一帧应该靠近目标的比例，0~1
 */
export function approachFactor(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}
