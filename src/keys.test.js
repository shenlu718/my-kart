// ============================================================================
//  keys.test.js —— 键盘状态管理的测试
//
//  为什么要为「记按键」这么简单的事单独写一个模块和测试？
//
//  因为用户实测发现了一个 bug：按住 W 然后切到别的窗口，游戏里车一直往前冲。
//  根因是：切窗口时，「松开 W」这个事件发生在别的窗口里，根本没送到游戏页面，
//  于是游戏永远以为 W 还按着。
//
//  解法是「窗口失焦时清空所有按键」。但「窗口失焦」这件事发生在浏览器里，
//  没浏览器就测不了。
//
//  所以：把「记按键」这个逻辑单独拿出来（这个能测），
//  把「监听浏览器事件」留在 main.js（那个测不了）。
//  —— 把不可测的部分尽量挤到最外层，是一个反复用到的设计手法。
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyState } from './keys.js';


test('初始状态：什么键都没按', () => {
  const keys = createKeyState();
  assert.equal(keys.isHeld('w'), false);
});

test('按下之后是按住状态', () => {
  const keys = createKeyState();
  keys.press('w');
  assert.equal(keys.isHeld('w'), true);
});

test('松开之后不再是按住状态', () => {
  const keys = createKeyState();
  keys.press('w');
  keys.release('w');
  assert.equal(keys.isHeld('w'), false);
});

test('松开一个没按过的键：不报错，也不影响别的键', () => {
  const keys = createKeyState();
  keys.press('w');
  keys.release('x');
  assert.equal(keys.isHeld('w'), true, 'W 不应该被无关的键影响');
});

test('clearAll：一次清空所有按住的键（切窗口时用）', () => {
  const keys = createKeyState();
  keys.press('w');
  keys.press('ArrowUp');
  keys.press('a');

  keys.clearAll();

  assert.equal(keys.isHeld('w'), false);
  assert.equal(keys.isHeld('ArrowUp'), false);
  assert.equal(keys.isHeld('a'), false);
});

test('clearAll 之后还能正常继续按（不能一次清空就永久失灵）', () => {
  const keys = createKeyState();
  keys.press('w');
  keys.clearAll();

  keys.press('a');

  assert.equal(keys.isHeld('a'), true, '清空后应该还能按新键');
  assert.equal(keys.isHeld('w'), false, '被清空的键应该保持清空');
});
