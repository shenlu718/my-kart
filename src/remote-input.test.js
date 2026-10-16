// ============================================================================
//  remote-input.test.js —— 手机手柄输入的合并与断连安全
//  运行：npm test
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRemoteInput, applyRemote, remoteIsFresh, mergeInput, REMOTE_TIMEOUT_MS,
} from './remote-input.js';


test('初始快照：什么都没按、且"从未收到过"', () => {
  const ri = createRemoteInput();
  assert.equal(ri.forward, 0);
  assert.equal(ri.turn, 0);
  assert.equal(remoteIsFresh(ri, 1000), false, '从没收到过就永远不新鲜');
});

test('applyRemote：正常值照收，并记录时刻', () => {
  const ri = applyRemote(createRemoteInput(), { forward: 1, turn: -1 }, 500);
  assert.equal(ri.forward, 1);
  assert.equal(ri.turn, -1);
  assert.equal(ri.at, 500);
});

test('applyRemote：非法值一律当 0，越界值被钳住（不要相信网络上的输入）', () => {
  assert.deepEqual(
    { ...applyRemote(createRemoteInput(), { forward: 'abc', turn: null }, 1) },
    { forward: 0, turn: 0, at: 1 });
  assert.equal(applyRemote(createRemoteInput(), { forward: 99, turn: -99 }, 1).forward, 1);
  assert.equal(applyRemote(createRemoteInput(), { forward: 99, turn: -99 }, 1).turn, -1);
  assert.equal(applyRemote(createRemoteInput(), null, 1).forward, 0, 'null 消息也不该炸');
});

test('★ 断连安全：手机停止更新超过 REMOTE_TIMEOUT_MS 就不再算数', () => {
  const ri = applyRemote(createRemoteInput(), { forward: 1, turn: 0 }, 1000);
  assert.equal(remoteIsFresh(ri, 1000 + REMOTE_TIMEOUT_MS - 1), true, '还在超时内');
  assert.equal(remoteIsFresh(ri, 1000 + REMOTE_TIMEOUT_MS + 1), false, '超时了就不算数');
});

test('★ 断连安全：手机掉线时，合并结果只剩键盘（车不会一直冲）', () => {
  const ri = applyRemote(createRemoteInput(), { forward: 1, turn: 1 }, 1000);
  const now = 1000 + REMOTE_TIMEOUT_MS + 1;
  const merged = mergeInput({ forward: 0, turn: 0 }, ri, now);
  assert.deepEqual(merged, { forward: 0, turn: 0 }, '手机掉线后应该完全没输入');
});

test('合并：键盘 + 手机相加，且不会越界', () => {
  const ri = applyRemote(createRemoteInput(), { forward: 1, turn: 0.5 }, 1000);
  assert.deepEqual(mergeInput({ forward: 0, turn: 0 }, ri, 1000), { forward: 1, turn: 0.5 });
  assert.deepEqual(mergeInput({ forward: 1, turn: 1 }, ri, 1000), { forward: 1, turn: 1 },
    '两边同向也不该超过 1（否则前轮会打死）');
  assert.deepEqual(mergeInput({ forward: -1, turn: 0 }, ri, 1000), { forward: 0, turn: 0.5 },
    '反向互相抵消');
});
