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

// ---------------------------------------------------------------------------
//  转向几何（阿克曼）—— 车不能原地打转
//
//  真车四个轮子里只有前轮转向、后轮固定，「转弯」是前轮转角 + 车速共同决定的：
//        yawRate = 车速 / 轴距 × tan(前轮转角)
//  ★ 关键：偏航率**正比于车速**。车速 0 → 偏航率 0 —— 停着打死方向盘，
//    车只摆前轮、原地不动。（用户实测报过「只按 A，车竟然自己原地转」，
//    根因就是旧的 yaw += turn × 常数 × dt 里根本没有车速这一项。）
//
//  参考实现用的是同一条式子（kart-royale/src/kart/Kart.ts）：
//        rackYaw = clamp((fwd / WHEELBASE) * tan(steerAngle), ±maxYaw)
//  并加了封顶 maxYaw = 24 / max(5, |fwd|)：高速打死方向时若照实算，
//  会要求一个轮胎根本抓不住的弯 → 打转。
// ---------------------------------------------------------------------------

/** 轴距（米）：前轮 z=-0.55 到后轮 z=+0.58，与小车的模型一致 */
export const WHEELBASE = 1.13;

/** 几何中心到后轴的距离（米）—— 后轮在 z=+0.58，那里就是后轴 */
export const HALF_BASE = 0.58;

/** 前轮最大转角（弧度）。0.55 rad ≈ 31.5°，静止满舵角（照参考实现） */
export const MAX_STEER = 0.55;

/** 偏航率封顶：maxYaw = TURN_RATE_CAP / max(TURN_RATE_CAP_SPEED, |车速|) */
export const TURN_RATE_CAP = 24;
export const TURN_RATE_CAP_SPEED = 5;

/**
 * 最小转弯半径（米）—— 低速也不许原地画小圈。
 *
 * 为什么需要（用户实测：「速度比较慢的时候长按转向，左右的视野偏移的加速度过快，使人头晕；
 * 速度比较快的时候不会出现」）：
 * 阿克曼转向的半径只由前轮角和轴距决定（R = 轴距/tan(前轮角)），**与速度无关**。
 * 于是我们这台车满舵半径 = 1.13/tan(0.55) ≈ **1.84 m**，3 m/s 时就以 **93°/s** 绕圈 ——
 * 位移很小、旋转很快，眼睛读到的是"整幅画面在快速转"，这就是晕的来源；
 * 速度快时同样的角速度有大量平移相伴，反而不晕。
 * （参考项目的车满舵半径是 1.6/tan(0.55) ≈ 2.61 m，比我们"稳"。）
 *
 * 做法：给偏航率加一条 ω ≤ 车速 / R_min 的限制 —— 低速时把转速压下来，
 * 车再也画不出小于 R_min 的圈。速度一上来这条限制自然松开。
 */
export const MIN_TURN_RADIUS = 2.8;


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
  // ---- 转向：由「车速 × 前轮转角」决定，不是直接拧朝向 ----
  // 车速为 0 时 yawRate 就是 0，所以停着打方向车不会原地转（只有前轮摆）。
  const steerAngle = input.turn * MAX_STEER;
  const yawRate = yawRateFor(state.speed, steerAngle);
  const yaw = state.yaw + yawRate * dt;

  // 速度是累积出来的，不是按一下油门就到顶
  const speed = nextSpeed(state.speed, input, dt, maxSpeed);

  // 这一帧走多远 = 当前速度 × 这一帧占了几秒。
  // 乘 dt 是整段代码里最关键的一处：不乘的话，60 帧的电脑会比 30 帧的快一倍。
  const distance = speed * dt;

  // ---- 基准点是后轴，不是几何中心 ----
  // 后轮驱动、后轮不转向，所以「沿着车头前进」的其实是**后轴**，车身绕后轴摆：
  //     rear  = center − 前向 × 半轴距
  //     rear' = rear + 前向' × distance
  //     center' = rear' + 前向' × 半轴距
  // 展开：center' = center + 前向'×(distance + 半轴距) − 前向 × 半轴距。
  // 这一帧没转向（前向' = 前向）时，它自动退化成普通的「沿车头前进」。
  const fx0 = -Math.sin(state.yaw), fz0 = -Math.cos(state.yaw); // 前向（旧朝向）
  const fx1 = -Math.sin(yaw),       fz1 = -Math.cos(yaw);       // 前向（新朝向）
  const reach = distance + HALF_BASE;

  return {
    x: state.x + fx1 * reach - fx0 * HALF_BASE,
    z: state.z + fz1 * reach - fz0 * HALF_BASE,
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


/**
 * 指数逼近 —— 把一个值平滑地推向目标。帧率无关。
 *
 * 和 approachFactor 是一对：那个给出"这一帧该靠近多少比例"，
 * 这个直接把结果算出来。
 *
 * 为什么所有"会跳变的输入"都要先过它：
 * 用户实测报过一个 bug —— 反复按 A/D 时车忽大忽小、突变。
 * 根因就是把按键的瞬时值（0 或 1 之间跳）直接接给了相机参数。
 * 中间必须有一层平滑，让相机去追一个**连续**的目标。
 *
 * @param {number} cur 当前值
 * @param {number} target 目标值
 * @param {number} tau 时间常数（秒）。越小追得越快，1 秒后走完约 63%
 * @param {number} dt 这一帧过了多少秒
 * @returns {number} 平滑后的新值
 */
export function damp(cur, target, tau, dt) {
  if (!(tau > 0)) return target;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}


/**
 * 角度版的 damp —— 走**最短的一边**。
 *
 * 为什么不能直接用 damp 处理角度：
 * 角度是环形的。从 179° 转到 -179°，实际只差 2°（跨过 ±180 那条线），
 * 可是直接相减得到 -358°，相机会绕一大圈 —— 画面上一记猛甩。
 *
 * Math.atan2(sin(diff), cos(diff)) 正好把任意角度差规整到 -π..π，
 * 这就是"最短弧"。
 *
 * @param {number} cur 当前角度（弧度）
 * @param {number} target 目标角度（弧度）
 * @param {number} tau 时间常数（秒）
 * @param {number} dt 这一帧过了多少秒
 * @returns {number} 平滑后的新角度
 */
export function dampAngle(cur, target, tau, dt) {
  const diff = Math.atan2(Math.sin(target - cur), Math.cos(target - cur));
  if (!(tau > 0)) return cur + diff;
  return cur + diff * (1 - Math.exp(-dt / tau));
}


/**
 * 相机跟随的速度系数 —— 随车速自适应。
 *
 * 为什么需要自适应？
 * 平滑跟随必然带来滞后，而滞后量 ≈ 车速 ÷ 跟随系数。
 * 系数固定时，速度越快、相机落后越多，车在屏幕上就越小：
 *
 *     系数 7，速度 8  → 落后 1.1 米（相机距车 8.1 米）
 *     系数 7，速度 24 → 落后 3.4 米（相机距车 10.4 米，车小了一圈）
 *
 * 这是用户实测发现的："峰值速度变大时相机就拉远，车突然变得很小"。
 * 让系数跟着速度一起涨，滞后量就能基本保持恒定。
 *
 * @param {number} speed 当前车速（米/秒，倒车为负）
 * @param {number} base 静止时的跟随系数
 * @param {number} gain 每 1 米/秒速度额外增加多少系数
 * @returns {number} 这一帧该用的跟随系数
 */
export function followRateFor(speed, base, gain) {
  return base + Math.abs(speed) * gain;
}


// ---------------------------------------------------------------------------
//  注：旧的 cameraSideOffset()（过弯把相机往弯外平移几米）已删除。
//  它是「表面工作」：相机平移完，下一行 camera.lookAt(车) 又把车拉回画面正中，
//  等于白做。过弯构图改由 main.js 的「构图解算」承担 —— 直接把车摆到
//  画面指定位置（见 Camera.ts 的 frameSubject）。


// ---------------------------------------------------------------------------
//  实时指标（轻量测具）
//
//  为什么把"测量"做成纯函数：
//  用户的原话是「我一个人优化手感非常麻烦」。麻烦的根子不是参数多，
//  而是**没有反馈线**——改完只能靠感觉说"好像是好一点"。
//  参考项目（kart-royale）的作者不是靠反复试参做出手感的，
//  他有 camera-probe 告诉他「镜头摆动 12 度/秒」「车占屏 11%」。
//
//  把指标的算法放进这个文件，它就能被测试钉住 ——
//  读数对不对，先用测试确认，再相信屏幕上那串数字。
// ---------------------------------------------------------------------------

/**
 * 角度的变化速率（度/秒）—— 用来量「镜头摆动得多猛」。
 *
 * 参考项目把 camera-probe 测的 swing（度/秒）当作"晕不晕"的客观指标：
 * 镜头摆得越猛、越频繁，越容易让人不适。把它显示出来，
 * 「相机是不是更稳了」就从感觉变成了一个可以前后对比的数字。
 *
 * ★ 必须走最短弧 —— 和 dampAngle 是同一个坑。
 *   179° → -179° 实际只转了 2°，直接相减却得到 -358°，
 *   会凭空多出一次"猛甩"，把摆动值虚报一百多倍。
 *   Math.atan2(sin(diff), cos(diff)) 把任意角度差规整到 -π..π。
 *
 * @param {number} prevAngle 上一帧的角度（弧度）
 * @param {number} curAngle 这一帧的角度（弧度）
 * @param {number} dt 两帧之间过了多少秒
 * @returns {number} 摆动速率（度/秒，非负；dt 不是正数时返回 0）
 */
export function angularRateDegPerSec(prevAngle, curAngle, dt) {
  // dt <= 0 直接返回 0，避免除以 0 得到 Infinity/NaN 污染整个面板。
  if (!(dt > 0)) return 0;
  const diff = Math.atan2(Math.sin(curAngle - prevAngle), Math.cos(curAngle - prevAngle));
  return (Math.abs(diff) * 180) / Math.PI / dt;
}


/**
 * 一个尺寸为 worldSize 的物体，在屏幕上占的高度比例（0~1，1 = 占满整屏高）。
 *
 * 针孔相机模型：距离 d 处，一屏高（垂直方向）对应多大的世界尺寸？
 *     可见高度 = 2 × d × tan(垂直视野 / 2)
 * 于是物体占屏比例 = worldSize ÷ 可见高度。
 *
 * 为什么需要它：用户报过「峰值速度一大，车就变小」。车到底小了多少，
 * 肉眼说不准，但这个比例能直接对比 —— 而且它**应该随速度基本不变**。
 * 相机一旦"偷跑"变远，这个数就会如实往下掉，一眼可见。
 *
 * 注意：调用方要传**真实的相机到车距离**和**真实的相机 FOV**，
 * 这样相机拉远、视野变化都会如实反映在这个读数里。
 *
 * @param {number} worldSize 物体的世界尺寸（米，这里用车的高度）
 * @param {number} distance 物体到相机的距离（米）
 * @param {number} fovDeg 相机的垂直视野（度）
 * @returns {number} 占屏比例（0~1；distance 不为正时返回 0）
 */
export function screenFraction(worldSize, distance, fovDeg) {
  if (!(distance > 0)) return 0;
  // fovDeg/2 换算成弧度：fovDeg/2 × π/180 = fovDeg × π/360
  const visibleHeight = 2 * distance * Math.tan((fovDeg * Math.PI) / 360);
  if (!(visibleHeight > 0)) return 0;
  return worldSize / visibleHeight;
}


/**
 * 把一个坐标吸附到 tile 的整数倍上（"整格对齐"）。
 *
 * 为什么需要它：地面平面是有限的，必须跟着车搬，否则车开远了会开出边缘
 * （用户实测：「行驶很长一段距离之后，地上的网格消失了，只有柱子出现」）。
 * 但地面又不能随便跟着车走 —— 那样图案和车一起动，移动感就没了。
 *
 * 关键就是**只能搬整数格**：贴图每 tile 米重复一次，搬整数格之后
 * 图案和世界坐标完全对齐，看起来地面钉死在世界里纹丝不动。
 * 要是搬了非整数格，图案就会跟着漂 —— 那又回到了"图案跟着车动"的老问题。
 *
 * @param {number} value 坐标（米）
 * @param {number} tile 一格多大（米），必须为正
 * @returns {number} 最近的整格坐标（一定是 tile 的整数倍；tile 不合法时原样返回）
 */
export function snapToTile(value, tile) {
  if (!(tile > 0)) return value;
  return Math.round(value / tile) * tile;
}


/**
 * 阿克曼转向：给定车速和前轮转角，算这一帧该有的偏航率（弧度/秒）。
 *
 *      yawRate = 车速 / 轴距 × tan(前轮转角)        ← 再对封顶做钳制
 *
 * ★ 车速为 0 时结果是 0 —— 这是「车不能原地打转」的全部依据。
 *   倒车（车速为负）时结果反号 —— 倒着打左方向，车尾往另一边摆，符合直觉。
 *
 * 封顶 maxYaw = TURN_RATE_CAP / max(TURN_RATE_CAP_SPEED, |车速|)：
 * 没有它，高速打死方向会算出一个轮胎抓不住的弯，车会瞬间打转（参考实现的原话）。
 *
 * @param {number} speed 车速（米/秒，倒车为负）—— 用**这一帧开始时**的车速
 * @param {number} steerAngle 前轮转角（弧度）
 * @param {number} wheelbase 轴距（米）
 * @returns {number} 偏航率（弧度/秒，已钳制）
 */
export function yawRateFor(speed, steerAngle, wheelbase = WHEELBASE, minRadius = MIN_TURN_RADIUS) {
  const rack = (speed / wheelbase) * Math.tan(steerAngle);
  // ① 抓地上限：高速打死方向不能要求一个轮胎抓不住的弯（否则瞬间打转）
  const gripCap = TURN_RATE_CAP / Math.max(TURN_RATE_CAP_SPEED, Math.abs(speed));
  // ② 最小转弯半径：低速也不许原地画小圈（ω = v/R）—— 治"低速转得太快会晕"
  const radiusCap = minRadius > 0 ? Math.abs(speed) / minRadius : Infinity;
  const cap = Math.min(gripCap, radiusCap);
  return Math.max(-cap, Math.min(cap, rack));
}


/**
 * 「视野（FOV）随速度张开」—— 速度感最主要的来源。
 *
 * 用户实测原话：「我看不到有加速度的趋势」。车在加速时，画面必须有变化，
 * 否则再快的数值也「看不见」。参考项目选择张开**视野**而不是拉长臂长，
 * 原注释说得很清楚：让臂长去跟着匹配，会把主体在每一帧里固定成同一个大小，
 * 反而看不出速度；视野张开则让四周的东西「向你扑过来」，这才是速度感。
 *
 * @param {number} baseFov 静止时的垂直视野（度）
 * @param {number} gainDeg 满速时额外张开多少度
 * @param {number} speed 当前车速（米/秒，取绝对值）
 * @param {number} maxSpeed 满速（米/秒）
 * @returns {number} 当前该用的垂直视野（度）
 */
export function fovForSpeed(baseFov, gainDeg, speed, maxSpeed = MAX_SPEED) {
  if (!(maxSpeed > 0)) return baseFov;
  const t = Math.min(1, Math.abs(speed) / maxSpeed);
  return baseFov + gainDeg * t;
}


/**
 * 把「构图角」换算成屏幕上的 NDC 横向位置（-1..1，0 = 正中）。
 *
 * 为什么用**角度**而不是直接给一个像素/NDC：参考实现的理由 ——
 * 「同样的三度领入，在 62° 和 100° 的视野里是同一件事」。
 * 用角度表达，换视野、换宽高比，构图感觉都不变。
 *
 * @param {number} angleRad 构图角（弧度）
 * @param {number} tanHalf 横向半视野的正切 = tan(垂直视野/2) × 宽高比
 * @returns {number} NDC 横向位置
 */
export function ndcFromAngle(angleRad, tanHalf) {
  if (!(tanHalf > 0)) return 0;
  return Math.tan(angleRad) / tanHalf;
}


/**
 * 横向加速度（米/秒²）—— 「过得多急」的客观量。
 *
 *      aLat = |车速 × 偏航率|
 *
 * 参考实现用它定义「是不是在过弯」：9.0 m/s² 算一个满弯。
 * 它比「打了多少方向」更接近体感：同样打满舵，低速时转得慢、横向加速度小；
 * 高速时一下就很大。
 *
 * @param {number} speed 车速（米/秒）
 * @param {number} yawRate 偏航率（弧度/秒）
 * @returns {number} 横向加速度（米/秒²，非负）
 */
export function lateralAccel(speed, yawRate) {
  return Math.abs(speed * yawRate);
}


/**
 * 构图的「启用程度」：0 = 画面完全不动，1 = 满额。
 *
 * 为什么需要死区：参考实现的构图是**连续**响应方位角滞后的 —— 只要打方向，
 * 画面就跟着偏一点。于是直线行驶时每一次小修正都会让画面晃。
 * 用户实测原话：「它不会每次左右转弯都会有镜头偏移的，
 * 每次左右转弯都有偏移的话，玩起来头会很晕。」
 *
 * 所以这里按体感做一处**有意偏离**参考：只有真过弯（滞后超过 deadRad）
 * 才动画面，并且用 smoothstep 平滑起步 —— 死区边界处不会跳一下。
 *
 * @param {number} lagRad 方位角滞后的大小（弧度，非负）
 * @param {number} deadRad 死区：小于它完全不动
 * @param {number} fullRad 满额：大于它给满
 * @returns {number} 0~1
 */
export function leadWeight(lagRad, deadRad, fullRad) {
  if (!(fullRad > deadRad)) return 0;
  if (!(lagRad > deadRad)) return 0;
  const t = Math.min(1, (lagRad - deadRad) / (fullRad - deadRad));
  return t * t * (3 - 2 * t); // smoothstep
}


// ---------------------------------------------------------------------------
//  舒适边界（照参考 Camera.ts）
//
//  参考文件顶部把这套相机的全部常量分成四组，其中第一组就是「方位角」，
//  并写明它的两条边界**就是舒适性的全部**：
//    「it may never fall more than MAX_LAG behind the chassis,
//      and it may never move faster than MAX_ARM_RATE.
//      Those two bounds are the whole of the comfort story.」
//  下面两个函数就是那两条边界，都是纯函数、都能测。
// ---------------------------------------------------------------------------

/**
 * 环形角度的「滞后上限」：让 cur 追 target，但**最多只落后 maxLag**。
 *
 * 为什么需要：滞后不够会看不到前方（镜头被甩到车侧），滞后过多又看不出
 * 镜头在摆。参考给的是 26°，原文说这是「决定玩家能不能看到自己去哪」的数。
 *
 * ★ 必须走最短弧 —— 和 dampAngle 同一个坑。
 *
 * @param {number} cur 当前角度（弧度）
 * @param {number} target 目标角度（弧度）
 * @param {number} maxLag 允许的最大滞后（弧度，非负）
 * @returns {number} 钳制后的角度
 */
export function clampLagAngle(cur, target, maxLag) {
  const lag = Math.atan2(Math.sin(cur - target), Math.cos(cur - target));
  if (Math.abs(lag) <= maxLag) return cur;
  return target + Math.sign(lag) * maxLag;
}


/**
 * 环形角度的「单帧位移上限」：从 prev 到 cur，单帧最多转 maxStep。
 *
 * 为什么需要：参考原话 —— 「2.7 rad/s 是 155°/s，车的偏航率只有打转时才会超过，
 * 而那正是它存在的理由：被撞飞的车每秒钟转二三百度，画面没有理由跟着复现。」
 * 平时它不生效，是一道兜底而不是一个机制。
 *
 * ★ 同样走最短弧。
 *
 * @param {number} prev 上一帧的角度（弧度）
 * @param {number} cur 这一帧想去的角度（弧度）
 * @param {number} maxStep 单帧允许的最大位移（弧度）
 * @returns {number} 钳制后的角度
 */
export function capStepAngle(prev, cur, maxStep) {
  const step = Math.atan2(Math.sin(cur - prev), Math.cos(cur - prev));
  if (Math.abs(step) <= maxStep) return cur;
  return prev + Math.sign(step) * maxStep;
}


/**
 * 臂长随速度增长 —— 加速时镜头往后拉，这是「速度感」的另一半。
 *
 * 用户实测原话：「开车时（加速/刹车）镜头没有随速度拉远拉近。」
 * 参考里臂长会随速度、加力、刹车、漂移一起动（`ARM_DIST_SPEED`），
 * 而且刻意做得很小 —— 因为臂长和视野是一对：拉长臂长会把主体缩小，
 * 视野张开负责「世界扑面而来」。两个一起动才有真实的速度感。
 *
 * @param {number} baseDist 静止时的臂长（米）
 * @param {number} perSpeed 满速时额外拉远多少（米）
 * @param {number} speed 当前车速（米/秒）
 * @param {number} maxSpeed 满速（米/秒）
 * @returns {number} 当前该用的臂长（米）
 */
export function armDistFor(baseDist, perSpeed, speed, maxSpeed = MAX_SPEED) {
  if (!(maxSpeed > 0)) return baseDist;
  const t = Math.min(1, Math.abs(speed) / maxSpeed);
  return baseDist + perSpeed * t;
}


// ===========================================================================
//  相机整条链路 —— 抽成纯函数，让 main.js 和测具【调同一份代码】
//
//  ★ 为什么抽出来（这是本轮最重要的结构改动）：
//  之前相机逻辑长在 main.js 的帧循环里，改一处只能在浏览器里靠感觉看，
//  于是每修一个现象就在别处冒一个新现象。参考项目把相机做成一个可离屏
//  驱动的类（Camera.ts），我们至少要做到「同一条链路能被测具反复跑」。
//  抽出来之后：main.js 调它、tools/camera-probe.mjs 也调它 —— 没有第二份实现。
// ===========================================================================

/** 不常调的结构常量（要调手感的部分在 feel.js） */
export const CAMERA_DEFAULTS = {
  yawTau: 0.16,        // 方位角弹簧时间常数（秒）
  maxLagDeg: 26,       // 方位角最多落后车头多少度（参考 MAX_LAG）
  maxArmRate: 4.5,     // 方位角摆动速率上限（rad/s）—— 见下面注释，必须高于我们的峰值
  cornerTau: 0.15,     // 过弯估计的平滑（参考 CORNER_TAU）
  frameAngRate: 0.85,  // 构图角变化率上限（rad/s，参考 FRAME_ANG_RATE）
  frameY: -0.19,       // 车压在画面下半（参考 FRAME_Y）
  frameYSpeed: -0.05,
  frameYMin: -0.32,
  frameYMax: -0.08,
  fovBase: 60,         // 静止视野（度）
};

/**
 * 走一帧相机。纯函数：不碰 DOM、不碰 THREE、不改传入的对象。
 *
 * ★ maxArmRate 为什么是 4.5 而不是参考的 2.0（血泪教训）：
 *   参考的 2.0 rad/s = 115°/s 是给它自己那台车当**兜底**的 ——
 *   它的车满舵中位偏航率只有 52°/s，所以那条上限"平时从不生效"。
 *   我们的车满舵在 7~9 m/s 时是 **172~183°/s**，于是 2.0 变成了每帧都生效的
 *   机制，还会和 26° 滞后上限每帧互相打架 → 画面摆动在 115~183°/s 之间抽动。
 *   我们的峰值偏航率是 3.61 rad/s（≈207°/s，见 yawRateFor），所以兜底取 4.5。
 *   **抄数值必须校尺度** —— 这条写在这里，别再犯。
 *
 * @param {{camYaw:number, compAng:number, lead:number, prevCamYaw:number}} cam 相机状态（本函数不改它）
 * @param {object} ctx {yaw, speed, maxSpeed, dt, aspect, baseDist, angleDeg, feel, tuning?}
 * @returns {object} 新状态 + 本帧读数（摆动/滞后/视野/臂长/构图/屏幕位置）
 */
export function stepCamera(cam, ctx) {
  const { yaw, speed, maxSpeed, dt, aspect, baseDist, angleDeg, feel } = ctx;
  const t = { ...CAMERA_DEFAULTS, ...(ctx.tuning || {}) };
  const DEG = Math.PI / 180;
  const sp = maxSpeed > 0 ? Math.min(1, Math.abs(speed) / maxSpeed) : 0;

  // ① 方位角弹簧式追车头 —— 唯一该有滞后的地方
  let camYaw = dampAngle(cam.camYaw, yaw, t.yawTau, dt);
  // ② 舒适边界一：滞后不超过 maxLagDeg（否则看不到前方）
  camYaw = clampLagAngle(camYaw, yaw, t.maxLagDeg * DEG);
  // ③ 舒适边界二：单帧摆动不超过 maxArmRate×dt（兜底，正常驾驶不该生效）
  camYaw = capStepAngle(cam.prevCamYaw, camYaw, t.maxArmRate * dt);

  const swing = angularRateDegPerSec(cam.prevCamYaw, camYaw, dt);
  const lag = Math.atan2(Math.sin(camYaw - yaw), Math.cos(camYaw - yaw));

  // ④ 视野随速度张开 + 臂长随速度变化（负 = 收近；见 feel.js 的理由）
  const fov = fovForSpeed(t.fovBase, feel.fovSpeed, speed, maxSpeed);
  const armDist = armDistFor(baseDist, feel.armDistSpeed, speed, maxSpeed);

  // ⑤ 构图：死区挡掉小修正 → 平滑 → 变化率上限
  //    ★ frameAngRate / cornerTau 从 feel 读（可在控制台现场调）：
  //      它们直接决定"横向偏移有多快"，是用户实测报告的头晕来源。
  const angRate = feel.frameAngRate ?? t.frameAngRate;
  const cornerTau = feel.cornerTau ?? t.cornerTau;
  const leadTarget = leadWeight(Math.abs(lag),
    feel.leadDeadDeg * DEG, feel.leadFullDeg * DEG);
  const lead = damp(cam.lead, leadTarget, cornerTau, dt);
  const wantComp = -feel.frameLagCancel * lag * lead;
  const compAng = cam.compAng + Math.max(-angRate * dt,
    Math.min(angRate * dt, wantComp - cam.compAng));

  // ⑥ 屏幕位置（构图解算的输入）
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * aspect;
  const frameX = Math.max(-feel.frameXMax, Math.min(feel.frameXMax, ndcFromAngle(compAng, tanH)));
  const frameY = Math.max(t.frameYMin, Math.min(t.frameYMax, t.frameY + t.frameYSpeed * sp));

  return {
    camYaw, compAng, lead, prevCamYaw: camYaw,
    swing, lag, fov, armDist, frameX, frameY, tanV, tanH, sp,
  };
}
