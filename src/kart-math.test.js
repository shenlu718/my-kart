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
  camHeightOf, approachFactor, followRateFor, cameraSideOffset, damp, dampAngle,
  angularRateDegPerSec, screenFraction, snapToTile,
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


// ---------------------------------------------------------------------------
//  测试 13：指数逼近（修「车忽大忽小」那个 bug 的基础工具）
//
//  用户实测：「反复按 A/D，车子变得一大一小、突变」。
//  根因是按键的瞬时值（0/1 之间跳）被直接接给了相机参数。
//  这条钉住平滑工具本身：帧率无关、且收敛到解析解。
// ---------------------------------------------------------------------------
test('指数逼近：30 帧与 60 帧跑完 1 秒，结果完全相同', () => {
  const tau = 0.2;

  let at60 = 0;
  for (let i = 0; i < 60; i++) at60 = damp(at60, 1, tau, 1 / 60);

  let at30 = 0;
  for (let i = 0; i < 30; i++) at30 = damp(at30, 1, tau, 1 / 30);

  assert.ok(Math.abs(at60 - at30) < 1e-9, `60帧到 ${at60}，30帧到 ${at30}，应该一致`);

  // 解析解：1 - e^(-t/tau)
  assert.ok(Math.abs(at60 - (1 - Math.exp(-1 / tau))) < 1e-9,
    `应该等于 1-e^(-5)，实际 ${at60}`);
});

test('指数逼近：tau 越小追得越快；dt = 0 时不动', () => {
  const fast = damp(0, 1, 0.05, 0.1);
  const slow = damp(0, 1, 0.5, 0.1);
  assert.ok(fast > slow, `时间常数小的应该追得更快：${fast} vs ${slow}`);
  assert.equal(damp(0, 1, 0.2, 0), 0, '没经过时间就不该动');
});


// ---------------------------------------------------------------------------
//  测试 14：角度平滑必须走短边（环形角度的经典陷阱）
//
//  179° → -179° 实际只差 2°，可是直接相减得到 -358°。
//  如果用普通 damp，镜头会绕一大圈甩过去。这条钉住最短弧。
// ---------------------------------------------------------------------------
test('角度平滑走最短的一边：179° 到 -179° 只跨过 ±180 那条线', () => {
  const from = (179 * Math.PI) / 180;
  const to = (-179 * Math.PI) / 180;

  const next = dampAngle(from, to, 1, 0.1);
  const moved = Math.atan2(Math.sin(next - from), Math.cos(next - from));

  assert.ok(moved > 0, `应该跨过 ±180 往正方向走，实际移动了 ${moved}`);
  assert.ok(Math.abs(moved) < 0.02, `只该走一小步，实际 ${moved}`);
});

test('反例：朴素线性插值确实会走反方向（这就是必须避开它的原因）', () => {
  const from = (179 * Math.PI) / 180;
  const to = (-179 * Math.PI) / 180;

  const naiveHalfway = from + (to - from) * 0.5;
  assert.ok(naiveHalfway < from, '朴素插值往反方向走到了 0° 附近');

  // 而最短弧版本是瞬间到位时，位移方向为正（跨过 ±180）
  const snapped = dampAngle(from, to, 1e-6, 1);
  const moved = Math.atan2(Math.sin(snapped - from), Math.cos(snapped - from));
  assert.ok(moved > 0, `最短弧应该往正方向走，实际 ${moved}`);
});


// ===========================================================================
//  四、实时指标（轻量测具）
//
//  用户最痛的一点：「速度的衰减、镜头的偏移、过弯的漂移……我感觉我一个人
//  优化手感非常麻烦。」根因不是参数多，而是**没有反馈线**——调参变成了
//  随机游走。参考项目的作者不是靠反复试参做出手感的，他有 camera-probe
//  告诉他「摆动多少度/秒」「车占屏多少」。
//
//  这一节把两个指标算法钉死。它们都是纯函数，所以在屏幕上看不到之前，
//  至少能先在测试里确认逻辑是对的。
// ===========================================================================

// ---------------------------------------------------------------------------
//  指标 1：相机摆动速率（度/秒）—— "晕不晕"的客观量
//
//  ★ 和 dampAngle 是同一个坑：环形角度必须走最短弧。
//    179° → -179° 实际只转了 2°，直接相减却得到 -358°，
//    会把摆动值虚报一百多倍。下面专门有一条测试钉住它。
// ---------------------------------------------------------------------------
test('摆动速率：不动就是 0', () => {
  assert.equal(angularRateDegPerSec(1.2, 1.2, 0.016), 0);
});

test('摆动速率：0.5 秒转过 90°，就是 180 度/秒', () => {
  const rate = angularRateDegPerSec(0, Math.PI / 2, 0.5);
  assert.ok(Math.abs(rate - 180) < 1e-9, `预期 180，实际 ${rate}`);
});

test('摆动速率：跨过 ±180 只算最短的那一小步（否则虚报上百倍）', () => {
  const from = (179 * Math.PI) / 180;
  const to = (-179 * Math.PI) / 180;
  const rate = angularRateDegPerSec(from, to, 0.1);
  // 实际只转了 2°，0.1 秒 → 20 度/秒
  assert.ok(Math.abs(rate - 20) < 1e-9, `预期 20，实际 ${rate}`);
});

test('摆动速率：往哪个方向转都是正值（速率不带方向）', () => {
  const up = angularRateDegPerSec(0, 0.5, 0.1);
  const down = angularRateDegPerSec(0, -0.5, 0.1);
  assert.ok(up > 0 && Math.abs(up - down) < 1e-9, `正反方向速率应该相等：${up} vs ${down}`);
});

test('摆动速率：dt 不是正数时返回 0（不能是 NaN 或 Infinity）', () => {
  assert.equal(angularRateDegPerSec(0, 1, 0), 0);
  assert.equal(angularRateDegPerSec(0, 1, -1), 0);
});


// ---------------------------------------------------------------------------
//  指标 2：车占屏比例
//
//  用户实测报过「峰值速度一大，车突然变得很小」。车到底小了多少，
//  肉眼说不准，但这个比例能直接对比 —— 而它**应该随速度基本不变**。
// ---------------------------------------------------------------------------
test('占屏比例：距离翻倍，占比减半', () => {
  const near = screenFraction(1, 10, 60);
  const far = screenFraction(1, 20, 60);
  assert.ok(Math.abs(far - near / 2) < 1e-9, `预期 ${near / 2}，实际 ${far}`);
});

test('占屏比例：物体恰好和可见高度一样高时，占满整屏（= 1）', () => {
  const fov = 60;
  const d = 10;
  const visible = 2 * d * Math.tan((fov * Math.PI) / 360);
  const f = screenFraction(visible, d, fov);
  assert.ok(Math.abs(f - 1) < 1e-9, `预期 1，实际 ${f}`);
});

test('占屏比例：视野越大，物体占屏越小', () => {
  const narrow = screenFraction(1, 10, 40);
  const wide = screenFraction(1, 10, 80);
  assert.ok(wide < narrow, `视野大的应该占屏更小：${wide} vs ${narrow}`);
});

test('占屏比例：距离为 0 时返回 0（不能除以 0 变成 Infinity）', () => {
  assert.equal(screenFraction(1, 0, 60), 0);
  assert.equal(screenFraction(1, -3, 60), 0);
});

test('占屏比例：我们项目的实际数值（车高 0.9 米、距 7 米、视野 60°）约 11%', () => {
  const f = screenFraction(0.9, 7, 60);
  assert.ok(Math.abs(f - 0.1113) < 0.002, `预期约 0.111，实际 ${f}`);
});


// ===========================================================================
//  五、整格吸附（修「开远了地面消失」的基础工具）
//
//  用户实测：「行驶很长一段距离之后，地上的网格消失了，只有柱子出现。」
//  根因是地面平面有限、又不跟着车走（车开约 84 秒、1000 米就出了边缘）。
//  修法是每帧把地面按**整格**搬到车脚下 ——
//  必须是整数格：搬非整数格，图案就会跟着车漂，移动感又没了。
//  这一节钉住「搬的永远是整数格」这个不变量。
// ===========================================================================

test('整格吸附：结果永远是格宽的整数倍（这才是图案不漂的关键）', () => {
  const tile = 4;
  for (const v of [0, 1.9, 2.1, 999.7, -1000.1, 123456.789, -3.5]) {
    const snapped = snapToTile(v, tile);
    const k = snapped / tile;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-9,
      `${v} 吸附后是 ${snapped}，不是 ${tile} 的整数倍`);
  }
});

test('整格吸附：吸附后离原坐标不超过半格（地面始终盖住车）', () => {
  const tile = 4;
  for (const v of [0.1, 1.9, 2.1, 999.7, -1000.1]) {
    const offset = Math.abs(snapToTile(v, tile) - v);
    assert.ok(offset <= tile / 2 + 1e-9, `${v} 吸附偏移 ${offset} 超过半格`);
  }
});

test('整格吸附：本来就对齐的值纹丝不动', () => {
  assert.equal(snapToTile(8, 4), 8);
  assert.equal(snapToTile(-12, 4), -12);
  assert.equal(snapToTile(0, 4), 0);
});

test('整格吸附：格宽不合法时原样返回（不能除以 0 变成 NaN）', () => {
  assert.equal(snapToTile(5, 0), 5);
  assert.equal(snapToTile(5, -4), 5);
});
