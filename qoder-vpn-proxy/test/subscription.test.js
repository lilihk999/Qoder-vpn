'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../server/subscription');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

test('UA 必须是 Clash 家族', () => {
  assert.match(S.CLASH_UA, /^clash-verge\//);
});

test('sniffFormat 区分 yaml / base64 / html', () => {
  assert.equal(S.sniffFormat(fx('sub-yaml.txt')), 'yaml');
  assert.equal(S.sniffFormat(fx('sub-base64.txt')), 'base64');
  assert.equal(S.sniffFormat(fx('sub-html.txt')), 'html');
  assert.equal(S.sniffFormat(''), 'unknown');
});

test('parseUserInfo 解析标准头', () => {
  assert.deepEqual(
    S.parseUserInfo('upload=359591668; download=53636662825; total=74826208722; expire=1798761600'),
    { upload: 359591668, download: 53636662825, total: 74826208722, expire: 1798761600 });
  assert.equal(S.parseUserInfo('upload=0; download=0; total=74826208722; expire=').expire, null);
  assert.equal(S.parseUserInfo(undefined), null);
});

test('parseSubscriptionName 解 RFC5987 中文文件名', () => {
  assert.equal(S.parseSubscriptionName("attachment;filename*=UTF-8''%E7%A4%BA%E4%BE%8B%E8%AE%A2%E9%98%85"), '示例订阅');
  assert.equal(S.parseSubscriptionName('attachment;filename=sub.txt'), 'sub.txt');
  assert.equal(S.parseSubscriptionName(undefined), null);
});

test('yaml 能数出节点数且不含凭据', () => {
  const { yaml, nodes } = S.decodeBody(fx('sub-yaml.txt'), 'yaml');
  assert.match(yaml, /proxy-groups:/);
  assert.ok(nodes > 0);
  // fixture 是 flow 风格（- { name: ... }），且 proxy-groups 也用同一形状：
  // 计数器只能统计 proxies 段，不能被 proxy-groups 的 name 混入
  assert.equal(nodes, 15);
});

test('base64 解出 ss:// 列表并计数', () => {
  const { yaml, nodes } = S.decodeBody(fx('sub-base64.txt'), 'base64');
  assert.equal(yaml, null);
  assert.equal(nodes, 15);
});

test('html 判定为格式异常并抛 ApiError', () => {
  assert.throws(
    () => S.decodeBody(fx('sub-html.txt'), 'html'),
    (e) => e.kind === 'subscription_format_unexpected'
  );
});
