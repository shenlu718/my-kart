// ============================================================================
//  kart-math.test.js —— 先写「怎样才算对」，再写实现
//
//  为什么先写测试？
//  因为「对不对」这件事，如果现在不说清楚，等代码写完就说不清了——
//  人会不自觉地觉得"跑出来的结果就是对的"。
//
//  运行：npm test
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKartState, stepKart, camHeightOf, approachFactor, MOVE_SPEED, TURN_SPEED } from './kart-math.js';


// ---------------------------------------------------------------------------
//  测试 1：初始状态
// ---------------------------------------------------------------------------
test('初始状态：车在原点，朝向 -Z（Three.js 的默认前方）', () => {
  const s = createKartState();
  assert.equal(s.x, 0);
  assert.equal(s.z, 0);
  assert.equal(s.yaw, 0);
});


// ---------------------------------------------------------------------------
//  测试 2：直行
//  约定：yaw = 0 时车头朝 -Z 方向，所以前进意味着 z 变小
// ---------------------------------------------------------------------------
test('踩油门 1 秒：朝 -Z 方向前进 MOVE_SPEED 米', () => {
  const s = stepKart(createKartState(), { forward: 1, turn: 0 }, 1);
  assert.equal(s.x, 0, '直行时不该左右移动');
  assert.equal(s.z, -MOVE_SPEED, '应该朝 -Z 前进');
});


// ---------------------------------------------------------------------------
//  测试 2b：倒车
//
//  用户实测报告：「按住下箭头没有反应」。
//  查下来：底层 stepKart 本来就支持负的 forward，是 main.js 的键盘映射
//  漏了 ↓ / S —— 典型的「能力有了、界面没接上」。
//  这条测试钉住底层行为：以后谁改坏倒车，它会红。
// ---------------------------------------------------------------------------
test('倒车（forward = -1）：朝 +Z 方向后退', () => {
  const s = stepKart(createKartState(), { forward: -1, turn: 0 }, 1);
  assert.equal(s.x, 0, '倒车时不该左右移动');
  assert.equal(s.z, MOVE_SPEED, '应该朝车头的反方向后退');
});


// ---------------------------------------------------------------------------
//  测试 3 + 4：转向
//  这两条是「左右不能反」的保险绳。
//  参考项目里就出过这个 bug：转向反了，但截图完全看不出来，骗过三轮审查。
// ---------------------------------------------------------------------------
test('左转（turn = +1）：朝向角增大', () => {
  const s = stepKart(createKartState(), { forward: 0, turn: 1 }, 1);
  assert.equal(s.yaw, TURN_SPEED);
});

test('右转（turn = -1）：朝向角减小', () => {
  const s = stepKart(createKartState(), { forward: 0, turn: -1 }, 1);
  assert.equal(s.yaw, -TURN_SPEED);
});


// ---------------------------------------------------------------------------
//  测试 5：不按键就不动
// ---------------------------------------------------------------------------
test('什么都不按：位置和朝向都不变', () => {
  const after = stepKart({ x: 3, z: 5, yaw: 1 }, { forward: 0, turn: 0 }, 0.5);
  assert.equal(after.x, 3);
  assert.equal(after.z, 5);
  assert.equal(after.yaw, 1);
});


// ---------------------------------------------------------------------------
//  测试 6：转完再走，走的是新方向
//  这条检查「朝向」和「移动」是联动的，而不是各算各的。
// ---------------------------------------------------------------------------
test('先转到 yaw = 90°，再前进 1 秒：应该朝 -X 方向移动', () => {
  const turned = { x: 0, z: 0, yaw: Math.PI / 2 };
  const s = stepKart(turned, { forward: 1, turn: 0 }, 1);
  assert.ok(Math.abs(s.x - -MOVE_SPEED) < 1e-9, `预期 x = ${-MOVE_SPEED}，实际 ${s.x}`);
  assert.ok(Math.abs(s.z) < 1e-9, `预期 z = 0，实际 ${s.z}`);
});


// ---------------------------------------------------------------------------
//  测试 7（最重要的一条）：帧率无关
//
//  同一秒的动作，不管电脑快慢、拆成多少帧，结果必须一样。
//  新手最常犯的错是写 `x += 0.1`（每帧加固定值）——那样 60 帧的电脑
//  会比 30 帧的电脑跑快一倍。正确做法是乘上 dt（这一帧过了多少秒）。
//
//  写这条测试时踩了两个坑，都记在这里，因为它们是真实存在的：
//
//  坑一：不能拿「1 帧」和「60 帧」比转弯路径。
//  「1 帧走 1 秒」的含义是"瞬间转到 2.5 弧度，再直走 4 米"，走的是直线；
//  而「60 帧」是边转边走，走的是圆弧。两者相差 4.1 米——这不是误差，
//  是两种不同的运动。所以转弯情形要拿 60 帧和 120 帧比（都是圆弧）。
//
//  坑二：直线也不能用严格相等。60 次加法累加必然带来浮点误差，
//  所以用 1e-9 这种「实际上就是相等」的容差。
// ---------------------------------------------------------------------------
test('帧率无关（直线）：1 秒拆成 60 帧，与一次走完 1 秒结果相同', () => {
  let stepwise = createKartState();
  for (let i = 0; i < 60; i++) {
    stepwise = stepKart(stepwise, { forward: 1, turn: 0 }, 1 / 60);
  }
  const oneShot = stepKart(createKartState(), { forward: 1, turn: 0 }, 1);

  // 直线行驶时 yaw 不变，两种拆分方式语义完全相同，只差浮点累加误差
  assert.ok(Math.abs(stepwise.x - oneShot.x) < 1e-9);
  assert.ok(Math.abs(stepwise.z - oneShot.z) < 1e-9);
});

test('帧率相容（边转边走）：60 帧与 120 帧走出几乎相同的圆弧', () => {
  const run = (frames) => {
    let s = createKartState();
    for (let i = 0; i < frames; i++) {
      s = stepKart(s, { forward: 1, turn: 1 }, 1 / frames);
    }
    return s;
  };

  const at60 = run(60);
  const at120 = run(120);

  // 朝向是线性累加的，与帧数无关
  assert.ok(Math.abs(at60.yaw - at120.yaw) < 1e-9,
    `yaw 不一致：${at60.yaw} vs ${at120.yaw}`);

  // 位置来自分段积分：帧数翻倍，误差减半。实测差距在 0.1 米以内
  const gap = Math.hypot(at60.x - at120.x, at60.z - at120.z);
  assert.ok(gap < 0.1, `60 帧与 120 帧的终点相差 ${gap.toFixed(3)} 米，超出容差`);
});


// ---------------------------------------------------------------------------
//  测试 8：纯函数
//  不该偷偷改掉传进来的对象——否则调用方手里的数据会被无声改掉，
//  这类 bug 极难排查。
// ---------------------------------------------------------------------------
test('不修改传入的状态对象（纯函数）', () => {
  const original = { x: 1, z: 2, yaw: 0.5 };
  const snapshot = { ...original };
  stepKart(original, { forward: 1, turn: 1 }, 1);
  assert.deepEqual(original, snapshot, '传入的对象被改动了');
});


// ---------------------------------------------------------------------------
//  测试 9：相机高度换算
//
//  这条测试专门防一个极容易犯的错：Math.tan 收的是**弧度**不是角度。
//  少写 * Math.PI / 180 的话，45° 会被当成 45 弧度算，
//  结果 tan(45) ≈ 1.62 —— 相机跑到天上去了，但代码"看着没问题"。
// ---------------------------------------------------------------------------
test('俯角 45°：相机高度应该正好等于水平距离（tan45° = 1）', () => {
  const h = camHeightOf({ distance: 10, angleDeg: 45 });
  assert.ok(Math.abs(h - 10) < 1e-9, `预期 10，实际 ${h}`);
});

test('俯角 0°：相机和车一样高', () => {
  const h = camHeightOf({ distance: 8, angleDeg: 0 });
  assert.ok(Math.abs(h) < 1e-9, `预期 0，实际 ${h}`);
});

test('俯角变大：相机更高；距离变大：相机同比例更高', () => {
  const low = camHeightOf({ distance: 6, angleDeg: 20 });
  const steep = camHeightOf({ distance: 6, angleDeg: 40 });
  assert.ok(steep > low, '俯角变大时相机应该更高');

  const near = camHeightOf({ distance: 5, angleDeg: 30 });
  const far = camHeightOf({ distance: 10, angleDeg: 30 });
  assert.ok(Math.abs(far - near * 2) < 1e-9, '距离翻倍时高度应该也翻倍（角度不变）');
});


// ---------------------------------------------------------------------------
//  测试 10：帧率无关的平滑逼近
//
//  相机平滑跟随靠它。这条测试钉住的是那个最容易犯的错：
//  写成「每帧固定靠近 10%」——那样 60fps 的机器追得比 30fps 快一倍。
//
//  判定方式：跑同样长的 1 秒，30 帧和 60 帧的剩余距离必须一致，
//  而且都精确等于 e^(-rate)（这是指数衰减的解析解）。
// ---------------------------------------------------------------------------
test('平滑逼近：30 帧和 60 帧跑完 1 秒，剩下的距离完全一样', () => {
  const rate = 7;

  let remainingAt60 = 1;
  for (let i = 0; i < 60; i++) remainingAt60 *= 1 - approachFactor(rate, 1 / 60);

  let remainingAt30 = 1;
  for (let i = 0; i < 30; i++) remainingAt30 *= 1 - approachFactor(rate, 1 / 30);

  assert.ok(Math.abs(remainingAt60 - remainingAt30) < 1e-9,
    `60帧剩 ${remainingAt60}，30帧剩 ${remainingAt30}，应该一致`);

  // 解析解：经过 t 秒后，剩余比例 = e^(-rate × t)
  assert.ok(Math.abs(remainingAt60 - Math.exp(-rate)) < 1e-9,
    `应该等于 e^(-7)，实际 ${remainingAt60}`);
});

test('平滑逼近：dt = 0 时纹丝不动，dt 很大时几乎贴到目标', () => {
  assert.equal(approachFactor(7, 0), 0, '没经过时间就不该移动');
  assert.ok(approachFactor(7, 10) > 0.99, '经过很久应该基本到位');
  assert.ok(approachFactor(7, 0.016) > 0 && approachFactor(7, 0.016) < 0.2,
    '一帧（16ms）的变化应该是很小的一步');
});
