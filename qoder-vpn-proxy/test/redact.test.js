'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactText, maskSubscriptionUrl, urlFingerprint } = require('../server/redact');

test('带 token 的链接不再有一条"只红 token"的退路', () => {
  // redactUrl（只掩 token、留域名与路径）曾在 diagnose 与订阅层用着；契约升级后它
  // 是纯粹的危险面 —— 留着就一定有人拿去输出订阅地址，所以删掉而不是留着"备用"。
  assert.equal(require('../server/redact').redactUrl, undefined);
  assert.doesNotMatch(redactText('https://sub.example.invalid/SUBPATH?token=abc'), /sub\.example\.invalid/);
});

test('redactText 抹掉 token 型 query', () => {
  assert.match(redactText('拉取失败 ?token=abc123 状态 500'), /\?token=<redacted>/);
  assert.doesNotMatch(redactText('?token=abc123'), /abc123/);
});

test('maskSubscriptionUrl 抹掉主机名与路径段，只留结构', () => {
  const out = maskSubscriptionUrl('https://sub.example.invalid/SUBPATH?token=0123456789abcdef0123456789abcdef');
  assert.equal(out, 'https://<masked-host>/<masked-path>?<masked-query>');
  assert.doesNotMatch(out, /sub\.example\.invalid|SUBPATH|0123456789abcdef/);
});

test('maskSubscriptionUrl 无 query 时也抹主机与路径', () => {
  assert.equal(maskSubscriptionUrl('https://sub.example.invalid/SUBPATH'), 'https://<masked-host>/<masked-path>');
});

test('maskSubscriptionUrl 解析不了就整条替换，绝不回显原文', () => {
  assert.equal(maskSubscriptionUrl('not a url at all'), '<masked-url>');
  assert.equal(maskSubscriptionUrl(undefined), '');
  assert.equal(maskSubscriptionUrl(null), '');
  assert.equal(maskSubscriptionUrl(42), '');
  // 畸形但可解析的输入：结构标记怎么排是次要的，硬要求是一个字的原文都不出来
  const weird = maskSubscriptionUrl('https:///SUBPATH?token=x');
  assert.doesNotMatch(weird, /SUBPATH|token=x/, `回显了原文：${weird}`);
  assert.match(weird, /^https:\/\//);
});

test('urlFingerprint 稳定、token 不参与、不同机场不同值', () => {
  const a = urlFingerprint('https://sub.example.invalid/SUBPATH?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const b = urlFingerprint('https://sub.example.invalid/SUBPATH?token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const c = urlFingerprint('https://other.example.invalid/SUBPATH');
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.equal(a, b, '同一链接换 token 前后必须同指纹，否则用户无法确认"是不是同一家"');
  assert.notEqual(a, c);
});

test('urlFingerprint 对不可解析的输入给 null，不抛', () => {
  assert.equal(urlFingerprint('不是链接'), null);
  assert.equal(urlFingerprint(undefined), null);
});

test('redactText 把带 token 参数的订阅链接整条抹掉（含主机名）', () => {
  const out = redactText('抓取 https://sub.example.invalid/SUBPATH?token=0123456789abcdef0123456789abcdef 失败');
  assert.doesNotMatch(out, /sub\.example\.invalid|SUBPATH|0123456789abcdef/);
  assert.match(out, /<masked-host>/);
});

test('redactText 把路径首段是 16-24 位字母数字的链接整条抹掉', () => {
  const out = redactText('访问 https://panel.example.invalid/AbCdEfGhIjKlMnOpQr 返回 403');
  assert.doesNotMatch(out, /panel\.example\.invalid|AbCdEfGhIjKlMnOpQr/);
});

test('redactText 不动公共探测地址（形状不像订阅）', () => {
  const urls = [
    'https://raw.githubusercontent.com/a/b/main/x.js',
    'https://pypi.org/simple/',
    'https://www.gstatic.com/generate_204',
    'https://cp.cloudflare.com/',
    'https://objects.githubusercontent.com/foo/bar/baz/qux/quux/corge/grault',
  ];
  for (const u of urls) assert.equal(redactText(`探测 ${u} 超时`), `探测 ${u} 超时`, `${u} 不该被误抹`);
});

test('redactText 抹掉节点 URL', () => {
  const s = 'ss://YWVzLWc4LXBvbHk6cHc@1.2.3.4:8388#HK 和 vmess://eyJhZG0iOiIxQDEuMi4zLjQifQ==#JP';
  const out = redactText(s);
  assert.doesNotMatch(out, /1\.2\.3\.4/);
  assert.equal((out.match(/<node-url-redacted>/g) || []).length, 2);
});

test('redactText 抹掉 yaml 中的 server/password/uuid', () => {
  const y = '  - name: HK1\n    server: 9.9.9.9\n    port: 443\n    password: sekret\n    uuid: 11112222-3333';
  const out = redactText(y);
  assert.doesNotMatch(out, /9\.9\.9\.9|sekret|11112222/);
  assert.match(out, /name: HK1/);
});

test('redactText 对 undefined 与数字安全', () => {
  assert.equal(redactText(undefined), '');
  assert.equal(redactText(42), '42');
});
