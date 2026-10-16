// ============================================================================
//  main.js —— 一辆能被键盘开动的小车
//
//  分工：
//    kart-math.js  算「车该怎么动」（纯函数，有测试）
//    keys.js       记「哪些键按着」（纯逻辑，有测试）
//    main.js       只剩「听浏览器事件」和「画到屏幕上」——这两件测不了的事
// ============================================================================

import * as THREE from '../vendor/three/three.module.js';
import {
  createKartState, stepKart, camHeightOf, damp, dampAngle,
  angularRateDegPerSec, screenFraction, snapToTile,
  fovForSpeed, ndcFromAngle, leadWeight,
  clampLagAngle, capStepAngle, armDistFor,
  MAX_SPEED, MAX_STEER,
} from './kart-math.js';
import { createKeyState } from './keys.js';


// ---------------------------------------------------------------------------
//  相机参数
//
//  只用两个「人能感觉到的量」控制，高度由它们算出来：
//    距离 —— 相机在车后多远（直接决定车看起来多大）
//    俯角 —— 从上往下看多少度（决定看得到多远 vs 看到多少脚下）
//
//  ★ 可以边开边调，不用改代码、不用刷新：
//       [   ]    ← 拉近 / 拉远   （车变大 / 变小）
//       -   =    ← 俯角变平 / 变陡（看得更远 / 看得更下）
//       ,   .    ← 峰值速度调慢 / 调快
//    右上角实时显示当前值和实际车速。
// ---------------------------------------------------------------------------
const cam = {
  distance: 7.0,  // 相机在车后多远（用户实测调出来的值）
  angleDeg: 26,   // 俯角（度，同上）
};

/**
 * 相机方位角的时间常数（秒）—— 相机"坐在车后方哪个方向"追上车的朝向要多久。
 *
 * ★ 这是整个相机里**唯一**该有滞后的地方。
 *
 * 为什么：参考项目（kart-royale）的注释把它说得最清楚 ——
 *   「不用位置弹簧：追一个移动目标的弹簧会留下 |v|×T 的稳态误差，
 *     这会在高速时悄悄改写相机几何。」
 * 我之前恰恰把平滑加在**位置**上，于是速度一快、相机落后越多、
 * 车在屏幕上就越小 —— 用户实测报的「峰值速度一变大车就变小」。
 *
 * 平滑放在**方位角**上没有这个问题：它只让镜头摆得柔一点，
 * 不改变相机到车的距离。
 */
const CAM_YAW_TAU = 0.16;

/**
 * 转向输入的平滑时间常数（秒）。
 *
 * 为什么需要：按键是 0/1 跳变的。不平滑就直接拿去算相机偏移和拉近，
 * 相机就得去追一个**自己也在跳**的目标 —— 反复按 A/D 时车忽大忽小、突变。
 * （用户实测原话：「一大一小、一大一小，而且是突变」。）
 */
const TURN_SMOOTH_TAU = 0.14;

// ---------------------------------------------------------------------------
//  过弯构图（照参考项目 Camera.ts 的 frameSubject / frameX / frameY）
//
//  ★ 为什么推倒重来：
//  旧做法是「过弯把相机往弯外平移 1.2 米」。可它下一行就是 camera.lookAt(车)，
//  lookAt 每帧把车拽回画面正中 —— 平移等于白做。用户实测原话：
//    「镜头的偏移并没有产生对于行驶手感的优化，我只看到机械的参数在运行，
//      只是做了表面工作……为什么车辆转弯的时候，车子会一直处于屏幕的中间？」
//
//  正解是「构图解算」：**不要 lookAt 车**，而是构造出一条视线，让车**恰好落在**
//  屏幕的指定位置上（参考实现的 frameSubject：把 eye→车 的射线按
//  atan(fx·tanH) / atan(fy·tanV) 旋转）。于是：
//    ① 车不再被钉在正中；
//    ② 过弯时镜头领进弯道——车因此偏出中心，弯内一侧的视野让出来；
//    ③ 「车跑出画面」不再是可能发生的失败模式（fx 有硬上限）。
//
//  横向 fx 由「方位角滞后」驱动：右弯时方位角拖在车头左侧 → 镜头回摆 →
//  车落到画面偏左、右侧（弯内）的路看得到。这正是用户描述的那种驾驶视角。
// ---------------------------------------------------------------------------
/** 抵消多少比例的方位角滞后 → 静态时留下几度真实滞后，其余进画面（参考值 0.72） */
const CAM_FRAME_LAG_CANCEL = 0.72;
/** 构图角变化速率上限（rad/s）—— 防止朝向突变变成一记猛甩 */
const CAM_FRAME_ANG_RATE = 0.85;
/** 横向构图硬上限（NDC）。超过约 1/3 个半屏，主体就不像主体了（参考值 0.30） */
const CAM_FRAME_X_MAX = 0.30;
/**
 * 构图死区（度）：方位角滞后小于它 → **画面完全不动**。
 *
 * 用户实测原话：「它不会每次左右转弯都会有镜头偏移的，每次左右转弯都有偏移的话，
 * 玩起来头会很晕。」参考实现的构图是连续响应的（没有死区），这一条是我们
 * 按体感**有意加的偏离**：只有真过弯才动画面，直线上的小修正不晃镜头。
 */
const CAM_LEAD_DEAD_DEG = 10;
/** 滞后超过它 → 构图满额；中间用 smoothstep 平滑过渡（死区边界不跳） */
const CAM_LEAD_FULL_DEG = 20;

// ---- 舒适边界（照参考 Camera.ts：这两条「就是舒适性的全部」）----
/** ① 方位角最多落后车头这么多度（参考 MAX_LAG=26°，原文：它决定玩家能不能看到前方） */
const CAM_MAX_LAG_DEG = 26;
/** ② 方位角摆动速率上限（rad/s，参考 MAX_ARM_RATE=2.0：打转/被撞时画面不该跟着复现） */
const CAM_MAX_ARM_RATE = 2.0;
/** ②' 滞后已经超上限时放宽到它 —— 看不到车的玩家不在乎恢复得顺不顺（参考 _LOST=3.2） */
const CAM_MAX_ARM_RATE_LOST = 3.2;
/** 过弯估计的平滑时间常数（参考 CORNER_TAU=0.15）—— 否则死区边界会抖 */
const CAM_CORNER_TAU = 0.15;
/** 满速时镜头额外拉远多少米（参考 ARM_DIST_SPEED；臂长和视野是一对，一起动才有速度感） */
const ARM_DIST_SPEED = 1.2;
/** 车压在画面下半，把上半屏让给前方的路（参考值 -0.19） */
const CAM_FRAME_Y = -0.19;
/** 速度越快再压低一点，进一步把视线推向前方 */
const CAM_FRAME_Y_SPEED = -0.05;
const CAM_FRAME_Y_MIN = -0.32;
const CAM_FRAME_Y_MAX = -0.08;
/** 构图参照点离地高度（米）—— 车体中部，不是地面 */
const CAM_SUBJ_UP = 0.45;

// ---------------------------------------------------------------------------
//  速度感：视野（FOV）随速度张开
//
//  用户实测原话：「我看不到有加速度的趋势，手感很差。」
//  数值上的速度再高，画面上没有变化就等于看不见。参考项目靠张开**视野**
//  （而不是拉长臂长——那会把主体固定成同一个大小，反而看不出速度）。
// ---------------------------------------------------------------------------
/** 静止时的垂直视野（度）—— 和原来一样 */
const FOV_BASE = 60;
/** 满速时额外张开多少度（参考项目 FOV_SPEED 是 5，这里给大一点更明显） */
const FOV_SPEED = 8;

/**
 * 速度倍率：乘在 kart-math 的 MAX_SPEED 上。
 *
 * 为什么用倍率，而不是直接改 MAX_SPEED？
 * 因为那是底层的基准常量、测试也引用着它，改它会破坏测试的意义
 * （测试断言"满速 1 秒走 MAX_SPEED 米"，改了常量它就变成在验证新数字）。
 * 倍率留在 main.js 这层（纯表现层），随便调、不影响任何测试。
 * 「底层定基准、上层调口味」是很常见的分层方式。
 */
let speedScale = 1.5;

/** 轮子半径，用来算滚动的圈数 */
const WHEEL_RADIUS = 0.25;


// ---------- 1. 场景 ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);

// 雾：让远处的地面渐渐融进背景色。
// 两个作用：① 看起来真的没有边界（配合那块 2000 米的大地面）；
//           ② 盖住远处网格线的闪烁（贴图重复太多次会在远处产生摩尔纹）。
// 参数 =（雾的颜色, 开始起雾的距离, 完全看不见的距离）
scene.fog = new THREE.Fog(0x0b1020, 45, 200);


// ---------- 2. 相机 ----------
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  3000
);


// ---------- 3. 渲染器 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);


// ---------- 4. 小车 ----------
/**
 * 造一辆小车。
 *
 * 为什么用 Group 而不是一个 Mesh？
 * 一辆车是由好几个零件拼起来的（车身、车头、驾驶舱、四个轮子）。
 * Group 就是一个"容器"：移动或旋转它，里面的零件会整体跟着动——
 * 对外表现就像一辆完整的车。
 * 3D 里做人物、道具、场景，全靠这个办法把零件组装起来。
 *
 * @returns {{group: THREE.Group, wheels: Array}} group 是整辆车，
 *          wheels 里的每一项记录了轮子本身和它的转向支架
 */
function createKart() {
  const group = new THREE.Group();

  const paintMat = new THREE.MeshStandardMaterial({ color: 0x4fc3ff, roughness: 0.45 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x27364f, roughness: 0.85 });

  // 车身：扁长的一块
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.28, 1.6), paintMat);
  body.position.y = 0.38;
  group.add(body);

  // 车头：窄一点、矮一点的一小块。
  // 没有它，从后面看根本分不出车头车尾——这正是之前"一个方块"最大的问题。
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.45), paintMat);
  nose.position.set(0, 0.3, -0.92);
  group.add(nose);

  // 驾驶舱：放在车尾一侧，进一步强化方向感
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.34, 0.52), darkMat);
  cabin.position.set(0, 0.69, 0.12);
  group.add(cabin);

  // 轮子：一个"躺下"的圆柱。
  // 圆柱默认是竖着的（轴朝 Y，像个柱子）。这里在**几何体**上转 90° 让它躺下
  // （轴朝 X，也就是左右方向）——而不是在 mesh 上转。
  // 这样 mesh.rotation.x 就能专门留给"滚动"，两个旋转不会打架。
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.18, 16);
  wheelGeo.rotateZ(Math.PI / 2);

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.9 });

  const WHEEL_X = 0.56;          // 左右轮距的一半
  const WHEEL_FRONT_Z = -0.55;   // 前轮的前后位置（-Z 是车头方向）
  const WHEEL_BACK_Z = 0.58;     // 后轮

  const wheels = [];

  for (const [x, z, steerable] of [
    [-WHEEL_X, WHEEL_FRONT_Z, true],
    [ WHEEL_X, WHEEL_FRONT_Z, true],
    [-WHEEL_X, WHEEL_BACK_Z,  false],
    [ WHEEL_X, WHEEL_BACK_Z,  false],
  ]) {
    const mesh = new THREE.Mesh(wheelGeo, wheelMat);
    mesh.position.y = WHEEL_RADIUS;

    if (steerable) {
      // 前轮要"一边转向一边滚动"。两个旋转都设在同一个物体上会互相干扰
      // （欧拉角是按固定顺序叠加的），所以套一层支架：
      // 支架负责转向，轮子自己负责滚动。
      const pivot = new THREE.Group();
      pivot.position.set(x, 0, z);
      pivot.add(mesh);
      group.add(pivot);
      wheels.push({ mesh, pivot });
    } else {
      mesh.position.set(x, WHEEL_RADIUS, z);
      group.add(mesh);
      wheels.push({ mesh, pivot: null });
    }
  }

  return { group, wheels };
}

const { group: kart, wheels } = createKart();
scene.add(kart);


// ---------- 5. 地面 ----------
/** 地面平面边长（米）—— 够大，再配合下面的「跟踪搬运」就等于无限大 */
const GROUND_SIZE = 2000;
/** 贴图沿一边铺多少次 → 一格边长 = GROUND_SIZE / GROUND_REPEAT = 4 米 */
const GROUND_REPEAT = 500;
/** 一格的边长（米）。搬运地面必须按它的整数倍走，原因见 updateGround */
const GROUND_TILE = GROUND_SIZE / GROUND_REPEAT;

/**
 * 造一块地面：把网格图案做成**一张会重复铺开的贴图**，贴在一块平面。
 *
 * 之前用 GridHelper 是一块有限的线框（80×80），车开出去就没参照物了。
 *
 * 这里有两件事必须分开看：
 *   ① 图案要锚在**世界坐标**上 —— 图案和车一起动，移动感就没了；
 *   ② 平面本身要永远盖住车 —— 否则车开远了会开出平面边缘。
 * 这一版平面是钉在原点的一块有限平面，所以 ② 还没满足，
 * 由 updateGround 每帧补上（补的时候必须守 ① 的约束）。
 */
function createGround() {
  // 用一张 64×64 的画布画出"一格"长什么样
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#141d33';        // 格子内部
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#1f2d4a';      // 格子线
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, size, size); // 沿边缘画线，重复铺开后自然连成网格

  const texture = new THREE.CanvasTexture(canvas);
  // ★ 这一行必须写。Three.js 默认把贴图当成"线性颜色"数据，
  //   而画布里的颜色是 sRGB。不声明清楚，显示时会被多转换一次，
  //   整块地面就会发灰发亮（实测截图发现的）。
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping; // 横向铺不满就重复
  texture.wrapT = THREE.RepeatWrapping; // 纵向同上
  texture.repeat.set(GROUND_REPEAT, GROUND_REPEAT); // 铺 GROUND_REPEAT 次 → 每 GROUND_TILE 米一格
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy(); // 减轻远处的闪烁

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
    new THREE.MeshBasicMaterial({ map: texture })
  );
  mesh.rotation.x = -Math.PI / 2; // 平面默认竖着，转 90° 放平当地面
  mesh.position.y = -0.01;        // 比车底略低，避免两个面重叠时闪烁
  return mesh;
}
const ground = createGround();
scene.add(ground);

/**
 * 每帧把地面搬到车脚下 —— 但只能按**整格**搬。
 *
 * 用户实测报的 bug：
 *   「行驶很长一段距离之后，地上的网格消失了，只有柱子出现。」
 * 根因：地面是钉在原点、边长 2000 米的平面，车直线开约 84 秒（1000 米）
 * 就开出了边缘；而路桩是一圈跟着车循环的，所以只剩柱子、没了地面。
 *
 * 那让地面直接跟着车走（position = 车坐标）行不行？——不行。
 * 那正是之前踩过的坑：图案和车一起动，车相对网格就永远不动，
 * 移动感立刻消失（和"让网格跟着车走"是同一个错误）。
 *
 * 正解：按**一格的整数倍**搬。贴图每 GROUND_TILE（4 米）重复一次，
 * 所以整体挪 4 米的整数倍之后，图案和世界坐标完全对齐 ——
 * 看起来地面钉死在世界里纹丝不动，而平面永远够大。
 * 「图案锚在世界坐标、平面跟着车搬」，是这个问题的标准解法。
 */
function updateGround(carX, carZ) {
  ground.position.x = snapToTile(carX, GROUND_TILE);
  ground.position.z = snapToTile(carZ, GROUND_TILE);
}


// ---------- 5b. 参照物（路桩） ----------
/**
 * 一圈会「循环复用」的路桩 —— 专门用来当速度的参照物。
 *
 * 为什么需要它（用户实测原话）：
 *   「网格地界，我没有参照物，我无法看出速度是快还是慢，
 *     无法修正出最佳的峰值速度。」
 *
 * 说得完全对：**速度感不来自速度数值，来自旁边东西掠过的频率。**
 * 空荡荡的世界里，开 10 米/秒和开 30 米/秒看起来一模一样。
 *
 * 怎么做到"看起来无限"：不做真的无限，只在车周围铺一圈固定数量的桩子。
 * 车往前走，就把落到身后的桩子搬到身前 —— 玩家看到的永远是满满一圈。
 * 这是游戏里做无限地形、无限星空、无限公路的通用手法：
 * **复用一小批物体，让它们围着玩家循环**。
 *
 * 注意：桩子必须锚在**世界坐标**上（车动、它们不动），否则就跟之前
 * "让网格跟着车走"一样——图案和车一起动，移动感立刻消失。
 */
// 用偶数：格子中心正好错开原点，开局就不会有一根桩子压在车身上
const POST_GRID = 12;                            // 每边铺几个（12×12 = 144 个）
const POST_SPACING = 12;                         // 桩子间距（米）
const POST_HALF = (POST_GRID * POST_SPACING) / 2; // 覆盖半径，72 米

function createPosts() {
  const geo = new THREE.CylinderGeometry(0.14, 0.22, 1.8, 6);
  const mat = new THREE.MeshStandardMaterial({ color: 0x41618f, roughness: 0.85 });

  const half = POST_GRID / 2;
  const list = [];

  for (let i = 0; i < POST_GRID; i++) {
    for (let j = 0; j < POST_GRID; j++) {
      const post = new THREE.Mesh(geo, mat);
      // 初始均匀铺在格子上，之后靠"搬运"维持
      post.position.set(
        (i - half + 0.5) * POST_SPACING,
        0.9,
        (j - half + 0.5) * POST_SPACING
      );
      scene.add(post);
      list.push(post);
    }
  }
  return list;
}

const posts = createPosts();

/** 每帧把落到身后（超出覆盖范围）的桩子搬到身前 */
function updatePosts(carX, carZ) {
  for (const post of posts) {
    const dx = post.position.x - carX;
    if (dx > POST_HALF) post.position.x -= POST_HALF * 2;
    else if (dx < -POST_HALF) post.position.x += POST_HALF * 2;

    const dz = post.position.z - carZ;
    if (dz > POST_HALF) post.position.z -= POST_HALF * 2;
    else if (dz < -POST_HALF) post.position.z += POST_HALF * 2;
  }
}


// ---------- 6. 灯光 ----------
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(4, 8, 6);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.7));


// ---------- 7. 键盘 ----------
const keys = createKeyState();

window.addEventListener('keydown', (e) => keys.press(e.key));
window.addEventListener('keyup', (e) => keys.release(e.key));

// ★ 修 bug：按住 W 切到别的窗口后，车会一直往前冲。
//
// 根因：切窗口时，「松开 W」这个事件发生在**别的窗口**里，
// 永远不会送到这个页面。于是这里一直以为 W 还按着。
//
// 解法：窗口一失去焦点（或者标签页被切到后台），就主动清空所有按键。
window.addEventListener('blur', () => keys.clearAll());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) keys.clearAll();
});


// ---------- 7b. 实时指标面板 + 参数实时调节 ----------
// 为什么要做这个面板：手感是主观的，但**它的变化是客观的**。
// 之前我按「有点偏大」猜了一个相机参数，结果直接调过头变成「过于小」——
// 与其让我猜、你来回报感受，不如把关键量显示在屏幕上：
// 「相机摆动多少度/秒」「车占屏多少」——「是不是更稳了」「是不是又变小了」，
// 看数字比看感觉可靠得多。
//
// 参考项目也是这么做的：作者靠 camera-probe 测 lag/swing/framing 来调参，
// 而不是靠肉眼反复试。这个面板就是我们的轻量版 camera-probe。
const panel = document.createElement('div');
panel.style.cssText = [
  'position:fixed', 'right:10px', 'top:10px', 'z-index:10',
  'padding:6px 10px', 'font:12px/1.6 ui-monospace,Consolas,monospace',
  'color:#8fb3e0', 'background:#0b1020cc', 'border:1px solid #24365a',
  'border-radius:6px', 'pointer-events:none', 'white-space:pre',
].join(';');
document.body.appendChild(panel);

let panelVisible = true;

/** 面板上显示的实时读数，全部由帧循环更新 */
const metrics = {
  speed: 0,        // 当前车速（米/秒，倒车为负）
  swing: 0,        // 相机摆动（度/秒，已平滑）
  swingPeak: 0,    // 相机摆动 1 秒内的峰值（度/秒）—— 看「最猛的一下有多猛」
  framing: 0,      // 车占屏比例（0~1）
  fov: 0,          // 当前垂直视野（度）—— 随速度张开
  armDist: 0,      // 当前臂长（米）—— 随速度拉远
  leadDeg: 0,      // 镜头领入角（度）—— 过弯时镜头往弯内转了多少
  lead: 0,         // 构图启用程度（0~1）—— 死区把小的修正挡在外面
  frameX: 0,       // 车在屏幕上的横向位置（NDC，0 = 正中；负 = 偏左）
};

/**
 * 车的基准高度（米）—— 算「车占屏比例」时的参照尺寸。
 * 取小车模型的总高：轮子到驾驶舱顶约 0.86，凑整成 0.9 好记。
 */
const KART_REF_HEIGHT = 0.9;
const KART_CENTER_Y = KART_REF_HEIGHT / 2;

/** 摆动读数的平滑时间常数：raw 值每帧抖得厉害，平滑一下才看得清趋势 */
const SWING_SMOOTH_TAU = 0.25;
/** 摆动峰值的衰减时间常数：尖峰被记下来、再慢慢落回去（像 VU 表） */
const SWING_PEAK_TAU = 1.0;

let lastPanelText = '';

/** 把当前读数画到面板上。内容没变就不动 DOM（没必要每帧都写一遍）。 */
function renderPanel() {
  const text =
    `— 实时指标 —\n` +
    `车速     ${metrics.speed.toFixed(1).padStart(5)} 米/秒   ${(metrics.speed * 3.6).toFixed(0).padStart(4)} km/h\n` +
    `视野     ${metrics.fov.toFixed(1).padStart(5)} °   臂长 ${metrics.armDist.toFixed(1)} 米（静止 ${cam.distance.toFixed(1)}）\n` +
    `相机摆动 ${metrics.swing.toFixed(0).padStart(5)} °/s   峰值 ${metrics.swingPeak.toFixed(0).padStart(5)} °/s\n` +
    `镜头领入 ${metrics.leadDeg.toFixed(1).padStart(5)} °   启用 ${(metrics.lead * 100).toFixed(0).padStart(3)} %\n` +
    `车在画面 ${(metrics.frameX >= 0 ? '+' : '') + metrics.frameX.toFixed(2)}      （0=正中 负=偏左）\n` +
    `车占屏   ${(metrics.framing * 100).toFixed(1).padStart(5)} %\n` +
    `— 相机 —\n` +
    `距离 ${cam.distance.toFixed(1)}  俯角 ${cam.angleDeg}°  峰值 ×${speedScale.toFixed(1)}\n` +
    `[ ] 距离  - = 俯角  , . 速度  P 收起面板`;
  if (text !== lastPanelText) {
    lastPanelText = text;
    panel.textContent = text;
  }
}
renderPanel();

// 每按一次变化多少。想调得更细就把这几个数改小。
const CAM_STEP_DISTANCE = 0.2;
const CAM_STEP_ANGLE = 1;
const SPEED_STEP = 0.1;

window.addEventListener('keydown', (e) => {
  // [ 和 ] 调距离：车看起来变大 / 变小
  if (e.key === '[') cam.distance = Math.max(3,  +(cam.distance - CAM_STEP_DISTANCE).toFixed(2));
  if (e.key === ']') cam.distance = Math.min(20, +(cam.distance + CAM_STEP_DISTANCE).toFixed(2));
  // - 和 = 调俯角：看得更远 / 看得更下
  if (e.key === '-') cam.angleDeg = Math.max(5,  cam.angleDeg - CAM_STEP_ANGLE);
  if (e.key === '=' || e.key === '+') cam.angleDeg = Math.min(60, cam.angleDeg + CAM_STEP_ANGLE);
  // , 和 . 调速度倍率：慢 / 快
  if (e.key === ',') speedScale = Math.max(0.3, +(speedScale - SPEED_STEP).toFixed(1));
  if (e.key === '.') speedScale = Math.min(5,   +(speedScale + SPEED_STEP).toFixed(1));
  // P 收起 / 展开面板（想专心开车或截图时用）
  if (e.key === 'p' || e.key === 'P') {
    panelVisible = !panelVisible;
    panel.style.display = panelVisible ? '' : 'none';
  }
  // 参数改动不用在这里手动刷面板：帧循环每帧重画，下一帧就带上了
});


// ---------- 8. 车的状态 + 相机状态 + 计时器 ----------
let state = createKartState();
let wheelRoll = 0;                 // 轮子累计转过的角度
const clock = new THREE.Clock();   // 用来量"距上一帧过了多少秒"

/** 相机坐在车后方的方位角。它弹簧式地追车的朝向 —— 那点滞后就是"镜头摆动感" */
let camYaw = 0;

/**
 * 平滑后的转向量。
 * 方向盘不该是 0/1 跳变的：真车打方向有个过程。它现在直接喂给 stepKart
 * 当前轮转角（顺带也抹掉了按键跳变），前轮的视觉摆角也用同一个值。
 */
let turnSmooth = 0;

/** 构图角（弧度）—— 镜头相对车头方向偏转多少，用来把车摆到画面的非中心位置 */
let compAng = 0;

/** 构图启用程度（0~1，已平滑）—— 死区把小的修正挡在外面 */
let leadSmooth = 0;

/** 上一帧的方位角 —— 用来算「摆动速率」（本帧与上帧之差 ÷ dt） */
let prevCamYaw = 0;

/** 摆动读数的平滑值，以及它的 1 秒峰值 */
let swingSmooth = 0;
let swingPeak = 0;

/** 复用一个临时点，避免每帧 new 一个 Vector3（减少垃圾回收压力） */
const kartPoint = new THREE.Vector3();


// ---------------------------------------------------------------------------
//  构图解算 —— 让车「恰好落在」屏幕的指定位置（照参考 Camera.ts 的 frameSubject）
//
//  给定相机位置和车的位置，求一条视线，使车投影到 NDC = (fx, fy)。
//  做法：从 eye→车 的射线出发，先绕「上」轴转 atan(fx·tanH)，再绕新的「右」轴
//  转 -atan(fy·tanV)。两次旋转不严格可交换，但在这个角度下耦合误差不到
//  五分之一度（参考实现的原注）。
//
//  ★ 这就是「车不再永远在屏幕正中」的实现：车在画面上的位置是**输入**，
//    不是碰巧——所以「车跑出画面」不再是可能发生的失败模式。
// ---------------------------------------------------------------------------
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _subj = new THREE.Vector3();
const _viewDir = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _upV = new THREE.Vector3();
const _aimPt = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** 把相机摆到「看得到车落在 NDC (fx, fy)」的朝向 */
function frameSubject(camObj, sx, sy, sz, fx, fy, tanV, tanH) {
  _subj.set(sx, sy, sz);
  _viewDir.subVectors(_subj, camObj.position);
  const r = _viewDir.length();
  if (r < 1e-3) { camObj.lookAt(_subj); return; }
  _viewDir.multiplyScalar(1 / r);

  _rt.crossVectors(_viewDir, WORLD_UP);
  if (_rt.lengthSq() < 1e-6) { camObj.lookAt(_subj); return; }
  _rt.normalize();
  _upV.crossVectors(_rt, _viewDir).normalize();

  // 先偏航，再俯仰（顺序与参考实现一致）
  _q.setFromAxisAngle(_upV, Math.atan(fx * tanH));
  _viewDir.applyQuaternion(_q);

  _rt.crossVectors(_viewDir, WORLD_UP);
  if (_rt.lengthSq() > 1e-6) {
    _rt.normalize();
    _q.setFromAxisAngle(_rt, -Math.atan(fy * tanV));
    _viewDir.applyQuaternion(_q);
  }

  _aimPt.copy(camObj.position).addScaledVector(_viewDir, r);
  camObj.lookAt(_aimPt);
}


// ---------- 8b. 相机的初始位置 ----------
// 先把相机摆到它该在的地方。
// 否则第一帧会从原点 (0,0,0) 一路"飞"过来，开场就是一段莫名其妙的运镜。
camYaw = state.yaw;
prevCamYaw = camYaw;   // 摆动速率从第一帧起就要有正确的基准
camera.position.set(
  Math.sin(camYaw) * cam.distance,
  camHeightOf(cam),
  Math.cos(camYaw) * cam.distance
);


// ---------- 9. 每帧循环 ----------
function frame() {
  // 限幅：切到别的标签页再切回来时，dt 可能是几十秒，不限的话车会瞬移
  const dt = Math.min(clock.getDelta(), 0.1);

  // 读键盘 → 变成"意图"
  // 上和下写成相减：同时按住时 1 - 1 = 0 自然抵消，不用额外判断
  const forwardInput = (keys.isHeld('ArrowUp') || keys.isHeld('w') ? 1 : 0)
                     - (keys.isHeld('ArrowDown') || keys.isHeld('s') ? 1 : 0);
  const turnRaw = (keys.isHeld('ArrowLeft') || keys.isHeld('a') ? 1 : 0)
                - (keys.isHeld('ArrowRight') || keys.isHeld('d') ? 1 : 0);

  // 方向盘平滑：真车打方向有个过程，不是 0 → 满舵一帧跳变。
  // 平滑后再进物理与视觉，所以反复按 A/D 不会让任何东西突变。
  turnSmooth = damp(turnSmooth, turnRaw, TURN_SMOOTH_TAU, dt);

  const input = { forward: forwardInput, turn: turnSmooth };

  // 算新状态。转向由 kart-math 的阿克曼模型算：偏航率 ∝ 车速，
  // 所以停着打方向车不会原地转。速度倍率乘在「峰值速度」上，而不是乘在油门上——
  // 那样只是让车更快到顶，不会真的更快。
  state = stepKart(state, input, dt, MAX_SPEED * speedScale);

  // ---- 把状态画到车上 ----
  kart.position.set(state.x, 0, state.z);
  kart.rotation.y = state.yaw;

  // 轮子：按走过的距离滚动。
  // 走过的距离 ÷ 轮子周长 × 2π = 转过多少弧度，化简就是 距离 ÷ 半径。
  // 倒车时 speed 是负的，轮子自然反过来转。
  wheelRoll += (state.speed * dt) / WHEEL_RADIUS;
  for (const w of wheels) {
    if (w.pivot) w.pivot.rotation.y = turnSmooth * MAX_STEER;      // 前轮摆角 = 真实转向角
    w.mesh.rotation.x = wheelRoll;                                    // 四个轮子都在滚
  }

  // ---- 参照物跟着循环（把落到身后的桩子搬到身前）----
  updatePosts(state.x, state.z);

  // ---- 地面按整格搬运，永远铺在车脚下（否则开远了会开出平面边缘）----
  updateGround(state.x, state.z);

  // ---- 相机 ----
  //
  // 架构（照参考项目 kart-royale）：
  //   ① 方位角 camYaw 弹簧式追车头（唯一该有滞后的地方）
  //   ② 视野 FOV 随速度张开（速度感来源）
  //   ③ 位置精确算出，不加位置弹簧（弹簧有 |v|×T 的稳态误差，
  //      速度一快车就变小 —— 踩过的坑）
  //   ④ 朝向用「构图解算」而不是 lookAt(车)：车落在**指定**的屏幕位置

  // ① 方位角弹簧式追车的朝向。滞后 = 镜头摆动感（这是想要的），
  //    走最短弧，所以跨过 ±180° 时不会绕一大圈。
  camYaw = dampAngle(camYaw, state.yaw, CAM_YAW_TAU, dt);

  // ①b 舒适边界 —— 照参考 Camera.ts，原文说「这两条就是舒适性的全部」：
  //     · 上限一：滞后不超过 CAM_MAX_LAG（否则玩家看不到自己去哪）
  //     · 上限二：单帧摆动不超过 CAM_MAX_ARM_RATE×dt（打转 / 被撞不该被复现）
  const lagMag = Math.abs(Math.atan2(Math.sin(camYaw - state.yaw), Math.cos(camYaw - state.yaw)));
  const maxLagRad = (CAM_MAX_LAG_DEG * Math.PI) / 180;
  camYaw = clampLagAngle(camYaw, state.yaw, maxLagRad);
  camYaw = capStepAngle(prevCamYaw, camYaw,
    (lagMag > maxLagRad ? CAM_MAX_ARM_RATE_LOST : CAM_MAX_ARM_RATE) * dt);

  // ② 视野随速度张开 + 臂长随速度拉远 —— 这两个是**一对**：
  //    臂长拉长会把车缩小，视野张开让世界扑面而来；一起动才「看得见加速度」。
  const fovNow = fovForSpeed(FOV_BASE, FOV_SPEED, state.speed, MAX_SPEED * speedScale);
  if (Math.abs(camera.fov - fovNow) > 1e-3) {
    camera.fov = fovNow;
    camera.updateProjectionMatrix();
  }
  const distNow = armDistFor(cam.distance, ARM_DIST_SPEED, state.speed, MAX_SPEED * speedScale);

  // ③ 构图角：抵消一部分方位角滞后 → 镜头领进弯道、车因此偏出画面中心。
  //    （右弯时方位角拖在车头左侧 → bearingLag>0 → 构图角为负 → 车偏左，
  //      右侧弯内的路就看得见了 —— 这就是"驾驶视角"。）
  const bearingLag = Math.atan2(Math.sin(camYaw - state.yaw), Math.cos(camYaw - state.yaw));
  //    死区：只有真过弯才动画面（小修正不晃镜头）—— 按用户体感加的一层
  const leadTarget = leadWeight(Math.abs(bearingLag),
    (CAM_LEAD_DEAD_DEG * Math.PI) / 180, (CAM_LEAD_FULL_DEG * Math.PI) / 180);
  //    参考 CORNER_TAU：估计本身也要平滑，否则死区边界上会抖
  leadSmooth = damp(leadSmooth, leadTarget, CAM_CORNER_TAU, dt);
  const wantComp = -CAM_FRAME_LAG_CANCEL * bearingLag * leadSmooth;
  compAng += Math.max(-CAM_FRAME_ANG_RATE * dt,
             Math.min(CAM_FRAME_ANG_RATE * dt, wantComp - compAng));

  // ④ 位置精确算出 —— 不加弹簧
  const heightNow = camHeightOf({ distance: distNow, angleDeg: cam.angleDeg });
  camera.position.set(
    state.x + Math.sin(camYaw) * distNow,
    heightNow,
    state.z + Math.cos(camYaw) * distNow
  );

  // ⑤ 朝向：把车摆到屏幕的 (fx, fy)，而不是让它永远居中
  const tanV = Math.tan((camera.fov * Math.PI) / 360);
  const tanH = tanV * camera.aspect;
  const sp = Math.min(1, Math.abs(state.speed) / (MAX_SPEED * speedScale));
  const frameX = Math.max(-CAM_FRAME_X_MAX, Math.min(CAM_FRAME_X_MAX, ndcFromAngle(compAng, tanH)));
  const frameY = Math.max(CAM_FRAME_Y_MIN, Math.min(CAM_FRAME_Y_MAX, CAM_FRAME_Y + CAM_FRAME_Y_SPEED * sp));
  frameSubject(camera, state.x, CAM_SUBJ_UP, state.z, frameX, frameY, tanV, tanH);

  // ---- 实时指标（轻量测具）----
  // 为什么显示这几项：手感是主观的，但它的变化是客观的。
  // 「相机是不是更稳了」「车是不是又变小了」，看数字比看感觉可靠得多。

  // ① 相机摆动速率（度/秒）：方位角每秒转过多少 —— 越猛越容易晕
  const swingNow = angularRateDegPerSec(prevCamYaw, camYaw, dt);
  prevCamYaw = camYaw;                       // 基准要在算完之后再更新
  swingSmooth = damp(swingSmooth, swingNow, SWING_SMOOTH_TAU, dt);
  swingPeak = Math.max(swingNow, swingPeak * Math.exp(-dt / SWING_PEAK_TAU));

  // ② 车占屏比例：用**真实的相机到车距离**去算，相机拉远 / FOV 变化都如实反映
  kartPoint.set(state.x, KART_CENTER_Y, state.z);
  metrics.framing = screenFraction(KART_REF_HEIGHT, camera.position.distanceTo(kartPoint), camera.fov);

  // ③ 构图读数：镜头领入多少度、死区启用多少、车落在画面哪里
  metrics.leadDeg = (compAng * 180) / Math.PI;
  metrics.lead = leadSmooth;
  metrics.frameX = frameX;
  metrics.armDist = distNow;

  // ④ 车速 / 视野 / 摆动读数
  metrics.speed = state.speed;
  metrics.fov = camera.fov;
  metrics.swing = swingSmooth;
  metrics.swingPeak = swingPeak;

  renderPanel();

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();


// ---------- 10. 窗口大小变化 ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
