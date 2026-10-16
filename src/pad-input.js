// ============================================================================
//  pad-input.js —— 手机手柄「哪个触点按着哪个键」→「这一帧的输入」
//
//  ★ 为什么把它单独抽出来（真踩过的坑）：
//  这段逻辑原来内联在 phone/index.html 里，我用 `触点id:动作名` 当 Map 的键，
//  读的时候却拿 `k === 'forward'` 去比 —— 永远匹配不上，于是不管怎么按，
//  发出去的都是 {forward:0, turn:0}。症状是"按钮能看到、车不动"。
//  浏览器里没有测试，语法检查也查不出这种错。
//  抽成纯模块 + 单元测试，这类错就会在 `npm test` 阶段被拦住。
//
//  结构照参考项目（phone/controls.mjs）：**Map 的键是"触点"，值是"动作名"**，
//  判断某个动作在不在按，看的是 values。这样同一个动作被两个手指按住时，
//  松开其中一个不会误判成松手（它专门处理了"重复肩键"这种情况）。
// ============================================================================

/** 每个按钮代表什么动作。极性固定写在动作里，按钮只管自己的名字 */
export const PAD_ACTIONS = {
  accel: { forward: 1 },     // 油门
  brake: { forward: -1 },    // 刹车 / 倒车
  left: { turn: 1 },         // 左（我们的 turn:+1 是左转）
  right: { turn: -1 },       // 右
};

/** 一次手柄会话的状态：contacts = Map<触点id, 动作名> */
export function createPadState() {
  return { contacts: new Map() };
}

/**
 * 某个触点按下了某个动作。
 * @param {{contacts:Map}} pad
 * @param {string|number} contact 触点 id（PointerEvent.pointerId）
 * @param {string} action 动作名（PAD_ACTIONS 的键）
 */
export function pressAction(pad, contact, action) {
  if (!Object.prototype.hasOwnProperty.call(PAD_ACTIONS, action)) return pad; // 未知动作忽略
  pad.contacts.set(contact, action);
  return pad;
}

/** 某个触点松开了（不管它当时按的是哪个动作） */
export function releaseContact(pad, contact) {
  pad.contacts.delete(contact);
  return pad;
}

/** 全部松开（切后台、失焦、出错时走它） */
export function releaseAll(pad) {
  pad.contacts.clear();
  return pad;
}

/** 这个动作现在有没有被按着（可能有多个触点在按同一个动作） */
export function isHeld(pad, action) {
  for (const a of pad.contacts.values()) if (a === action) return true;
  return false;
}

/**
 * 把「按钮转向」和「体感转向」合成一路。
 *
 * 规则：**按钮按着就听按钮**（手动优先），否则听体感。
 * 为什么不是相加：体感和按钮同时有效时相加会变得极难控制（轻轻一歪 + 按住方向 = 满舵打死），
 * 而玩家按住方向键时，他显然想要一个明确的、不受握姿影响的转向。
 */
export function mergeTurn(padTurn, tiltTurn) {
  const p = Number(padTurn) || 0;
  if (p !== 0) return Math.max(-1, Math.min(1, p));
  const t = Number(tiltTurn) || 0;
  return Math.max(-1, Math.min(1, t));
}

/**
 * 把当前按着的所有动作合成这一帧的输入。
 * 同向叠加、反向抵消，最后钳到 [-1,1]（turn 超范围会让前轮打死）。
 */
export function padInput(pad) {
  let forward = 0;
  let turn = 0;
  for (const action of pad.contacts.values()) {
    const d = PAD_ACTIONS[action];
    if (!d) continue;
    forward += d.forward || 0;
    turn += d.turn || 0;
  }
  const clamp = (x) => Math.max(-1, Math.min(1, x));
  return { forward: clamp(forward), turn: clamp(turn) };
}
