// ============================================================================
//  main.js —— 一个会转的立方体
//
//  所有 3D 网页程序都逃不出这 7 步。看懂这个文件，后面做赛车就是往里面加东西。
// ============================================================================

// 从本地 vendor 目录引入 Three.js（不用 CDN，断网也能跑）
import * as THREE from '../vendor/three/three.module.js';


// ---------- 第 1 步：建一个"场景"（Scene） ----------
// 场景就是 3D 世界的容器。所有物体、灯光都要放进它里面，否则看不见。
const scene = new THREE.Scene();


// ---------- 第 2 步：放一台"相机"（Camera） ----------
// 相机决定"你从哪个位置、哪个角度观察这个世界"。
// 四个参数：视野角度、宽高比、最近能看清的距离、最远能看到的距离。
const camera = new THREE.PerspectiveCamera(
  60,                                     // 视野 60 度（越大越像广角镜头）
  window.innerWidth / window.innerHeight, // 宽高比，跟着窗口走
  0.1,                                    // 比 0.1 更近的东西看不见
  100                                     // 比 100 更远的东西看不见
);
camera.position.set(0, 0, 3);             // 相机后退 3 米，否则贴在物体上什么都看不到


// ---------- 第 3 步：建一个"渲染器"（Renderer） ----------
// 渲染器负责把场景+相机算出来的画面，画到网页画布上。
// 每帧调一次 renderer.render()，就是"画一张画"。
const renderer = new THREE.WebGLRenderer({ antialias: true }); // antialias=边缘抗锯齿
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement); // 把画布插进网页


// ---------- 第 4 步：往场景里放物体 ----------
// Mesh（网格）= 形状（Geometry）+ 材质（Material）
// 形状决定它长什么样，材质决定它表面什么颜色、怎么反光。
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),                              // 长宽高各 1 米
  new THREE.MeshStandardMaterial({ color: 0x4fc3ff })          // 0x4fc3ff = 天蓝色
);
scene.add(cube); // 放进去才存在


// ---------- 第 5 步：打光 ----------
// MeshStandardMaterial 是靠光算颜色的：没有光，它就是一片纯黑。
const sun = new THREE.DirectionalLight(0xffffff, 3); // 方向光，像太阳
sun.position.set(2, 3, 4);                           // 光从右上前方照过来
scene.add(sun);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));    // 环境光，给暗面一点底光


// ---------- 第 6 步：动画循环 ----------
// 网页不会自己"动"。要一帧一帧地画，才能形成动画。
// 一秒钟画约 60 帧，人眼就觉得是连续的。
function frame() {
  cube.rotation.x += 0.01;  // 让方块绕 X 轴转一点点
  cube.rotation.y += 0.015; // 同时绕 Y 轴转一点点（转起来才看得出是立体的）

  renderer.render(scene, camera); // 画这一帧

  requestAnimationFrame(frame);   // 预约下一帧——这一行让循环持续下去
}
frame(); // 启动循环


// ---------- 第 7 步：跟随窗口大小 ----------
// 用户拖动浏览器窗口时，相机比例和画布尺寸都要跟着变，否则画面会被拉伸变形。
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix(); // 改了相机参数必须调这一行才生效
  renderer.setSize(window.innerWidth, window.innerHeight);
});
