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
