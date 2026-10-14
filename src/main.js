// ============================================================================
//  main.js —— 一个能被键盘开动的方块
//
//  和上一版的区别：方块不再自己转，而是听你的键盘。
//  计算部分全部交给 kart-math.js（那个文件有测试保护），这里只负责
//  「读键盘」和「把结果画到屏幕上」。
// ============================================================================

import * as THREE from '../vendor/three/three.module.js';
import { createKartState, stepKart } from './kart-math.js';


// ---------- 1. 场景 ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);


// ---------- 2. 相机 ----------
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  200
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


// ---------- 5. 地面网格 ----------
// 没有参照物就看不出车在动。网格让移动变得可见。
const grid = new THREE.GridHelper(80, 80, 0x2f4a7a, 0x1b2740);
scene.add(grid);


// ---------- 6. 灯光 ----------
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(4, 8, 6);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.7));


// ---------- 7. 键盘 ----------
// keydown 时把按键记下来，keyup 时删掉。
// 为什么不直接在 keydown 里移动？因为按住不放时 keydown 会疯狂重复触发，
// 而我们要的是"按住 = 持续前进"，所以记状态、每帧读一次，这才是正确做法。
const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.key));
window.addEventListener('keyup', (e) => keys.delete(e.key));


// ---------- 8. 车的状态 + 计时器 ----------
let state = createKartState();
const clock = new THREE.Clock(); // 用来量"距上一帧过了多少秒"


// ---------- 9. 每帧循环 ----------
function frame() {
  // 限幅很重要：切到别的标签页再切回来时，dt 可能是几十秒，
  // 不限的话车会瞬移出去。0.1 秒 = 最多按 10fps 处理，够用了。
  const dt = Math.min(clock.getDelta(), 0.1);

  // 读键盘 → 变成"意图"
  const input = {
    forward: (keys.has('ArrowUp') || keys.has('w')) ? 1 : 0,
    turn: ((keys.has('ArrowLeft') || keys.has('a')) ? 1 : 0)
        - ((keys.has('ArrowRight') || keys.has('d')) ? 1 : 0),
  };

  // 算新状态（这一步有 9 个测试护航）
  state = stepKart(state, input, dt);

  // 把状态画到 3D 物体上
  kart.position.x = state.x;
  kart.position.z = state.z;
  kart.rotation.y = state.yaw;

  // 相机跟在车后上方
  // 车头朝 (-sin, 0, -cos)，所以"车后"就是 (+sin, 0, +cos)
  camera.position.set(
    state.x + Math.sin(state.yaw) * 6,
    3,
    state.z + Math.cos(state.yaw) * 6
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
