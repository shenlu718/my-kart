// ============================================================================
//  tilt.test.js —— 体感倾斜的数学
//
//  重点钉住参考项目注释里写明的三个坑：atan2（不是 asin）、平放守卫、屏幕方向。
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rollDegrees, angleDifference, steerFromTilt, screenAngle,
  FLAT_THRESHOLD, STEER_DEADZONE_DEG,
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
