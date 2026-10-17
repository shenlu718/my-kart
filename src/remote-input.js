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

// 键盘那一路的平滑用 kart-math 的 damp（同一个实现，不抄第二份）
import { damp } from './kart-math.js';

/** 超过这么久没收到手机更新，就当作"没在按" */
export const REMOTE_TIMEOUT_MS = 800;

/**
 * 一份远程输入快照。
 * at = 最后一次收到更新的时刻（毫秒）；seq = 包序号；
 * sid = 手机页的会话 id（每开一次页面换一个 —— 用来识别"手机页刷新了"）
 */
export function createRemoteInput() {
  return { forward: 0, turn: 0, seq: -1, sid: null, at: -Infinity };
}

/**
 * 把手机发来的一条消息并进快照。
 * 消息形状：{ forward: -1|0|1, turn: -1|0|1, seq?: number }。
 * 非法/缺失的值一律当 0，并且钳到 [-1, 1] —— 不要相信网络上的输入。
 *
 * ★ 序号（seq）的作用：丢弃**过期/重复**的包。
 *   HTTP 走局域网不保证到达顺序；一个迟到的旧包会把刚转向的方向拽回去，
 *   表现就是"转向在抖"。序号比当前的旧 → 整个包丢掉，连时刻都不更新
 *   （否则一个迟到的包会让"断连超时"重新计时）。
 *   照参考项目的做法（它的协议里 `Number.isSafeInteger(p.seq)` 是必填）。
 *
 * @param {{forward:number, turn:number, seq:number, at:number}} prev 上一份快照
 * @param {{forward?:number, turn?:number, seq?:number}|null} msg 手机发来的消息
 * @param {number} now 现在（毫秒）
 * @returns {{forward:number, turn:number, seq:number, at:number}} 新快照（不改 prev）
 */
export function applyRemote(prev, msg, now) {
  const clamp = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-1, Math.min(1, n));
  };
  const sid = typeof (msg && msg.sid) === 'string' ? msg.sid : null;
  const prevSid = typeof (prev && prev.sid) === 'string' ? prev.sid : null;
  // ★ 手机页刷新/被系统回收后重开 = 新会话：它的 seq 会从 0 重新数。
  //   不认这一下，后面的包全被当成"过期"永久丢弃（手柄从此失灵，要等 seq 追上）。
  //   老手机页没有 sid（null）→ 行为与以前完全一致（向后兼容）。
  const newSession = sid !== null && sid !== prevSid;
  const hasSeq = Number.isSafeInteger(msg && msg.seq) && msg.seq >= 0;
  const prevSeq = Number.isSafeInteger(prev && prev.seq) ? prev.seq : -1;
  if (hasSeq && !newSession && msg.seq <= prevSeq) return prev;   // 过期/重复：整包丢弃
  return {
    forward: clamp(msg && msg.forward),
    turn: clamp(msg && msg.turn),
    seq: hasSeq ? msg.seq : prevSeq,
    sid: sid ?? prevSid,
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

/**
 * 把「键盘的 0/1 跳变」与「手机/体感的连续信号」**分开**整形。
 *
 * ★ 为什么（这是"跟不跟手"的根因，也是"改一处坏别处"的典型）：
 *  原来的 140ms 一阶平滑是加在**合并之后**的 turn 上的 —— 它本来是为键盘
 *  0→1 的瞬变加的（真车打方向有过程），结果把体感一起糊了：
 *  倾斜手机 → 车轮转角滞后 140ms（50ms 才到 30%，420ms 才到 95%），
 *  而油门轴完全不平滑，两个轴时序还不一致。
 *  于是：动平滑 τ 会伤体感，动体感又会牵键盘 —— 正是用户说的"越改越乱"。
 *
 *  现在键盘单独平滑后再合并；手机/体感是连续量，原样进合并（它自己已有
 *  2° 死区 + 15~50° 满舵比例的整形）。
 *
 * @param {{keyTurn:number, keyTurnSmoothPrev:number, remote:object, now:number, dt:number, tau:number}} p
 * @returns {{keyTurnSmooth:number, turn:number}}
 */
export function shapeTurn({ keyTurn, keyTurnSmoothPrev, remote, now, dt, tau }) {
  const keyTurnSmooth = damp(
    Number.isFinite(keyTurnSmoothPrev) ? keyTurnSmoothPrev : 0,
    Number.isFinite(keyTurn) ? keyTurn : 0,
    tau, dt,
  );
  const merged = mergeInput({ forward: 0, turn: keyTurnSmooth }, remote, now);
  return { keyTurnSmooth, turn: merged.turn };
}

/**
 * 给「刚连上的游戏页」的首帧快照：**过期的必须清零**。
 *
 * 服务器会记住最后一次 POST 的值；手机锁屏/划掉之后那个值还留在服务器上
 * （可能是 minutes 前的 forward:1）。游戏页刷新时 SSE 首帧把它推过来，
 * 游戏侧用本地时钟重新盖章 → 当成新鲜输入 → 车自己往前冲最多 800ms。
 * 复现：手机按住油门 → 开飞行模式 → 刷新电脑上的游戏页。
 *
 * @param {{forward:number, turn:number, at:number}} ri
 * @param {number} now 现在（毫秒，与 ri.at 同一个时钟）
 * @param {number} [timeoutMs]
 */
export function freshSnapshotOrZero(ri, now, timeoutMs = REMOTE_TIMEOUT_MS) {
  if (remoteIsFresh(ri, now, timeoutMs)) return ri;
  return { forward: 0, turn: 0, seq: -1, sid: null, at: -Infinity };
}
