// ============================================================================
//  remote-input.test.js —— 手机手柄输入的合并与断连安全
//  运行：npm test
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRemoteInput, applyRemote, remoteIsFresh, mergeInput, REMOTE_TIMEOUT_MS,
  shapeTurn, freshSnapshotOrZero,
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
    { forward: 0, turn: 0, seq: -1, sid: null, at: 1 });
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


// ---------------------------------------------------------------------------
//  序号：丢弃乱序 / 重复的包
//
//  HTTP 走局域网不保证到达顺序。一个迟到的旧包会把刚转的方向拽回去，
//  表现就是"转向在抖"。参考项目的协议里 seq 是必填项，我们补上。
// ---------------------------------------------------------------------------
test('★ 序号：过期 / 重复的包被整包丢弃（否则转向会抖）', () => {
  const ri = applyRemote(createRemoteInput(), { forward: 1, turn: 0, seq: 5 }, 1000);
  assert.equal(ri.seq, 5);

  const stale = applyRemote(ri, { forward: 0, turn: -1, seq: 3 }, 1200);
  assert.equal(stale.turn, 0, '迟到的旧包不该改状态');
  assert.equal(stale.at, 1000, '旧包不该刷新"最后收到"的时刻（否则断连超时会被重置）');

  const dup = applyRemote(ri, { forward: 0, turn: 1, seq: 5 }, 1300);
  assert.equal(dup.turn, 0, '重复的同号包也该丢');

  const fresh = applyRemote(ri, { forward: 0, turn: 1, seq: 6 }, 1400);
  assert.equal(fresh.turn, 1, '新包正常收');
  assert.equal(fresh.at, 1400);
});

test('没有序号字段时照旧工作（向后兼容：老的手机页、curl 手测）', () => {
  const ri = applyRemote(createRemoteInput(), { forward: 1, turn: 0 }, 1000);
  assert.equal(ri.forward, 1);
  assert.equal(ri.seq, -1, '没序号就保持 -1，不做丢弃');
});


// ---------------------------------------------------------------------------
//  ★ 手机页刷新 = 新会话：序号必须能重新开始
//
//  真 bug（审查 + 代码核验两路确认）：手机页的 seq 是**页面级**计数器
//  （phone/index.html 里 `let seq = 0`），刷新/被系统回收后从 0 重来；
//  而这里只认「比上次大」——于是刷新手机页之后，手柄的所有包被永久丢弃，
//  表现为「手机连不上、按了没反应」，要等 seq 追上旧值（按 16.7 包/秒算约 60 秒）
//  才恢复。中间这段 `at` 一直不刷新 → remoteIsFresh 恒 false → 只剩键盘。
//
//  修法：手机页每开一次带一个 sid；sid 变了就当作新会话，重置序号。
// ---------------------------------------------------------------------------
test('★ 手机页刷新（新 sid）后 seq 从 0 重来 → 必须被接受', () => {
  let ri = createRemoteInput();
  for (let i = 0; i < 5; i++) {
    ri = applyRemote(ri, { forward: 1, turn: 0, seq: 1000 + i, sid: 'A' }, i * 16);
  }
  const afterRefresh = applyRemote(ri, { forward: 1, turn: 0, seq: 0, sid: 'B' }, 1000);
  assert.equal(afterRefresh.seq, 0, '新会话的序号要收下');
  assert.equal(afterRefresh.forward, 1);
  assert.equal(remoteIsFresh(afterRefresh, 1000), true, '新手柄必须立刻算新鲜');
});

test('同一会话内仍然丢旧包（sid 没变时行为不变）', () => {
  const ri = applyRemote(createRemoteInput(), { forward: 1, turn: 0, seq: 10, sid: 'A' }, 0);
  const stale = applyRemote(ri, { forward: 0, turn: -1, seq: 9, sid: 'A' }, 10);
  assert.equal(stale.turn, 0);
  assert.equal(stale.at, 0, '旧包不该刷新"最后收到"的时刻');
});

test('没有 sid 的老页面行为不变（向后兼容）', () => {
  const ri = applyRemote(createRemoteInput(), { forward: 1, turn: 0, seq: 10 }, 0);
  const stale = applyRemote(ri, { forward: 0, turn: 1, seq: 3 }, 10);
  assert.equal(stale.turn, 0);
  assert.equal(ri.sid, null);
});


// ---------------------------------------------------------------------------
//  ★ 平滑分层：140ms 一阶平滑只该给键盘，不该给体感/手机
//
//  原来 `damp(turnSmooth, turnRaw, 0.14, dt)` 加在**合并之后**的 turn 上：
//  那是给键盘 0/1 跳变用的，却把体感一起糊了 —— 倾斜手机到车轮转角相位滞后
//  140ms（50ms 才到 30%），而油门轴完全不平滑（两轴时序还不一致）。
//  这就是"改一处坏别处"的机制：动平滑伤体感，动体感牵键盘。
// ---------------------------------------------------------------------------
test('★ 键盘的 0/1 跳变要平滑（160ms 走到六七成，不突变）', () => {
  let k = 0;
  for (let i = 0; i < 10; i++) {
    k = shapeTurn({
      keyTurn: 1, keyTurnSmoothPrev: k, remote: createRemoteInput(), now: 0, dt: 0.016, tau: 0.14,
    }).keyTurnSmooth;
  }
  assert.ok(k > 0.5 && k < 0.75, `键盘 10 帧（160ms）应该到六七成，实际 ${k.toFixed(3)}`);
});

test('★ 手机/体感是连续信号：第一帧就给满，不能再被 140ms 糊住', () => {
  const remote = applyRemote(createRemoteInput(), { forward: 0, turn: 1, seq: 1, sid: 'A' }, 100);
  const out = shapeTurn({ keyTurn: 0, keyTurnSmoothPrev: 0, remote, now: 100, dt: 0.016, tau: 0.14 });
  assert.equal(out.turn, 1, '手机输入必须立刻生效');
});

test('键盘与手机同时按：平滑后的键盘值 + 手机值，合并后仍钳在 1', () => {
  const remote = applyRemote(createRemoteInput(), { forward: 0, turn: 0.5, seq: 1, sid: 'A' }, 100);
  const out = shapeTurn({ keyTurn: 1, keyTurnSmoothPrev: 0.4, remote, now: 100, dt: 1, tau: 0.14 });
  assert.ok(Math.abs(out.turn - 1) < 1e-9, `0.5 + 0.5 应钳到 1，实际 ${out.turn}`);
});


// ---------------------------------------------------------------------------
//  ★ 新连上的游戏页：陈旧的手机快照必须清零
//
//  服务器会记住最后一次 POST 的值（手机锁屏/划掉后仍是 forward:1），
//  游戏页刷新时 SSE 首帧会把它推过来；游戏侧用本地时间重新盖章 → 当成新鲜输入
//  → 车自己往前冲最多 800ms。复现：手机按住油门 → 飞行模式 → 刷新游戏页。
// ---------------------------------------------------------------------------
test('★ 陈旧的手机快照不能当成新鲜输入（否则刷新游戏页时车会自己冲）', () => {
  const ri = applyRemote(createRemoteInput(), { forward: 1, turn: 0, seq: 5, sid: 'A' }, 0);
  assert.equal(freshSnapshotOrZero(ri, 10000, REMOTE_TIMEOUT_MS).forward, 0,
    '超过超时窗口的快照必须归零');
  assert.equal(freshSnapshotOrZero(ri, 100, REMOTE_TIMEOUT_MS).forward, 1,
    '还在窗口内的快照照给');
  const empty = freshSnapshotOrZero(createRemoteInput(), 0);
  assert.equal(empty.at, -Infinity, '从没收到过就给"从没收到过"的哨兵');
});
