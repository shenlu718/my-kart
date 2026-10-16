// ============================================================================
//  remote-input.js —— 手机手柄的输入合并（纯函数，可测）
//
//  数据流：
//      手机网页 --POST /api/input--> 本机 dev-server --SSE /api/stream--> 游戏
//
//  本文件只管最后一步的**合并与安全**：手机来的输入怎么和键盘合成、
//  以及"手机掉线了怎么办"。这两件事都是纯计算，所以放在这里、有测试。
//
//  ★ 安全设计（必须有）：手机消失（切后台、锁屏、走出 WiFi）时，
//    服务器收不到更新。如果不做超时判定，车会**一直往前冲**——
//    这正是之前踩过的"按住 W 切窗口车不停"的同一个坑，换了个入口。
// ============================================================================

/** 超过这么久没收到手机更新，就当作"没在按" */
export const REMOTE_TIMEOUT_MS = 800;

/** 一份远程输入快照。at = 最后一次收到更新的时刻（毫秒，performance.now 的时钟） */
export function createRemoteInput() {
  return { forward: 0, turn: 0, at: -Infinity };
}

/**
 * 把手机发来的一条消息并进快照。
 * 消息形状：{ forward: -1|0|1, turn: -1|0|1 }。
 * 非法/缺失的值一律当 0，并且钳到 [-1, 1] —— 不要相信网络上的输入。
 *
 * @param {{forward:number, turn:number, at:number}} prev 上一份快照
 * @param {{forward?:number, turn?:number}|null} msg 手机发来的消息
 * @param {number} now 现在（毫秒）
 * @returns {{forward:number, turn:number, at:number}} 新快照（不改 prev）
 */
export function applyRemote(prev, msg, now) {
  const clamp = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-1, Math.min(1, n));
  };
  return {
    forward: clamp(msg && msg.forward),
    turn: clamp(msg && msg.turn),
    at: Number.isFinite(now) ? now : -Infinity,
  };
}

/**
 * 这份远程输入还新鲜吗？（新鲜 = 手机还在发心跳）
 * @param {{at:number}} ri
 * @param {number} now 现在（毫秒）
 * @param {number} [timeoutMs]
 * @returns {boolean}
 */
export function remoteIsFresh(ri, now, timeoutMs = REMOTE_TIMEOUT_MS) {
  if (!ri || !Number.isFinite(ri.at)) return false;
  if (!Number.isFinite(now)) return false;
  return now - ri.at <= timeoutMs;
}

/**
 * 合并键盘与手机。
 *
 * 为什么是**相加**而不是"手机优先"：相加允许两边同时出力（手机按油门、
 * 手还能碰一下键盘），而且松开哪一边都不会把另一边顶掉；钳到 [-1,1] 保证
 * 不会因为两边同向而超范围（turn 超范围会让前轮打死）。
 *
 * 手机不新鲜时**完全忽略**它（这就是防"手机掉线车一直冲"的那道门）。
 *
 * @param {{forward:number, turn:number}} local 键盘输入
 * @param {{forward:number, turn:number, at:number}} remote 手机快照
 * @param {number} now 现在（毫秒）
 * @param {number} [timeoutMs]
 * @returns {{forward:number, turn:number}}
 */
export function mergeInput(local, remote, now, timeoutMs = REMOTE_TIMEOUT_MS) {
  const lf = Number(local && local.forward) || 0;
  const lt = Number(local && local.turn) || 0;
  if (!remoteIsFresh(remote, now, timeoutMs)) {
    return { forward: lf, turn: lt };
  }
  const mix = (a, b) => Math.max(-1, Math.min(1, a + b));
  return { forward: mix(lf, remote.forward), turn: mix(lt, remote.turn) };
}
