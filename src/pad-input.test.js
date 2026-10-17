// ============================================================================
//  pad-input.test.js —— 手机手柄的按钮映射
//
//  这一组测试就是为了防住那个真 bug：
//  按着油门却发出去 {forward:0}（Map 的键写成"触点:动作"，读的时候却比"动作"）。
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPadState, pressAction, releaseContact, releaseAll, isHeld, padInput, mergeTurn,
  PAD_ACTIONS,
} from './pad-input.js';


test('★ 按住油门 → forward 是 1（旧实现这里恒为 0）', () => {
  const pad = createPadState();
  pressAction(pad, 1, 'accel');
  assert.deepEqual(padInput(pad), { forward: 1, turn: 0 });
  assert.equal(isHeld(pad, 'accel'), true);
});

test('★ 按住油门 + 右转 → 两个轴都对', () => {
  const pad = createPadState();
  pressAction(pad, 1, 'accel');
  pressAction(pad, 2, 'right');
  assert.deepEqual(padInput(pad), { forward: 1, turn: -1 });
});

test('松开某个触点 → 它那个动作就没了', () => {
  const pad = createPadState();
  pressAction(pad, 1, 'accel');
  pressAction(pad, 2, 'left');
  releaseContact(pad, 1);
  assert.deepEqual(padInput(pad), { forward: 0, turn: 1 });
});

test('同一个动作被两个触点按住：松开一个不算松手（照参考项目的"重复肩键"）', () => {
  const pad = createPadState();
  pressAction(pad, 1, 'accel');
  pressAction(pad, 2, 'accel');
  releaseContact(pad, 1);
  assert.equal(isHeld(pad, 'accel'), true, '还有一个手指按着，不该算松手');
  assert.deepEqual(padInput(pad), { forward: 1, turn: 0 }, '同向叠加后仍钳在 1');
});

test('油门 + 刹车同时按 → 互相抵消', () => {
  const pad = createPadState();
  pressAction(pad, 1, 'accel');
  pressAction(pad, 2, 'brake');
  assert.deepEqual(padInput(pad), { forward: 0, turn: 0 });
});

test('左 + 右同时按 → 互相抵消（不会因为超范围让前轮打死）', () => {
  const pad = createPadState();
  pressAction(pad, 1, 'left');
  pressAction(pad, 2, 'right');
  assert.deepEqual(padInput(pad), { forward: 0, turn: 0 });
});

test('未知动作被忽略，不会污染输入', () => {
  const pad = createPadState();
  pressAction(pad, 1, 'nosuchaction');
  assert.deepEqual(padInput(pad), { forward: 0, turn: 0 });
  assert.equal(pad.contacts.size, 0);
});

test('releaseAll 一次清空（切后台用）', () => {
  const pad = createPadState();
  pressAction(pad, 1, 'accel');
  pressAction(pad, 2, 'left');
  releaseAll(pad);
  assert.deepEqual(padInput(pad), { forward: 0, turn: 0 });
});

test('动作表本身：四个键、极性固定', () => {
  assert.deepEqual(Object.keys(PAD_ACTIONS).sort(), ['accel', 'brake', 'left', 'right']);
  assert.equal(PAD_ACTIONS.accel.forward, 1);
  assert.equal(PAD_ACTIONS.brake.forward, -1);
  assert.equal(PAD_ACTIONS.left.turn, 1, '我们的约定：turn +1 是左转');
  assert.equal(PAD_ACTIONS.right.turn, -1);
});


// ---------------------------------------------------------------------------
//  跨文件契约：手柄页里的按钮名字，必须都在动作表里
//
//  这类"名字对不上"就是刚才那个 bug 的表亲：按钮上写 poser=kart 和动作表里
//  写 "accel" 不一致时，按下去毫无反应，而语法检查完全看不出来。
//  这条测试把 HTML 和模块绑在一起查。
// ---------------------------------------------------------------------------
test('★ 手柄页每个按钮的 data-hold 名字都在动作表里（对不上就会"按了没反应"）', () => {
  const html = readFileSync(new URL('../phone/index.html', import.meta.url), 'utf8');
  const names = [...html.matchAll(/data-hold="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 4, `应该至少有四个按钮，实际找到 ${names.length} 个：${names}`);
  for (const n of names) {
    assert.ok(Object.prototype.hasOwnProperty.call(PAD_ACTIONS, n),
      `按钮 data-hold="${n}" 在 PAD_ACTIONS 里不存在 —— 按下去不会有任何反应`);
  }
  for (const key of Object.keys(PAD_ACTIONS)) {
    assert.ok(names.includes(key), `动作表里的 "${key}" 在页面上没有对应按钮`);
  }
});

test('★ 手柄页必须用 padInput() 算输入，不能自己再存一份映射', () => {
  const html = readFileSync(new URL('../phone/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('padInput(pad)'), '发出去的输入必须来自 padInput()');
  assert.ok(html.includes("from '/src/pad-input.js'"), '必须 import 共用模块，而不是内联一份');
});

// ---------------------------------------------------------------------------
//  按钮转向 + 体感转向的合成
// ---------------------------------------------------------------------------
test('★ 合成：按钮按着就听按钮（手动优先），否则听体感', () => {
  assert.equal(mergeTurn(1, -0.8), 1, '按着方向键时应当听按钮，不被体感干扰');
  assert.equal(mergeTurn(-1, 0.8), -1);
  assert.equal(mergeTurn(0, 0.6), 0.6, '没按按钮时听体感');
  assert.equal(mergeTurn(0, 0), 0);
});

test('合成：输出永远钳在 [-1,1]', () => {
  assert.equal(mergeTurn(2, 0), 1);
  assert.equal(mergeTurn(0, -2), -1);
  assert.equal(mergeTurn(NaN, 0.5), 0.5, 'NaN 当 0 处理');
});

// ---------------------------------------------------------------------------
//  长按不能唤出浏览器自己的菜单
//
//  用户实测反馈：「我长按油门的话还会出现这样低级的情况」——
//  油门是**要一直按住**的键，长按是它的正常用法，而不是误操作。
//  安卓/iOS 长按会弹「复制 / 搜索 / 打开链接」或放大镜，压在按钮上挡住界面。
//  两条防线缺一不可：
//    ① CSS `-webkit-touch-callout: none`（iOS 的长按菜单）
//    ② 拦掉 `contextmenu`（安卓 Chrome 的长按菜单 / 桌面右键）
// ---------------------------------------------------------------------------
test('★ 手柄页必须禁掉长按弹出的浏览器菜单（长按油门是正常玩法）', () => {
  const html = readFileSync(new URL('../phone/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('-webkit-touch-callout'),
    'CSS 里要有 -webkit-touch-callout: none，否则 iOS 长按会弹菜单');
  assert.ok(/addEventListener\(\s*['"]contextmenu['"]/.test(html),
    '要监听并阻止 contextmenu，否则安卓长按会弹「复制/搜索」挡在按钮上');
});

test('★ 手柄页的主界面不能有 fixed 定位的提示行（它会长在按钮上）', () => {
  const html = readFileSync(new URL('../phone/index.html', import.meta.url), 'utf8');
  // 上一版把提示行 position:fixed 钉在屏幕底部，而中间栏的内容也会延伸到底部，
  // 手机横屏被地址栏挤矮之后两者就叠在一起（用户截图里的"低级情况"）。
  // 提示现在只允许出现在设置弹层里。
  assert.ok(!/#hint\s*\{[^}]*position:\s*fixed/.test(html),
    '提示不要再用 position:fixed 钉在屏幕底部 —— 矮屏下会叠在中间栏上');
});
