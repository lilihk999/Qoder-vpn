'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactText, redactUrl } = require('../server/redact');

test('redactUrl 抹掉 token 但保留域名与路径', () => {
  const out = redactUrl('https://sub.example.invalid/SUBPATH?token=0123456789abcdef0123456789abcdef');
  assert.equal(out, 'https://sub.example.invalid/SUBPATH?token=<redacted>');
});

test('redactText 抹掉 token 型 query', () => {
  assert.match(redactText('拉取失败 ?token=abc123 状态 500'), /\?token=<redacted>/);
  assert.doesNotMatch(redactText('?token=abc123'), /abc123/);
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
