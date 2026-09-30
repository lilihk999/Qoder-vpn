'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildProxyEnv, inlinePrefix } = require('../server/env');

test('端口来自入参而非硬编码', () => {
  const e = buildProxyEnv({ mixedPort: 7890, socksPort: 7891 });
  assert.equal(e.proxyUrl, 'http://127.0.0.1:7890');
  assert.equal(e.vars.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(e.vars.ALL_PROXY, 'socks5://127.0.0.1:7890');
});

test('NO_PROXY 恒含 loopback 且不含 CIDR', () => {
  const e = buildProxyEnv({ mixedPort: 7897, socksPort: 7898, noProxyExtra: ['*.corp.example'] });
  const parts = e.vars.NO_PROXY.split(',');
  assert.ok(parts.includes('127.0.0.1') && parts.includes('localhost') && parts.includes('::1'));
  assert.ok(parts.includes('*.corp.example'));
  assert.doesNotMatch(e.vars.NO_PROXY, /\/\d+/);
});

test('git 用域名前缀代理而不是全局 http.proxy', () => {
  const e = buildProxyEnv({ mixedPort: 7897, socksPort: 7898 });
  assert.ok(e.git.some((l) => l.includes('http.https://github.com/.proxy')));
  assert.ok(!e.git.some((l) => /(^| )http\.proxy/.test(l)), '不允许全局 http.proxy');
  // 必须带尾斜杠：无斜杠的 http.https://github.com 会被 https://github.com.evil.example 前缀匹配到
  assert.ok(!e.git.some((l) => /http\.https:\/\/github\.com\.proxy/.test(l)), '不能漏掉 URL 与 key 之间的斜杠');
});

test('npm 片段含 registry 与 noproxy', () => {
  const e = buildProxyEnv({ mixedPort: 7897, socksPort: 7898 });
  assert.ok(e.npm.some((l) => l.startsWith('https-proxy=')));
  assert.ok(e.npm.some((l) => l.startsWith('noproxy=')));
});

test('shell 片段是可直接 export 的形式', () => {
  const e = buildProxyEnv({ mixedPort: 7897, socksPort: 7898 });
  assert.deepEqual(e.shell, [
    'export HTTP_PROXY=http://127.0.0.1:7897',
    'export HTTPS_PROXY=http://127.0.0.1:7897',
    'export ALL_PROXY=socks5://127.0.0.1:7897',
    `export NO_PROXY="${e.vars.NO_PROXY}"`,
  ]);
  assert.equal(inlinePrefix(e), 'HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=' + JSON.stringify(e.vars.NO_PROXY));
});
