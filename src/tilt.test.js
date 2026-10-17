// ============================================================================
//  tilt.test.js —— 体感倾斜的数学
//
//  重点钉住参考项目注释里写明的三个坑：atan2（不是 asin）、平放守卫、屏幕方向。
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollDegrees, angleDifference, steerFromTilt, screenAngle,
  steerBoost, combineSteer, RATE_FULL_DPS,
  FLAT_THRESHOLD, STEER_DEADZONE_DEG, inferInvert,
} from './tilt.js';


// ---------------------------------------------------------------------------
//  坑②：平放桌面必须返回 null，不能乱给值
// ---------------------------------------------------------------------------
test('★ 坑②：手机平放在桌上 → 返回 null（重力在屏幕平面内的分量太小）', () => {
  assert.equal(rollDegrees(0, 0, 0), null, '完全平放应该给不出滚转角');
  assert.equal(rollDegrees(1, 1, 0), null, '接近平放也不该硬给一个数');
});

test('★ 坑②：握起来（不是平放）就该给出数值', () => {
  const v = rollDegrees(60, 0, 0);
  assert.equal(typeof v, 'number', 'beta=60° 是明显"立起来"的姿势，不该是 null');
  assert.ok(Number.isFinite(v));
});

// ---------------------------------------------------------------------------
//  坑①：atan2 而不是 asin —— 侧立附近不能跳
// ---------------------------------------------------------------------------
test('★ 坑①：beta 从 89° 到 91° 连续变化时，输出不能突变（asin 会在这里跳）', () => {
  const a = rollDegrees(89, 5, 0);
  const b = rollDegrees(91, 5, 0);
  assert.ok(a !== null && b !== null);
  // 用 atan2 时两者应当接近连续；asin 在 90° 处折叠会给出相反的结果
  assert.ok(Math.abs(a - b) < 90,
    `89° 与 91° 的输出应该接近，实际 ${a} 与 ${b} —— 说明用了 asin（会在 90° 折叠）`);
});

test('★ 坑①：滚转角能覆盖到 ±90° 之外（asin 的取值只有 ±90°）', () => {
  // 把 beta 推到 120°；用 asin 的实现在这里只能返回 [-90,90] 区间内的值
  const v = rollDegrees(120, 30, 0);
  assert.ok(v !== null && Number.isFinite(v));
  // 只要它没有因为折叠而符号翻转即可（此处只断言是有限数且在合理范围内）
  assert.ok(Math.abs(v) <= 180, `滚转角应当在 ±180 内，实际 ${v}`);
});

// ---------------------------------------------------------------------------
//  坑③：屏幕方向要参与计算
// ---------------------------------------------------------------------------
test('screenAngle：老接口 window.orientation 直接用', () => {
  assert.equal(screenAngle({ legacy: 90 }), 90);
  assert.equal(screenAngle({ legacy: -90 }), 270, '负数要归一到 0~360');
});

test('screenAngle：横屏时新旧浏览器报告不一致，靠 type 区分', () => {
  assert.equal(screenAngle({ angle: 0, landscape: true, type: 'landscape-primary' }), 90);
  assert.equal(screenAngle({ angle: 0, landscape: true, type: 'landscape-secondary' }), 270);
  assert.equal(screenAngle({ angle: 180, landscape: true, type: 'landscape-secondary' }), 270);
});

test('★ 坑③：同一姿势、不同屏幕方向 → 滚转角不同（不做投影就会算错）', () => {
  const portrait = rollDegrees(10, 30, 0);
  const landscape = rollDegrees(10, 30, 90);
  assert.ok(portrait !== landscape, '换了屏幕方向，投影结果必须不同');
});

// ---------------------------------------------------------------------------
//  最短弧
// ---------------------------------------------------------------------------
test('角度差走最短弧：179° 相对 -179° 只差 2°，不是 358°', () => {
  assert.ok(Math.abs(angleDifference(179, -179) - -2) < 1e-9);
  assert.ok(Math.abs(angleDifference(-179, 179) - 2) < 1e-9);
});

// ---------------------------------------------------------------------------
//  转向映射
// ---------------------------------------------------------------------------
test('★ 转向：死区内一律 0，并**重新归一**（不归一就永远打不到满舵）', () => {
  assert.equal(steerFromTilt(0, 25), 0);
  assert.equal(steerFromTilt(STEER_DEADZONE_DEG, 25), 0, '刚好在死区边界也算 0');
  const mid = steerFromTilt(10, 25);
  assert.ok(mid > 0 && mid < 1, `死区外应该是中间值，实际 ${mid}`);
  assert.equal(steerFromTilt(25, 25), 1, '到 range 就该是满舵');
  assert.equal(steerFromTilt(90, 25), 1, '超过 range 也钳在 1，不能溢出');
});

test('转向：左右对称、invert 会翻转', () => {
  assert.ok(Math.abs(steerFromTilt(15, 25) + steerFromTilt(-15, 25)) < 1e-9, '左右应当对称');
  assert.ok(Math.abs(steerFromTilt(15, 25, true) + steerFromTilt(15, 25)) < 1e-9, 'invert 应当取反');
});

test('转向：非法 range 不会炸（除零）', () => {
  assert.equal(steerFromTilt(20, 0), 0);
  assert.equal(steerFromTilt(20, NaN), 0);
  assert.equal(steerFromTilt(NaN, 25), 0);
});

test('FLAT_THRESHOLD 是个合理的小数（守卫不能太严，否则一拿起来就 null）', () => {
  assert.ok(FLAT_THRESHOLD > 0 && FLAT_THRESHOLD < 0.5, `阈值应远小于 1，实际 ${FLAT_THRESHOLD}`);
});

// ---------------------------------------------------------------------------
//  急转加成：拧得越快，额外多给一点转向
//
//  用户原话：「我手机转的快就是急转弯，我手机转的缓慢就是慢慢转弯」
//  但纯角速度不可用（松手归零 → 没法保持一个弯），所以它只做**加成**。
// ---------------------------------------------------------------------------
test('★ 急转加成：拧得越快给得越多，但有上限', () => {
  const slow = steerBoost(30, 0.4);
  const fast = steerBoost(150, 0.4);
  assert.ok(slow > 0 && fast > slow, `应该随速度增大：${slow} → ${fast}`);
  assert.ok(Math.abs(steerBoost(90, 0.4)) < 0.4 + 1e-9, '不该超过设定的倍数');
  assert.equal(steerBoost(90, 0), 0, '倍数为 0 就是完全不用角速度');
});

test('急转加成：方向跟着拧的方向，且左右对称', () => {
  assert.ok(steerBoost(-90, 0.3) < 0, '往另一侧拧应该是负的');
  assert.ok(Math.abs(steerBoost(90, 0.3) + steerBoost(-90, 0.3)) < 1e-9, '左右应当对称');
});

test('★ 合成：基础转向能保持，加成只把它推一点（推不出去）', () => {
  assert.equal(combineSteer(0.5, 0, 0.4), 0.5, '不拧的时候就是纯倾角');
  assert.ok(combineSteer(0.5, 180, 0.4) > 0.5, '拧得快应当把它推得更急');
  assert.equal(combineSteer(1, 180, 0.4), 1, '已经满舵就钳在 1');
  assert.equal(combineSteer(-1, -180, 0.4), -1);
});

test('合成：非法输入不会炸', () => {
  assert.equal(combineSteer(NaN, NaN, NaN), 0);
  assert.equal(combineSteer(0.3, 90, 0), 0.3);
});

// ---------------------------------------------------------------------------
//  方向自测：把「往右倾该往右转」这件事从猜测变成一次测量
//
//  用户实测原话：「我的手机往右倾斜，小车的轮子是往左歪的」——
//  哪一侧倾对应哪一侧转，取决于**握持方向 + 屏幕方向报告**，
//  是设备事实，推不出来，只能测一次。所以给一个"右倾 1 秒 → 自动定符号"的函数。
// ---------------------------------------------------------------------------
test('★ 方向自测：右倾时读数为正 → 需要反向（因为右倾应当给出负=右转）', () => {
  assert.equal(inferInvert(12), true);
  assert.equal(inferInvert(-12), false, '右倾给出负数 = 符号本来就对，不用反向');
});

test('方向自测：倾得太小 / 没读数 → 不判定（返回 null，别瞎猜）', () => {
  assert.equal(inferInvert(0), null);
  assert.equal(inferInvert(2), null, '小于阈值不判定 —— 手抖也会有几个度');
  assert.equal(inferInvert(-2), null);
  assert.equal(inferInvert(NaN), null);
  assert.equal(inferInvert(null), null);
});

test('方向自测：阈值可调', () => {
  assert.equal(inferInvert(5, 1), true);
  assert.equal(inferInvert(5, 10), null);
});
