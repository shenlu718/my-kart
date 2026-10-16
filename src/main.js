// ============================================================================
//  main.js —— 一个能被键盘开动的方块
//
//  分工：
//    kart-math.js  算「车该怎么动」（纯函数，有测试）
//    keys.js       记「哪些键按着」（纯逻辑，有测试）
//    main.js       只剩「听浏览器事件」和「画到屏幕上」——这两件测不了的事
// ============================================================================

import * as THREE from '../vendor/three/three.module.js';
import { createKartState, stepKart, camHeightOf } from './kart-math.js';
import { createKeyState } from './keys.js';


// ---------------------------------------------------------------------------
//  相机参数
//
//  只用两个「人能感觉到的量」控制，高度由它们算出来：
//    距离 —— 相机在车后多远（直接决定车看起来多大）
//    俯角 —— 从上往下看多少度（决定看得到多远 vs 看到多少脚下）
//
//  上一版把「距离」和「高度」当成两个独立参数，结果调距离时俯角跟着变，
//  两个变量互相污染，调不出想要的手感。
//
//  ★ 这两个数可以边开边调，不用改代码、不用刷新：
//       [   ]    ← 拉近 / 拉远   （车变大 / 变小）
//       -   =    ← 俯角变平 / 变陡（看得更远 / 看得更下）
//    右上角实时显示当前值。调到满意后把数字告诉我，我固化成默认。
// ---------------------------------------------------------------------------
const cam = {
  distance: 6.8,  // 相机在车后多远
  angleDeg: 27,   // 俯角（度）
};

// （俯角 → 高度的换算 camHeightOf 已搬到 kart-math.js，
//   那样才能被自动化测试覆盖——它有个极易搞错的弧度/角度陷阱。）


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


// ---------- 4. 车（暂时还是方块，但做成扁长的，能看出车头） ----------
const kart = new THREE.Mesh(
  new THREE.BoxGeometry(1, 0.6, 1.6),
  new THREE.MeshStandardMaterial({ color: 0x4fc3ff })
);
kart.position.y = 0.3;
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


// ---------- 7b. 相机实时调节 ----------
// 为什么要做这个：手感是主观的。上一轮我按「有点偏大」猜了一个数，
// 结果直接调过头变成「过于小」。与其让我猜、你来回报感受，
// 不如你自己边开边调——你的手指比我准。
//
// 调满意后把右上角的数字告诉我，我把它固化成默认值。
const camInfo = document.createElement('div');
camInfo.style.cssText = [
  'position:fixed', 'right:10px', 'top:10px', 'z-index:10',
  'padding:6px 10px', 'font:12px/1.6 ui-monospace,Consolas,monospace',
  'color:#8fb3e0', 'background:#0b1020cc', 'border:1px solid #24365a',
  'border-radius:6px', 'pointer-events:none', 'white-space:pre',
].join(';');
document.body.appendChild(camInfo);

function showCamInfo() {
  camInfo.textContent =
    `相机距离 ${cam.distance.toFixed(1)}    俯角 ${cam.angleDeg}°\n` +
    `[ ] 调距离      - = 调俯角`;
}
showCamInfo();

// 每按一次变化多少。想调得更细就把这两个数改小。
const CAM_STEP_DISTANCE = 0.2;
const CAM_STEP_ANGLE = 1;

window.addEventListener('keydown', (e) => {
  let changed = false;
  // [ 和 ] 调距离：车看起来变大 / 变小
  if (e.key === '[') { cam.distance = Math.max(3,  +(cam.distance - CAM_STEP_DISTANCE).toFixed(2)); changed = true; }
  if (e.key === ']') { cam.distance = Math.min(20, +(cam.distance + CAM_STEP_DISTANCE).toFixed(2)); changed = true; }
  // - 和 = 调俯角：看得更远 / 看得更下
  if (e.key === '-') { cam.angleDeg = Math.max(5,  cam.angleDeg - CAM_STEP_ANGLE); changed = true; }
  if (e.key === '=' || e.key === '+') { cam.angleDeg = Math.min(60, cam.angleDeg + CAM_STEP_ANGLE); changed = true; }
  if (changed) showCamInfo();
});


// ---------- 8. 车的状态 + 计时器 ----------
let state = createKartState();
const clock = new THREE.Clock(); // 用来量"距上一帧过了多少秒"


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

  // 算新状态（这一步有 kart-math 的测试护航）
  state = stepKart(state, input, dt);

  // 把状态画到 3D 物体上
  kart.position.x = state.x;
  kart.position.z = state.z;
  kart.rotation.y = state.yaw;

  // 相机跟在车后上方
  // 车头朝 (-sin, 0, -cos)，所以"车后"是 (+sin, 0, +cos)
  camera.position.set(
    state.x + Math.sin(state.yaw) * cam.distance,
    camHeightOf(cam),
    state.z + Math.cos(state.yaw) * cam.distance
  );
  camera.lookAt(state.x, 0.3, state.z);

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
