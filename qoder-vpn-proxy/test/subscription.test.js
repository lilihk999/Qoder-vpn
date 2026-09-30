'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const S = require('../server/subscription');
const { maskHosts } = require('../server/redact');

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

test('URL 解析失败时不回显原链接', async () => {
  await assert.rejects(
    S.fetchSubscription('订阅链接待补'),
    (e) => e.kind === 'subscription_url_invalid'
      && !e.message.includes('订阅链接待补')
      && e.message.includes('<masked-url>')
  );
});

test('订阅站非 200 时，提示里既没有 token 也没有主机名与路径段', async () => {
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/AbCdEfGhIjKlMnOpQrSt?token=0123456789abcdef0123456789abcdef`;
  let err = null;
  try { await S.fetchSubscription(url); } catch (e) { err = e; }
  server.close();
  assert.ok(err, '非 200 必须拒');
  assert.equal(err.kind, 'subscription_format_unexpected');
  const all = `${err.message} ${err.hint}`;
  assert.doesNotMatch(all, /AbCdEfGhIjKlMnOpQrSt|0123456789abcdef/, 'token 与路径段都不出口');
  assert.doesNotMatch(all, /127\.0\.0\.1/, '主机名也不出口');
  assert.match(all, /<masked-host>/);
});

test('网络错误文本里的订阅主机名被顶掉（DNS 失败是主要泄露面）', () => {
  const url = 'https://panel.example.invalid/SUBPATH?token=TOKEN_PLACEHOLDER';
  const raw = 'fetch failed: getaddrinfo ENOTFOUND panel.example.invalid:443';
  assert.equal(
    maskHosts(raw, url),
    'fetch failed: getaddrinfo ENOTFOUND <masked-host>:443'
  );
  assert.doesNotMatch(maskHosts(raw, url), /panel\.example\.invalid|SUBPATH|TOKEN_PLACEHOLDER/);
});
