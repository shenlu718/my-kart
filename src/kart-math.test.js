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
import {
  createKartState, stepKart, nextSpeed,
  camHeightOf, approachFactor, followRateFor, cameraSideOffset,
  MAX_SPEED, REVERSE_SPEED, ACCEL, TURN_SPEED,
} from './kart-math.js';


const atSpeed = (speed) => ({ x: 0, z: 0, yaw: 0, speed });


// ===========================================================================
//  一、车辆运动
// ===========================================================================

// ---------------------------------------------------------------------------
//  测试 1：初始状态
// ---------------------------------------------------------------------------
test('初始状态：停在原点，朝 -Z（Three.js 的默认前方），速度为 0', () => {
  const s = createKartState();
  assert.equal(s.x, 0);
  assert.equal(s.z, 0);
  assert.equal(s.yaw, 0);
  assert.equal(s.speed, 0);
});


// ---------------------------------------------------------------------------
//  测试 2：直行
//  约定：yaw = 0 时车头朝 -Z 方向，所以前进意味着 z 变小。
//
//  注意这里用「已经是满速」的状态来测位移 —— 因为加了速度物理之后，
//  「踩油门 1 秒」走多远取决于加速曲线，不再是「速度 × 时间」这么简单。
//  测位移就用满速，测加速过程另有专门的测试。
// ---------------------------------------------------------------------------
test('满速直行 1 秒：朝 -Z 方向前进 MAX_SPEED 米', () => {
  const s = stepKart(atSpeed(MAX_SPEED), { forward: 1, turn: 0 }, 1);
  assert.equal(s.x, 0, '直行时不该左右移动');
  assert.equal(s.z, -MAX_SPEED, '应该朝 -Z 前进');
});


// ---------------------------------------------------------------------------
//  测试 2b：倒车
//  用户实测报告：「按住下箭头没有反应」——底层本来就支持，是 main.js
//  的键盘映射漏了 ↓ / S。这条钉住底层行为。
// ---------------------------------------------------------------------------
test('倒车：朝 +Z 方向后退', () => {
  const s = stepKart(atSpeed(-5), { forward: -1, turn: 0 }, 0.5);
  assert.equal(s.x, 0, '倒车时不该左右移动');
  assert.ok(s.z > 0, `倒车应该朝 +Z（车头反方向），实际 z = ${s.z}`);
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
//  测试 5：不按键
// ---------------------------------------------------------------------------
test('什么都不按、且本来就没速度：位置和朝向都不变', () => {
  const after = stepKart({ x: 3, z: 5, yaw: 1, speed: 0 }, { forward: 0, turn: 0 }, 0.5);
  assert.equal(after.x, 3);
  assert.equal(after.z, 5);
  assert.equal(after.yaw, 1);
});


// ---------------------------------------------------------------------------
//  测试 6：转完再走，走的是新方向
// ---------------------------------------------------------------------------
test('先转到 yaw = 90°，再满速直行 1 秒：应该朝 -X 方向移动', () => {
  const turned = { x: 0, z: 0, yaw: Math.PI / 2, speed: MAX_SPEED };
  const s = stepKart(turned, { forward: 1, turn: 0 }, 1);
  assert.ok(Math.abs(s.x - -MAX_SPEED) < 1e-9, `预期 x = ${-MAX_SPEED}，实际 ${s.x}`);
  assert.ok(Math.abs(s.z) < 1e-9, `预期 z = 0，实际 ${s.z}`);
});


// ---------------------------------------------------------------------------
//  测试 7（最重要的一条）：帧率无关
//
//  同一秒的动作，不管电脑快慢、拆成多少帧，结果必须一样。
//  新手最常犯的错是写 `x += 0.1`（每帧加固定值）——那样 60 帧的电脑
//  会比 30 帧的电脑跑快一倍。
//
//  写这条测试时踩过两个坑，记在这里，因为它们是真实存在的：
//
//  坑一：不能拿「1 帧」和「60 帧」比转弯路径。
//  「1 帧走 1 秒」是"瞬间转完再直走"，走的是直线；「60 帧」是边转边走，
//  走的是圆弧。两者相差好几米——那不是误差，是两种不同的运动。
//
//  坑二：也不能拿「从静止起步」来比，因为加速过程是分段累加的。
//
//  所以：位移的帧率无关性，用「已经满速」的状态来测（速度恒定，位移线性）。
// ---------------------------------------------------------------------------
test('帧率无关（直线）：满速 1 秒拆成 60 帧，与一次走完 1 秒结果相同', () => {
  const start = atSpeed(MAX_SPEED);

  let stepwise = start;
  for (let i = 0; i < 60; i++) {
    stepwise = stepKart(stepwise, { forward: 1, turn: 0 }, 1 / 60);
  }
  const oneShot = stepKart(start, { forward: 1, turn: 0 }, 1);

  assert.ok(Math.abs(stepwise.z - oneShot.z) < 1e-9,
    `60 帧走了 ${stepwise.z}，1 帧走了 ${oneShot.z}，应该一致`);
});

test('帧率相容（边转边走）：60 帧与 120 帧走出的圆弧几乎重合', () => {
  const run = (frames) => {
    let s = atSpeed(MAX_SPEED);
    for (let i = 0; i < frames; i++) {
      s = stepKart(s, { forward: 1, turn: 1 }, 1 / frames);
    }
    return s;
  };

  const at60 = run(60);
  const at120 = run(120);

  assert.ok(Math.abs(at60.yaw - at120.yaw) < 1e-9,
    `yaw 不一致：${at60.yaw} vs ${at120.yaw}`);

  // 位置来自分段积分：帧数翻倍误差减半
  const gap = Math.hypot(at60.x - at120.x, at60.z - at120.z);
  assert.ok(gap < 0.2, `60 帧与 120 帧的终点相差 ${gap.toFixed(3)} 米，超出容差`);
});


// ---------------------------------------------------------------------------
//  测试 8：纯函数
// ---------------------------------------------------------------------------
test('不修改传入的状态对象（纯函数）', () => {
  const original = { x: 1, z: 2, yaw: 0.5, speed: 3 };
  const snapshot = { ...original };
  stepKart(original, { forward: 1, turn: 1 }, 1);
  assert.deepEqual(original, snapshot, '传入的对象被改动了');
});


// ===========================================================================
//  二、速度物理
//
//  用户实测反馈原话：
//  「赛车的速度不应该是固定的，他会有一个加速的过程然后到达峰值，
//    然后转弯的时候速度肯定是会衰减，不应该过弯的速度跟直行的速度一样快。」
// ===========================================================================

test('从静止踩油门：速度是慢慢涨上去的，不是一帧到顶', () => {
  const afterOneFrame = nextSpeed(0, { forward: 1, turn: 0 }, 1 / 60);
  assert.ok(afterOneFrame > 0, '应该开始加速');
  assert.ok(afterOneFrame < MAX_SPEED, '一帧之内不该直接到顶');

  // 加速应该是线性的：1 秒后大约涨到 ACCEL
  const afterOneSecond = nextSpeed(0, { forward: 1, turn: 0 }, 1);
  assert.ok(Math.abs(afterOneSecond - ACCEL) < 1e-9, `1 秒后应该到 ${ACCEL}，实际 ${afterOneSecond}`);
});

test('一直踩油门：涨到峰值就停住，不会无限增长', () => {
  let speed = 0;
  for (let i = 0; i < 600; i++) speed = nextSpeed(speed, { forward: 1, turn: 0 }, 1 / 60);
  assert.ok(Math.abs(speed - MAX_SPEED) < 1e-9, `应该稳定在 ${MAX_SPEED}，实际 ${speed}`);
});

test('松油门：自然减速，最终停下且不会变成负数', () => {
  let speed = MAX_SPEED;
  for (let i = 0; i < 600; i++) speed = nextSpeed(speed, { forward: 0, turn: 0 }, 1 / 60);
  assert.equal(speed, 0, '应该完全停下');
});

test('刹车：减速比松油门更快，且能进入倒车', () => {
  const coasting = nextSpeed(8, { forward: 0, turn: 0 }, 0.5);
  const braking = nextSpeed(8, { forward: -1, turn: 0 }, 0.5);
  assert.ok(braking < coasting, '踩刹车的减速应该明显快于自然滑行');

  // 一直按住后退，速度会变成负数（倒车），但有下限
  let speed = 0;
  for (let i = 0; i < 600; i++) speed = nextSpeed(speed, { forward: -1, turn: 0 }, 1 / 60);
  assert.ok(Math.abs(speed - -REVERSE_SPEED) < 1e-9, `倒车峰值应该是 ${-REVERSE_SPEED}，实际 ${speed}`);
});

test('转弯时速度掉得比直行快（过弯要收油）', () => {
  // 两边都不给油。如果一边给油、一边不给，加速的影响会混进来，
  // 测到的就不是纯粹的转弯损耗了。
  const straight = nextSpeed(MAX_SPEED, { forward: 0, turn: 0 }, 0.5);
  const turning = nextSpeed(MAX_SPEED, { forward: 0, turn: 1 }, 0.5);
  assert.ok(turning < straight,
    `同样 0.5 秒，过弯应该比直行慢：直行 ${straight}，过弯 ${turning}`);
});

test('转弯的速度损失随速度变大：开得越快，过弯掉得越多', () => {
  const lossAt = (v) => v - nextSpeed(v, { forward: 0, turn: 1 }, 0.1);
  assert.ok(lossAt(MAX_SPEED) > lossAt(3),
    `高速过弯的损失应该更大：${lossAt(MAX_SPEED)} vs ${lossAt(3)}`);
});

test('停在原地打方向：速度不会被扣成负数', () => {
  const s = nextSpeed(0, { forward: 0, turn: 1 }, 1);
  assert.equal(s, 0, '没速度的时候转弯不该把它变成负数');
});


// ===========================================================================
//  三、相机数学
// ===========================================================================

// ---------------------------------------------------------------------------
//  测试 9：相机高度换算
//  专门防一个极容易犯的错：Math.tan 收的是**弧度**不是角度。
//  少写 * Math.PI / 180 的话，45° 会被当成 45 弧度算，结果 tan(45) ≈ 1.62，
//  相机跑到天上去了，但代码"看着没问题"。
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
//  测试 10：帧率无关的平滑逼近（相机跟随用）
//  判定方式：跑同样长的 1 秒，30 帧和 60 帧的剩余距离必须一致，
//  而且都精确等于 e^(-rate)。
// ---------------------------------------------------------------------------
test('平滑逼近：30 帧和 60 帧跑完 1 秒，剩下的距离完全一样', () => {
  const rate = 7;

  let remainingAt60 = 1;
  for (let i = 0; i < 60; i++) remainingAt60 *= 1 - approachFactor(rate, 1 / 60);

  let remainingAt30 = 1;
  for (let i = 0; i < 30; i++) remainingAt30 *= 1 - approachFactor(rate, 1 / 30);

  assert.ok(Math.abs(remainingAt60 - remainingAt30) < 1e-9,
    `60帧剩 ${remainingAt60}，30帧剩 ${remainingAt30}，应该一致`);

  assert.ok(Math.abs(remainingAt60 - Math.exp(-rate)) < 1e-9,
    `应该等于 e^(-7)，实际 ${remainingAt60}`);
});

test('平滑逼近：dt = 0 时纹丝不动，dt 很大时几乎贴到目标', () => {
  assert.equal(approachFactor(7, 0), 0, '没经过时间就不该移动');
  assert.ok(approachFactor(7, 10) > 0.99, '经过很久应该基本到位');
  assert.ok(approachFactor(7, 0.016) > 0 && approachFactor(7, 0.016) < 0.2,
    '一帧（16ms）的变化应该是很小的一步');
});


// ---------------------------------------------------------------------------
//  测试 11：跟随系数随速度自适应
//
//  用户实测发现：「峰值速度变得很大时，相机会拉远，车突然变得很小」。
//  根因是滞后量 ≈ 速度 ÷ 跟随系数，系数固定时速度越快落后越多。
//  这条钉住「速度越快、跟得越紧」这个性质。
// ---------------------------------------------------------------------------
test('跟随系数随速度变大：速度越快，相机跟得越紧', () => {
  const atRest = followRateFor(0, 7, 1.5);
  const cruising = followRateFor(8, 7, 1.5);
  const flying = followRateFor(24, 7, 1.5);

  assert.equal(atRest, 7, '静止时就用基准系数');
  assert.ok(cruising > atRest, '速度上去后应该跟得更紧');
  assert.ok(flying > cruising, '速度越快跟得越紧');

  // 关键性质：滞后量（速度 ÷ 系数）不再随速度线性增长，
  // 而是收敛到一个上限。数学上：速度/(base+gain×速度) 在速度很大时趋近 1/gain。
  // 这也正是不让"速度一快、车就变小"的关键。
  const ceiling = 1 / 1.5;   // ≈ 0.67 米
  assert.ok(8 / cruising < ceiling + 1e-9, `8m/s 的滞后该在 ${ceiling.toFixed(2)}m 以内`);
  assert.ok(24 / flying < ceiling + 1e-9, `24m/s 的滞后该在 ${ceiling.toFixed(2)}m 以内`);
});


// ---------------------------------------------------------------------------
//  测试 12：过弯时的镜头偏移方向
//  这类"左右"最容易搞反，而且搞反了在画面上不一定看得出来（车还是在动）。
// ---------------------------------------------------------------------------
test('过弯镜头往弯道外侧偏：左转往左偏，右转往右偏，直行不偏', () => {
  const amount = 2;

  const straight = cameraSideOffset(0, 0, amount);
  // 用 === 而不是 assert.equal：后者背后是 Object.is，
  // 而 Object.is(-0, 0) 是 false —— JS 的这个怪癖会让"直行不偏移"误报失败。
  assert.ok(straight.x === 0, `直行不该偏移，实际 ${straight.x}`);
  assert.ok(straight.z === 0, `直行不该偏移，实际 ${straight.z}`);

  // yaw = 0 时车头朝 -Z，车的右方是 +X
  const left = cameraSideOffset(1, 0, amount);    // 左转
  assert.ok(left.x < 0, `左转时相机该往 -X（左侧）偏，实际 ${left.x}`);

  const right = cameraSideOffset(-1, 0, amount);  // 右转
  assert.ok(right.x > 0, `右转时相机该往 +X（右侧）偏，实际 ${right.x}`);
});

test('镜头偏移跟着车头转向：车头转 90° 后，偏移方向也跟着转', () => {
  const amount = 2;

  // yaw = 90°：车头朝 -X，此时车的右方是 -Z
  const right = cameraSideOffset(-1, Math.PI / 2, amount);

  assert.ok(Math.abs(right.x) < 1e-9, `x 应该接近 0，实际 ${right.x}`);
  assert.ok(right.z < 0, `应该往 -Z 偏，实际 ${right.z}`);
});
