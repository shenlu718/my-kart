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
  createKartState, stepKart, camHeightOf, approachFactor,
  followRateFor, cameraSideOffset, MAX_SPEED,
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
 * 相机追赶车的速度。越大跟得越紧（越接近"硬贴"），越小越飘。
 * 7 大约等于 0.14 秒追上剩余路程的一半。
 */
const CAM_FOLLOW_RATE = 7;

/**
 * 跟随系数的速度增益：每 1 米/秒车速，系数额外加这么多。
 *
 * 不加这一项会怎样（用户实测发现的）：
 *   滞后量 ≈ 车速 ÷ 系数。系数固定时，速度越快落后越多，
 *   车在屏幕上就越来越小 ——「峰值速度一变大，车突然变得很小」。
 * 加上增益后，滞后量收敛到 1/gain ≈ 0.67 米，不再随速度膨胀。
 */
const CAM_FOLLOW_GAIN = 1.5;

/** 过弯时镜头往弯道外侧偏多少米（让出弯心视野，也让"路有宽度"这件事看得见） */
const TURN_CAMERA_OFFSET = 1.2;

/** 过弯时相机拉近的比例（0.1 = 拉近 10%，车看起来更大、周围参照物更少） */
const TURN_CAMERA_ZOOM = 0.1;

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

/** 前轮的最大摆角（视觉用）。30° 已经很明显了 */
const MAX_STEER_VISUAL = Math.PI / 6;

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
/**
 * 造一块「看起来无限」的地面。
 *
 * 之前用 GridHelper 是一块有限的线框（80×80），车开出去就没参照物了。
 *
 * 让网格跟着车走？也不行——网格的周期和跟随步长一样时，图案完全重合，
 * 看起来车根本没动，移动感就没了。
 *
 * 正确做法：把网格图案做成**一张会重复铺开的贴图**，贴在一块巨大的平面上。
 * 贴图锚在平面自己的坐标上，平面不动，所以车一动、图案相对车就在动，
 * 移动感是真的；而平面有 2000 米，开不到边。
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
  texture.repeat.set(500, 500);         // 铺 500×500 次 → 2000 米里每 4 米一格
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy(); // 减轻远处的闪烁

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshBasicMaterial({ map: texture })
  );
  ground.rotation.x = -Math.PI / 2; // 平面默认竖着，转 90° 放平当地面
  ground.position.y = -0.01;        // 比车底略低，避免两个面重叠时闪烁
  return ground;
}
scene.add(createGround());


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


// ---------- 7b. 参数面板 + 实时调节 ----------
// 为什么要做这个：手感是主观的。之前我按「有点偏大」猜了一个数，
// 结果直接调过头变成「过于小」。与其让我猜、你来回报感受，
// 不如你自己边开边调——你的手指比我准。
const camInfo = document.createElement('div');
camInfo.style.cssText = [
  'position:fixed', 'right:10px', 'top:10px', 'z-index:10',
  'padding:6px 10px', 'font:12px/1.6 ui-monospace,Consolas,monospace',
  'color:#8fb3e0', 'background:#0b1020cc', 'border:1px solid #24365a',
  'border-radius:6px', 'pointer-events:none', 'white-space:pre',
].join(';');
document.body.appendChild(camInfo);

let liveSpeed = 0; // 面板上显示的实际车速，由帧循环更新

function showCamInfo() {
  camInfo.textContent =
    `相机距离 ${cam.distance.toFixed(1)}    俯角 ${cam.angleDeg}°    峰值 ×${speedScale.toFixed(1)}\n` +
    `当前车速 ${liveSpeed.toFixed(1)} 米/秒\n` +
    `[ ] 调距离   - = 调俯角   , . 调速度`;
}
showCamInfo();

// 每按一次变化多少。想调得更细就把这几个数改小。
const CAM_STEP_DISTANCE = 0.2;
const CAM_STEP_ANGLE = 1;
const SPEED_STEP = 0.1;

window.addEventListener('keydown', (e) => {
  let changed = false;
  // [ 和 ] 调距离：车看起来变大 / 变小
  if (e.key === '[') { cam.distance = Math.max(3,  +(cam.distance - CAM_STEP_DISTANCE).toFixed(2)); changed = true; }
  if (e.key === ']') { cam.distance = Math.min(20, +(cam.distance + CAM_STEP_DISTANCE).toFixed(2)); changed = true; }
  // - 和 = 调俯角：看得更远 / 看得更下
  if (e.key === '-') { cam.angleDeg = Math.max(5,  cam.angleDeg - CAM_STEP_ANGLE); changed = true; }
  if (e.key === '=' || e.key === '+') { cam.angleDeg = Math.min(60, cam.angleDeg + CAM_STEP_ANGLE); changed = true; }
  // , 和 . 调速度倍率：慢 / 快
  if (e.key === ',') { speedScale = Math.max(0.3, +(speedScale - SPEED_STEP).toFixed(1)); changed = true; }
  if (e.key === '.') { speedScale = Math.min(5,   +(speedScale + SPEED_STEP).toFixed(1)); changed = true; }
  if (changed) showCamInfo();
});


// ---------- 8. 车的状态 + 计时器 ----------
let state = createKartState();
let wheelRoll = 0;                 // 轮子累计转过的角度
const clock = new THREE.Clock();   // 用来量"距上一帧过了多少秒"


// ---------- 8b. 相机跟随用的暂存对象 ----------
// 复用一个 Vector3，不在帧循环里反复 new（每帧都分配新对象会拖慢性能，
// 这是游戏代码里最常见的性能坑之一）
const camTarget = new THREE.Vector3();

// 先把相机瞬移到它该在的位置。
// 否则第一帧会从原点 (0,0,0) 一路"飞"过来，开场就是一段莫名其妙的运镜。
camTarget.set(
  Math.sin(state.yaw) * cam.distance,
  camHeightOf(cam),
  Math.cos(state.yaw) * cam.distance
);
camera.position.copy(camTarget);


// ---------- 9. 每帧循环 ----------
function frame() {
  // 限幅：切到别的标签页再切回来时，dt 可能是几十秒，不限的话车会瞬移
  const dt = Math.min(clock.getDelta(), 0.1);

  // 读键盘 → 变成"意图"
  // 上和下写成相减：同时按住时 1 - 1 = 0 自然抵消，不用额外判断
  const input = {
    forward: (keys.isHeld('ArrowUp') || keys.isHeld('w') ? 1 : 0)
           - (keys.isHeld('ArrowDown') || keys.isHeld('s') ? 1 : 0),
    turn: (keys.isHeld('ArrowLeft') || keys.isHeld('a') ? 1 : 0)
        - (keys.isHeld('ArrowRight') || keys.isHeld('d') ? 1 : 0),
  };

  // 算新状态（这一步有 kart-math 的 22 个测试护航）。
  // 速度倍率乘在「峰值速度」上，而不是乘在油门上——
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
    if (w.pivot) w.pivot.rotation.y = input.turn * MAX_STEER_VISUAL; // 前轮跟着方向盘摆
    w.mesh.rotation.x = wheelRoll;                                    // 四个轮子都在滚
  }

  // ---- 参照物跟着循环（把落到身后的桩子搬到身前）----
  updatePosts(state.x, state.z);

  // ---- 相机 ----
  // 过弯时把镜头往**弯道外侧**偏一点：于是车在画面上偏向弯心一侧，
  // 让出弯心的视野 —— 同时让玩家感觉到"这条路是有宽度的"。
  const side = cameraSideOffset(input.turn, state.yaw, TURN_CAMERA_OFFSET);

  // 过弯时稍微拉近一点，视野聚焦在车上、周围参照物少露一些
  const distanceNow = cam.distance * (1 - Math.abs(input.turn) * TURN_CAMERA_ZOOM);
  const heightNow = distanceNow * Math.tan((cam.angleDeg * Math.PI) / 180);

  camTarget.set(
    state.x + Math.sin(state.yaw) * distanceNow + side.x,
    heightNow,
    state.z + Math.cos(state.yaw) * distanceNow + side.z
  );

  // 平滑地逼近那个位置，而不是每帧硬贴上去。
  // 相机会稍微"落后"一点：加速时被甩开、停下时慢慢跟上——
  // 这一点点滞后就是速度感的来源；硬跟会让画面僵硬死板。
  //
  // 但系数必须随速度自适应：固定系数时速度越快落后越多、车就越小
  //（用户实测发现的「峰值速度一变大，车突然变得很小」）。
  const followRate = followRateFor(state.speed, CAM_FOLLOW_RATE, CAM_FOLLOW_GAIN);
  camera.position.lerp(camTarget, approachFactor(followRate, dt));

  camera.lookAt(state.x, 0.3, state.z);

  // 面板上的车速只在变化时才更新 DOM（没必要每帧都写一遍）
  const shown = Math.round(state.speed * 10) / 10;
  if (shown !== liveSpeed) {
    liveSpeed = shown;
    showCamInfo();
  }

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
