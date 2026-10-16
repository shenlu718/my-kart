// ============================================================================
//  tilt.js —— 体感倾斜：把手机姿态换算成转向量（纯函数，可测）
//
//  公式照参考项目 chinese-can-fly-kart/phone/protocol.mjs（MIT）的做法重写；
//  它注释里写明的三个坑，我们一条都不少：
//
//   ① **必须用 atan2，不能用 asin。**
//      原注：「atan2 保留整个圆周；asin 在 90° 处折叠，欧拉角换分支时会跳。」
//      （asin 的取值只在 [-90°,90°]，手机转到侧立附近就会突然跳一下。）
//   ② **手机平放在桌上时返回 null。**
//      这时重力几乎垂直于屏幕，给不出稳定的"屏幕内滚转角"，
//      不守卫的话界面会疯狂乱跳。
//   ③ **屏幕方向要参与计算。** 横屏/竖屏的"左右"不是同一个方向，
//      必须把重力投影到**当前屏幕平面**再算；而且浏览器对
//      landscape-secondary 的报告方式不一致，要归一。
//
//  为什么放在这里而不是写在手机页里：手机页没有测试。这段是纯数学，
//  放在这一侧就能被 npm test 钉住（沿用 pad-input.js 那次教训）。
// ============================================================================

const DEG = Math.PI / 180;

/** 平放桌面时判定为"给不出稳定滚转角"的阈值（重力在屏幕平面内的分量太小） */
export const FLAT_THRESHOLD = 0.15;

/** 转向死区（度）：手机握得再稳也有零点几度的抖动，小于它一律当 0 */
export const STEER_DEADZONE_DEG = 2;

/**
 * 把浏览器的屏幕方向报告归一成 0 / 90 / 180 / 270。
 *
 * 各家浏览器给的不是同一个字段：老的用 `window.orientation`，
 * 新的用 `screen.orientation.angle` + `.type`。而且横屏时有些浏览器给 0、
 * 有些给 180，必须靠 `type`（landscape-primary / landscape-secondary）区分。
 *
 * @param {{legacy?:number, angle?:number, landscape?:boolean, type?:string}} info
 * @returns {number} 0 | 90 | 180 | 270
 */
export function screenAngle(info = {}) {
  const { legacy, angle, landscape, type } = info;
  let value = Number.isFinite(legacy) ? legacy : Number.isFinite(angle) ? angle : 0;
  value = ((value % 360) + 360) % 360;
  if (landscape && value % 180 === 0) {
    value = type === 'landscape-secondary' ? 270 : 90;
  }
  return value;
}

/**
 * 把设备姿态换算成「屏幕平面内的滚转角」（度）。正 = 往一侧倾，负 = 往另一侧。
 *
 * 做法：由 beta/gamma 求出重力方向，再按屏幕角度把它旋转投影到屏幕坐标系的
 * 「屏幕右」与「屏幕上」两个轴上，最后取 atan2。
 *
 * @param {number} beta  前后俯仰（度，-180..180）
 * @param {number} gamma 左右横滚（度，-90..90）
 * @param {number} screenAngleDeg 屏幕方向（度，来自 screenAngle()）
 * @returns {number|null} 滚转角（度）；手机接近平放时返回 null（见文件头注释②）
 */
export function rollDegrees(beta, gamma, screenAngleDeg = 0) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const b = beta * DEG;
  const g = gamma * DEG;
  const a = (Number.isFinite(screenAngleDeg) ? screenAngleDeg : 0) * DEG;

  const x = Math.cos(b) * Math.sin(g);   // 重力在设备"右"方向上的分量
  const up = Math.sin(b);                // 重力在设备"上"方向上的分量

  // 按屏幕方向旋转到屏幕坐标系
  const screenX = x * Math.cos(a) + up * Math.sin(a);
  const screenUp = up * Math.cos(a) - x * Math.sin(a);

  if (Math.hypot(screenX, screenUp) < FLAT_THRESHOLD) return null;  // ② 平放守卫
  return Math.atan2(screenX, screenUp) / DEG;                       // ① atan2 不是 asin
}

/**
 * 最短弧角度差（度）：angle 相对 zero 差多少，结果落在 -180..180。
 * 用来算"相对校准中位偏了多少"，跨 ±180 不会绕远路。
 */
export function angleDifference(angle, zero) {
  if (!Number.isFinite(angle) || !Number.isFinite(zero)) return 0;
  return ((angle - zero + 540) % 360) - 180;
}

/**
 * 滚转角 → 转向量 [-1, 1]。
 *
 * 死区后要**重新归一**：`(|deg| - 死区) / (range - 死区)`。
 * 不重新归一的话，因为死区吃掉了一段行程，你**永远打不到满舵**。
 * （参考项目里摇杆那段也用了同样的写法。）
 *
 * @param {number} deg 相对校准中位的滚转角（度）
 * @param {number} range 打到满舵需要多少度（玩家的"手感"旋钮，10~40 合理）
 * @param {boolean} [invert] 反一下方向（有人喜欢反着握）
 * @returns {number} -1..1
 */
export function steerFromTilt(deg, range, invert = false) {
  if (!Number.isFinite(deg) || !Number.isFinite(range) || range <= STEER_DEADZONE_DEG) return 0;
  const mag = Math.abs(deg);
  const v = mag <= STEER_DEADZONE_DEG
    ? 0
    : Math.sign(deg) * Math.min(1, (mag - STEER_DEADZONE_DEG) / (range - STEER_DEADZONE_DEG));
  return invert ? -v : v;
}
