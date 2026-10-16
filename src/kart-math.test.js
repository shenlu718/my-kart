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
  camHeightOf, approachFactor, followRateFor, damp, dampAngle,
  angularRateDegPerSec, screenFraction, snapToTile,
  yawRateFor, fovForSpeed, ndcFromAngle, leadWeight, lateralAccel,
  clampLagAngle, capStepAngle, armDistFor,
  stepCamera, CAMERA_DEFAULTS, MIN_TURN_RADIUS,
  MAX_SPEED, REVERSE_SPEED, ACCEL,
  WHEELBASE, HALF_BASE, MAX_STEER,
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
  const s = stepKart(atSpeed(MAX_SPEED), { forward: 0, turn: 1 }, 0.1);
  assert.ok(s.yaw > 0, `左转应该让朝向角增大，实际 ${s.yaw}`);
});

test('右转（turn = -1）：朝向角减小', () => {
  const s = stepKart(atSpeed(MAX_SPEED), { forward: 0, turn: -1 }, 0.1);
  assert.ok(s.yaw < 0, `右转应该让朝向角减小，实际 ${s.yaw}`);
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

  // ★ 这条从「精确相等」放宽成「足够接近」，是模型改动的必然结果：
  //   转向现在依赖车速（偏航率 ∝ 车速），而车速是分段积分出来的，
  //   于是 yaw 只是**近似**帧率无关，误差 O(dt)（约 0.014 rad ≈ 0.8°），
  //   肉眼完全看不出来，而且帧数翻倍误差减半（见下一条）。
  assert.ok(Math.abs(at60.yaw - at120.yaw) < 0.05,
    `yaw 相差 ${Math.abs(at60.yaw - at120.yaw)} rad，超出容差`);

  // 位置来自分段积分：帧数翻倍误差减半
  const gap = Math.hypot(at60.x - at120.x, at60.z - at120.z);
  assert.ok(gap < 0.2, `60 帧与 120 帧的终点相差 ${gap.toFixed(3)} 米，超出容差`);
});

test('转向的帧率误差随 dt 收敛：帧数翻倍，误差变小', () => {
  const runYaw = (frames) => {
    let s = atSpeed(MAX_SPEED);
    for (let i = 0; i < frames; i++) s = stepKart(s, { forward: 1, turn: 1 }, 1 / frames);
    return s.yaw;
  };
  const y60 = runYaw(60), y120 = runYaw(120), y240 = runYaw(240);
  assert.ok(Math.abs(y60 - y120) > Math.abs(y120 - y240),
    `帧数翻倍后误差应该更小：${Math.abs(y60 - y120)} vs ${Math.abs(y120 - y240)}`);
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
//  测试 12：过弯构图 —— 车不再钉在画面正中
//
//  旧的 cameraSideOffset（把相机平移几米）已删除：平移完 lookAt 又把车拉回
//  正中，等于白做（用户实测原话：「只看到机械的参数在运行，只是表面工作」）。
//  新做法是「构图解算」：先把构图角换算成屏幕位置，再把车**构造**到那里。
//  这里钉住换算：同一个角度，在宽 / 窄视野下是同一件事（角度是可推理的量）。
// ---------------------------------------------------------------------------
test('构图角 → NDC：角度为 0 时在正中', () => {
  assert.equal(ndcFromAngle(0, 0.83), 0);
});

test('构图角 → NDC：同一个角度，视野越窄、屏幕位置越偏', () => {
  const wide = ndcFromAngle(0.2, 0.83);
  const narrow = ndcFromAngle(0.2, 0.45);
  assert.ok(narrow > wide, `同样 0.2 rad，窄视野下应该更偏：${narrow} vs ${wide}`);
});

test('构图角 → NDC：tanHalf 不合法时返回 0（不能变成 Infinity / NaN）', () => {
  assert.equal(ndcFromAngle(0.3, 0), 0);
  assert.equal(ndcFromAngle(0.3, -1), 0);
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


// ===========================================================================
//  六、转向几何（阿克曼）—— 车不能原地打转
//
//  用户实测原话：「我按住 a 键、不按驱动键，小车竟然会原地转向，
//  不应该只是轮子单独动吗？这个问题很低级，不符合常理。」
//  根因：旧的 yaw += turn × 常数 × dt 里根本没有车速这一项。
//  这一节钉住「偏航率 ∝ 车速」。
// ===========================================================================

test('静止打方向：车不会原地转（只有前轮在摆）', () => {
  const s = stepKart(createKartState(), { forward: 0, turn: 1 }, 1);
  assert.equal(s.yaw, 0, '车速为 0 时偏航率必须为 0');
  assert.equal(s.x, 0);
  assert.equal(s.z, 0);
});

test('偏航率 = 车速 / 轴距 × tan(前轮角)', () => {
  const expected = (4 / WHEELBASE) * Math.tan(0.2);
  assert.ok(Math.abs(yawRateFor(4, 0.2) - expected) < 1e-9,
    `预期 ${expected}，实际 ${yawRateFor(4, 0.2)}`);
});

test('偏航率随车速单调增大：开得越快，转得越快', () => {
  const slow = yawRateFor(1, MAX_STEER);
  const mid = yawRateFor(3, MAX_STEER);
  assert.ok(slow > 0 && mid > slow, `应该随速度增大：${mid} vs ${slow}`);
});

test('偏航率：倒车时反号（倒着打左方向，车尾往另一边摆）', () => {
  assert.ok(yawRateFor(-4, MAX_STEER) < 0, '倒车左打方向，偏航率应该为负');
});

test('偏航率：高速封顶，不会算出轮胎抓不住的弯导致打转', () => {
  const r = yawRateFor(MAX_SPEED, MAX_STEER);
  assert.ok(Math.abs(r) <= 24 / Math.max(5, MAX_SPEED) + 1e-9, `超出封顶：${r}`);
  assert.ok(Math.abs(r) < 4, `不该超过安全转速：${r}`);
});

test('后轴基准：后轴沿新车头方向前进 |v|·dt（车身绕后轴摆，不是绕几何中心自转）', () => {
  const dt = 0.1;
  const start = { x: 0, z: 0, yaw: 0, speed: 6 };
  const s = stepKart(start, { forward: 1, turn: 1 }, dt);
  const f = (y) => ({ x: -Math.sin(y), z: -Math.cos(y) });

  const rear0 = { x: start.x - f(start.yaw).x * HALF_BASE, z: start.z - f(start.yaw).z * HALF_BASE };
  const rear1 = { x: s.x - f(s.yaw).x * HALF_BASE, z: s.z - f(s.yaw).z * HALF_BASE };
  const disp = { x: rear1.x - rear0.x, z: rear1.z - rear0.z };

  assert.ok(Math.abs(Math.hypot(disp.x, disp.z) - Math.abs(s.speed * dt)) < 1e-9,
    `后轴位移应该等于 |v|·dt，实际 ${Math.hypot(disp.x, disp.z)}`);
  const cross = disp.x * f(s.yaw).z - disp.z * f(s.yaw).x;
  assert.ok(Math.abs(cross) < 1e-9, '后轴应该沿**新**车头方向前进');
});


// ===========================================================================
//  七、速度感：视野（FOV）随速度张开
//
//  用户实测原话：「我看不到有加速度的趋势，手感很差。」
//  数值上的速度再高，画面上没有变化就等于看不见。参考项目靠张开视野，
//  而不是拉长臂长（拉长臂长会把主体固定成同一个大小，反而看不出速度）。
// ===========================================================================

test('视野随速度张开：静止是基准视野，满速张到最大', () => {
  assert.equal(fovForSpeed(60, 8, 0, 12), 60);
  assert.equal(fovForSpeed(60, 8, 12, 12), 68);
  assert.equal(fovForSpeed(60, 8, 24, 12), 68, '超过满速不该继续张开');
});

test('视野随速度单调增大（这才是"看得见加速度"的来源）', () => {
  const a = fovForSpeed(60, 8, 3, 12);
  const b = fovForSpeed(60, 8, 9, 12);
  assert.ok(b > a, `速度高的视野应该更大：${b} vs ${a}`);
});


// ===========================================================================
//  八、构图死区 —— 小转弯不该晃镜头
//
//  用户实测原话：「我玩卡丁车的时候，它不会每次左右转弯都会有镜头偏移的，
//  每次左右转弯都有偏移的话，玩起来头会很晕。」
//
//  参考实现的构图是**连续**响应方位角滞后的（没有死区）：只要打方向，画面
//  就跟着偏一点。直线行驶时每一次小修正都会让画面晃。所以这里按体感做一处
//  **有意偏离**：只有真过弯（滞后超过死区）才动画面，并用 smoothstep 平滑起步。
// ===========================================================================

test('构图死区：滞后小于死区 → 完全不动（小修正不晃镜头）', () => {
  assert.equal(leadWeight(0.05, 0.17, 0.35), 0);
  assert.equal(leadWeight(0.17, 0.17, 0.35), 0, '刚好等于死区也不该动');
});

test('构图死区：滞后到满额值 → 满额（1），且不溢出', () => {
  assert.equal(leadWeight(0.35, 0.17, 0.35), 1);
  assert.equal(leadWeight(0.9, 0.17, 0.35), 1);
});

test('构图死区：过渡单调且平滑起步（死区边界不跳变）', () => {
  const dead = 0.17, full = 0.35;
  const a = leadWeight(0.20, dead, full);
  const b = leadWeight(0.28, dead, full);
  assert.ok(a > 0 && b > a && b < 1, `应该单调过渡：${a} → ${b}`);
  assert.ok(leadWeight(0.171, dead, full) < 0.001, '死区边界应该平滑起步，不能跳');
});

test('构图死区：参数不合法时不炸', () => {
  assert.equal(leadWeight(0.3, 0.35, 0.17), 0, 'full ≤ dead 时返回 0');
  assert.equal(leadWeight(-0.3, 0.17, 0.35), 0, '负滞后当 0 处理');
});


// ===========================================================================
//  九、横向加速度 —— 「过得多急」的客观量
//
//  参考用它定义「是不是在过弯」：9.0 m/s² 算满弯。
// ===========================================================================

test('横向加速度 = |车速 × 偏航率|', () => {
  assert.equal(lateralAccel(8, 0.5), 4);
  assert.equal(lateralAccel(-8, 0.5), 4, '倒车取绝对值');
  assert.equal(lateralAccel(0, 3), 0, '停着就是 0');
});


// ===========================================================================
//  十、舒适边界（照参考 Camera.ts 的 MAX_LAG / MAX_ARM_RATE）
//
//  用户质问：「参考别人的资料只参考一部分，看到了问题不落地，这个是很低级的错误吧。」
//  对的。参考文件顶部写明：「方位角最多落后 MAX_LAG，且摆动速率不超过
//  MAX_ARM_RATE —— 这两条就是舒适性的全部。」我们之前只搬了构图机制，漏了这两条。
// ===========================================================================

test('滞后上限：没超就原样，超了就钳在 MAX_LAG', () => {
  const maxLag = 0.455;
  assert.equal(clampLagAngle(0.2, 0, maxLag), 0.2);
  const c = clampLagAngle(2.0, 0, maxLag);
  const lag = Math.atan2(Math.sin(c - 0), Math.cos(c - 0));
  assert.ok(Math.abs(lag - maxLag) < 1e-9, `应该钳到 ${maxLag}，实际 ${lag}`);
});

test('滞后上限：跨 ±180° 时按最短弧判断（179° 只落后 2°，不该被当成 358°）', () => {
  const from = (179 * Math.PI) / 180;
  const target = (-179 * Math.PI) / 180;
  // 最短弧：实际只差 2°(0.035 rad) → 在 5° 的上限内，不该被钳
  assert.equal(clampLagAngle(from, target, 0.0873), from, '只差 2°，不该被钳');
  // 上限收到 0.5° 时才会钳，且方向是"跨过 ±180 往负方向"（不是绕 358°）
  const c = clampLagAngle(from, target, 0.00873);
  const lag = Math.atan2(Math.sin(c - target), Math.cos(c - target));
  assert.ok(Math.abs(Math.abs(lag) - 0.00873) < 1e-9, `应该钳到 0.5°，实际 ${lag}`);
  assert.ok(lag < 0, `最短弧的方向是负，实际 ${lag}`);
});

test('摆动速率上限：单帧转过的角度不超过 maxRate×dt', () => {
  const maxStep = 2.0 / 60;
  assert.equal(capStepAngle(0, 0.01, maxStep), 0.01);
  const c = capStepAngle(0, 1.0, maxStep);
  assert.ok(Math.abs(c - maxStep) < 1e-9, `应该钳到 ${maxStep}，实际 ${c}`);
});

test('摆动速率上限：跨 ±180° 也走最短弧', () => {
  const prev = (179 * Math.PI) / 180;
  const cur = (-179 * Math.PI) / 180;
  const c = capStepAngle(prev, cur, 0.05);
  const step = Math.atan2(Math.sin(c - prev), Math.cos(c - prev));
  assert.ok(Math.abs(step) <= 0.05 + 1e-9, `单帧位移该在 0.05 内，实际 ${step}`);
});

test('臂长随速度：静止是基准，满速加上 perSpeed，且不溢出', () => {
  assert.equal(armDistFor(7, 1.2, 0, 12), 7);
  assert.equal(armDistFor(7, 1.2, 12, 12), 8.2);
  assert.equal(armDistFor(7, 1.2, 24, 12), 8.2, '超过满速不该继续拉远');
});


// ===========================================================================
//  十一、相机整链路的回归测试（治"改一个冒一个"）
//
//  用户原话：「不要每次我发现问题，针对这个问题修改之后，别的问题又此起彼伏
//  的冒出来，这样的话问题根本修改不完。」
//
//  解药不是更小心地改，而是**先把整条链路变成可反复跑的测试**：
//  stepCamera 是纯函数，下面直接驱动它跑完整场景，把这一轮的两个 bug
//  变成"以后再犯就会红"的断言。
// ===========================================================================

/** 跑一段驾驶场景，逐帧收集相机读数 */
function flyCamera({ targetSpeed, steer = 1, frames = 300, jitter = 0, wheels = 600 }) {
  const feelCfg = {
    fovSpeed: 10, armDistSpeed: -0.9,
    leadDeadDeg: 10, leadFullDeg: 20,
    frameLagCancel: 0.72, frameXMax: 0.30,
  };
  let s = createKartState();
  for (let i = 0; i < wheels; i++) s = stepKart(s, { forward: 1, turn: 0 }, 1 / 60, targetSpeed);

  let cam = { camYaw: 0, compAng: 0, lead: 0, prevCamYaw: 0 };
  let turnS = 0;
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const rows = [];
  for (let i = 0; i < frames; i++) {
    const dt = (1 / 60) * (1 - jitter + 2 * jitter * rand());
    turnS = damp(turnS, steer, 0.14, dt);
    s = stepKart(s, { forward: 1, turn: turnS }, dt, targetSpeed);
    const out = stepCamera(cam, {
      yaw: s.yaw, speed: s.speed, maxSpeed: targetSpeed, dt,
      aspect: 1.6, baseDist: 7.0, angleDeg: 26, feel: feelCfg,
    });
    cam = { camYaw: out.camYaw, compAng: out.compAng, lead: out.lead, prevCamYaw: out.prevCamYaw };
    rows.push({ ...out, speed: s.speed });
  }
  return rows;
}

// ---------------------------------------------------------------------------
//  回归 1：7~9 m/s 的"抽帧式抖动"
//
//  根因（已复现）：把参考的 MAX_ARM_RATE=2.0 rad/s 抄了过来，而参考那台车
//  满舵中位偏航率只有 52°/s（那条上限是"平时从不生效"的兜底）；我们的车
//  满舵在 8 m/s 是 172~183°/s，于是 2.0 变成每帧生效的机制，还和 26° 滞后
//  上限每帧互相打架（实测 559 帧里切换 339 次，摆动在 115~183 之间跳）。
// ---------------------------------------------------------------------------
test('回归：7~9 m/s 满舵时摆动不再每帧狂跳', () => {
  const rows = flyCamera({ targetSpeed: 8, frames: 300, jitter: 0.15 });
  let maxJump = 0;
  for (let i = 1; i < rows.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(rows[i].swing - rows[i - 1].swing));
  }
  assert.ok(maxJump < 20, `相邻帧摆动跳变 ${maxJump.toFixed(1)} °/s，应该平滑（旧实现是 68）`);
});

test('回归：摆动不超过兜底速率（maxArmRate 真的在兜底）', () => {
  const rows = flyCamera({ targetSpeed: 8, frames: 300, jitter: 0.15 });
  const cap = (CAMERA_DEFAULTS.maxArmRate * 180) / Math.PI;
  const maxSwing = Math.max(...rows.map((r) => r.swing));
  assert.ok(maxSwing <= cap + 10, `摆动 ${maxSwing.toFixed(0)}°/s 超过兜底 ${cap.toFixed(0)}°/s`);
});

// ---------------------------------------------------------------------------
//  回归 2：低速满舵"视野偏移加速度过快、头晕"
//
//  根因（已测量）：阿克曼半径与速度无关（我们 1.84 m），3 m/s 时以 93°/s
//  绕小圈 —— 位移小、旋转快。加最小转弯半径后低速转速被压下来。
// ---------------------------------------------------------------------------
test('回归：低速满舵的转速被"最小转弯半径"压住', () => {
  const slow = yawRateFor(3, MAX_STEER);
  const radius = 3 / slow;        // R = v / ω
  assert.ok(radius >= MIN_TURN_RADIUS - 1e-9,
    `3 m/s 满舵的转弯半径是 ${radius.toFixed(2)} m，不该小于 ${MIN_TURN_RADIUS} m`);
});

test('回归：低速满舵时画面不该动（滞后落在死区内）', () => {
  const rows = flyCamera({ targetSpeed: 3, frames: 300 });
  const maxComp = Math.max(...rows.map((r) => Math.abs(r.compAng)));
  assert.ok(maxComp < 1e-9, `低速满舵的构图应该为 0，实际 ${maxComp}`);
});

test('高速满舵仍然会领进弯道（别把功能一起治没了）', () => {
  const rows = flyCamera({ targetSpeed: 8, frames: 300 });
  const tail = rows.slice(-40);
  const maxCompDeg = Math.max(...tail.map((r) => Math.abs((r.compAng * 180) / Math.PI)));
  assert.ok(maxCompDeg > 5, `8 m/s 满舵应该有构图领入，实际只有 ${maxCompDeg.toFixed(1)}°`);
});

// ---------------------------------------------------------------------------
//  回归 3：stepCamera 本身的性质
// ---------------------------------------------------------------------------
test('stepCamera 是纯函数：不修改传入的相机状态和上下文', () => {
  const cam = { camYaw: 0.3, compAng: 0.1, lead: 0.2, prevCamYaw: 0.2 };
  const snap = { ...cam };
  const ctx = { yaw: 0.5, speed: 8, maxSpeed: 12, dt: 1 / 60, aspect: 1.6, baseDist: 7, angleDeg: 26, feel: { fovSpeed: 10, armDistSpeed: -0.9, leadDeadDeg: 10, leadFullDeg: 20, frameLagCancel: 0.72, frameXMax: 0.3 } };
  stepCamera(cam, ctx);
  assert.deepEqual(cam, snap, '传入的相机状态被改动了');
});

test('stepCamera：视野随速度张开、臂长随速度收近', () => {
  const feelCfg = { fovSpeed: 10, armDistSpeed: -0.9, leadDeadDeg: 10, leadFullDeg: 20, frameLagCancel: 0.72, frameXMax: 0.3 };
  const base = { camYaw: 0, compAng: 0, lead: 0, prevCamYaw: 0 };
  const slow = stepCamera(base, { yaw: 0, speed: 0, maxSpeed: 12, dt: 1 / 60, aspect: 1.6, baseDist: 7, angleDeg: 26, feel: feelCfg });
  const fast = stepCamera(base, { yaw: 0, speed: 12, maxSpeed: 12, dt: 1 / 60, aspect: 1.6, baseDist: 7, angleDeg: 26, feel: feelCfg });
  assert.equal(slow.armDist, 7, '静止时臂长就是基准');
  assert.ok(fast.fov > slow.fov, '速度高视野应该更广');
  assert.ok(fast.armDist < slow.armDist, '速度高臂长应该收近（不是拉远）');
});
