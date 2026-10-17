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

// ---------------------------------------------------------------------------
//  「急转加成」——手机拧得越快，额外多给一点转向
//
//  为什么需要（用户原话）：
//    「我手机转的快就是急转弯，我手机转的缓慢就是慢慢转弯」
//
//  ★ 为什么不能只用角速度：
//    角速度是"转速表"，**松手就归零**。一个弯要持续好几秒，玩家不可能连拧三秒手机，
//    所以纯角速度会导致"想保持转弯就必须一直拧" —— 没法开。
//    正确做法：**绝对倾角当主力（可保持）**，角速度只做**短暂的加成**。
// ---------------------------------------------------------------------------

/** 每秒拧多少度算"满额"加成（再快也是满额，避免甩一下就爆表） */
export const RATE_FULL_DPS = 180;

/**
 * 角速度带来的"急转加成"。
 * @param {number} rateDps 拧的角速度（度/秒，带正负号）
 * @param {number} gain 加成倍数（0 = 完全不用角速度，就是他面板上调的那个）
 * @returns {number} 加成量（-gain .. +gain）
 */
export function steerBoost(rateDps, gain) {
  if (!Number.isFinite(rateDps) || !Number.isFinite(gain) || gain === 0) return 0;
  const t = Math.max(-1, Math.min(1, rateDps / RATE_FULL_DPS));
  return t * gain;
}

/** 主转向 + 急转加成，最后钳在 [-1,1]（超范围会让前轮打死） */
export function combineSteer(tiltSteer, rateDps, gain) {
  const base = Number.isFinite(tiltSteer) ? tiltSteer : 0;
  const sum = base + steerBoost(rateDps, gain);
  return Math.max(-1, Math.min(1, sum));
}

// ---------------------------------------------------------------------------
//  方向自测 —— 「哪一侧倾对应哪一侧转」是**设备事实**，推不出来，只能测一次。
//
//  用户实测原话：「我的手机往右倾斜，小车的轮子是往左歪的。」
//  哪边倾该往哪边转，取决于：握持方向（横屏往左转还是往右转）
//  × 浏览器对屏幕方向的报告 × 投影公式的符号。这三者相乘之后，
//  在纸面上推是推不准的 —— 所以做成"往右倾 1 秒、自动定符号"。
//
//  约定：**右倾应当给出负数**（我们的 turn 负 = 右转）。
// ---------------------------------------------------------------------------

/** 判定方向所需的最小倾角（度）：比死区大不少，手抖误判不了 */
export const TILT_INVERT_THRESHOLD_DEG = 5;

/**
 * 由「向右倾时相对中位的读数」推断是否需要反向。
 * @param {number} rightTiltDeg 向右倾时的读数（相对校准中位，度）
 * @param {number} [threshold] 小于它就不判定
 * @returns {boolean|null} true=需要反向；false=不用；null=倾得太小或无读数（不猜）
 */
export function inferInvert(rightTiltDeg, threshold = TILT_INVERT_THRESHOLD_DEG) {
  if (!Number.isFinite(rightTiltDeg)) return null;
  if (Math.abs(rightTiltDeg) < threshold) return null;
  return rightTiltDeg > 0;
}
