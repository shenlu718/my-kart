// ============================================================================
//  kart-math.js —— 车的运动计算
//
//  为什么单独放一个文件？
//  因为它不碰浏览器、不碰 3D 库，只做「输入数字 → 输出数字」。
//  这种代码能自动化测试；而「监听键盘」「画到屏幕上」不能。
//  把能测的部分和不能测的部分分开写，是写出好代码的第一步。
// ============================================================================


/** 转向速度：每秒转多少弧度（2.5 ≈ 143°/秒，街机赛车那种利落手感） */
export const TURN_SPEED = 2.5;

/** 前进速度：每秒多少米 */
export const MOVE_SPEED = 4;


/**
 * 车的初始状态。
 * 坐标约定沿用 Three.js：yaw = 0 时车头朝 -Z 方向（默认的"前方"）。
 */
export function createKartState() {
  return { x: 0, z: 0, yaw: 0 };
}


/**
 * 走一步：根据「这一帧的输入」和「这一帧过了多少秒」，算出新状态。
 *
 * @param {{x:number, z:number, yaw:number}} state 当前状态（本函数不修改它）
 * @param {{forward:number, turn:number}} input
 *        forward：1 = 踩油门，0 = 不踩，-1 = 倒车
 *        turn：   1 = 左转，  -1 = 右转，  0 = 不转
 * @param {number} dt 距离上一帧过了多少秒
 * @returns {{x:number, z:number, yaw:number}} 全新的状态对象
 */
export function stepKart(state, input, dt) {
  // 先转方向。这一步必须排在前头，否则车会走出"先直行、再拐弯"的折线
  const yaw = state.yaw + input.turn * TURN_SPEED * dt;

  // 乘以 dt 是整段代码里最关键的一处：
  // 每秒走 MOVE_SPEED 米 × 这一帧占了几秒 = 这一帧该走多远。
  // 如果写成固定值（distance = 4），那么 60 帧的电脑会比 30 帧的电脑快一倍。
  const distance = input.forward * MOVE_SPEED * dt;

  // yaw = 0 朝 -Z 方向，用 -sin / -cos 把角度换算成实际的移动方向
  return {
    x: state.x - Math.sin(yaw) * distance,
    z: state.z - Math.cos(yaw) * distance,
    yaw,
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
