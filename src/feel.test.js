// ============================================================================
//  feel.test.js —— 速度感调参口的测试
//  运行：npm test
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feel, installFeel, DEFAULTS, PUNCHY } from './feel.js';


test('默认值本身：臂长必须随速度**收近**（负），不是拉远', () => {
  // 参考项目实测并写下：臂长变长「与速度感相反」；眼睛读速度靠画面边缘的光流，
  // 而"相机靠近掠过的物体"会提升它。所以出厂值就该是负的。
  assert.ok(DEFAULTS.armDistSpeed < 0, `出厂臂长增益应该为负，实际 ${DEFAULTS.armDistSpeed}`);
  assert.ok(PUNCHY.armDistSpeed < 0, `"猛"预设的臂长增益也应该为负`);
  assert.ok(PUNCHY.armDistSpeed < DEFAULTS.armDistSpeed, '"猛"应该收得更近');
  assert.ok(PUNCHY.fovSpeed > DEFAULTS.fovSpeed, '"猛"应该视野开得更大');
});

test('installFeel：挂到 host 上，读属性是当前值，写属性下一帧生效', () => {
  const host = {};
  const api = installFeel(host);
  assert.equal(host.__feel, api, '应该挂到 host.__feel');
  assert.equal(api.fovSpeed, feel.fovSpeed, '读到的应该是当前值');

  api.fovSpeed = 42;
  assert.equal(feel.fovSpeed, 42, '写调参口应该直接改到 feel 对象上（main.js 每帧读它）');

  api.reset();
  assert.equal(feel.fovSpeed, DEFAULTS.fovSpeed, 'reset 之后应该回出厂值');
});

test('installFeel：punchy 一键切"猛"，show 返回 JSON 便于贴回代码', () => {
  const api = installFeel({});
  api.punchy();
  assert.equal(feel.fovSpeed, PUNCHY.fovSpeed);
  assert.equal(feel.armDistSpeed, PUNCHY.armDistSpeed);

  const shown = api.show();
  assert.equal(typeof shown, 'string');
  assert.deepEqual(JSON.parse(shown), { ...feel }, 'show 的输出应该等于当前值');

  api.reset();
  assert.deepEqual({ ...feel }, { ...DEFAULTS });
});

test('installFeel：host 不可用时返回 undefined，不抛异常', () => {
  assert.equal(installFeel(null), undefined);
});
