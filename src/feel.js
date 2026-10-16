// ============================================================================
//  feel.js —— 「速度感」现场调参口（照参考项目 kart-royale/src/core/Feel.ts）
//
//  参考项目为什么做这个东西，原文：
//    「把测量出来的数字当作手感来猜是不对的，所以这个东西是拿来**开**的：
//      改一个值，继续玩，相机下一帧就跟着变。」
//  它的用法：  __feel.punchy() / __feel.reset() / __feel.set({...}) / __feel.show()
//
//  我们用户的原话是「我一个人优化手感非常麻烦」——问题从来不是参数多，
//  而是**改一次要改代码、刷新、再试**。这个口子把它变成「边开边调」。
//
//  分层说明：本文件只负责「存参数 + 暴露给浏览器控制台」。
//  真正的计算仍然在 kart-math.js 的纯函数里（可测）。
//  为了可测，installFeel 的目标对象是**注入**的，测试里传一个假对象就行。
// ============================================================================

/** 出厂默认值 —— 改这里的数就是改游戏的手感基线 */
export const DEFAULTS = {
  fovSpeed: 10,         // 静止→全速，垂直视野多开多少度
  armDistSpeed: -0.9,   // 全速时臂长变化（米）。★ 负 = 相机收近 ★
  leadDeadDeg: 10,      // 构图死区：滞后小于它，画面完全不动
  leadFullDeg: 20,      // 滞后大于它，构图满额
  frameLagCancel: 0.72, // 抵消多少比例的方位角滞后
  frameXMax: 0.30,      // 横向构图硬上限（NDC）
};

/**
 * 「猛」预设 —— 照参考项目的 PUNCHY。
 *
 * 它为什么这样才更"快"（原文，参考项目实测）：
 *   直线全油门只让视野开了 6.5°，而臂长反而变长了 —— **两者都在对抗速度感**。
 *   眼睛读速度靠的是**画面边缘的光流**，它在这三件事发生时上升：
 *   ① 镜头变广  ② 相机降低  ③ 相机**靠近**掠过的物体。
 * 所以"猛"= 视野大开 + 臂长收近（负）+ 相机更低。
 */
export const PUNCHY = {
  fovSpeed: 16,
  armDistSpeed: -1.4,
  leadDeadDeg: 14,
  leadFullDeg: 22,
  frameLagCancel: 0.72,
  frameXMax: 0.30,
};

/** 当前生效的参数（可变）。main.js 每帧读它，所以改了下一帧就生效。 */
export const feel = { ...DEFAULTS };

/**
 * 把调参口挂到 `host.__feel` 上。
 * 读属性返回当前值；写属性直接改 `feel`，下一帧就生效。
 *
 * @param {object} [host] 挂载目标。默认浏览器里的 `window`；测试里传假对象。
 * @returns 调参口对象（host 不可用时返回 undefined）
 */
export function installFeel(host) {
  const root = host ?? (typeof window !== 'undefined' ? window : undefined);
  if (!root) return undefined;

  const api = {
    ...feel,
    punchy() { Object.assign(feel, PUNCHY); return api.show(); },
    reset() { Object.assign(feel, DEFAULTS); return api.show(); },
    set(patch) { Object.assign(feel, patch); return api.show(); },
    show() { return JSON.stringify(feel); },
  };

  // 实时视图：读 __feel.fovSpeed 显示当前值，写它下一帧生效。
  for (const key of Object.keys(DEFAULTS)) {
    Object.defineProperty(api, key, {
      get: () => feel[key],
      set: (v) => { feel[key] = v; },
      enumerable: true,
    });
  }

  root.__feel = api;
  if (typeof console !== 'undefined' && console.info) {
    console.info(
      '%c[feel] 速度感调参已就绪：__feel.punchy() 切"猛"，__feel.show() 打印当前值',
      'color:#8ab4ff',
    );
  }
  return api;
}
