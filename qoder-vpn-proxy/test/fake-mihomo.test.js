'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startFake } = require('./fake-mihomo');

const get = (opts) => new Promise((res, rej) => {
  const r = http.request(opts, (rr) => { let b = ''; rr.setEncoding('utf8'); rr.on('data', (c) => (b += c)); rr.on('end', () => res({ status: rr.statusCode, body: b })); });
  r.on('error', rej); r.end();
});

test('管道可通、TCP 默认关', async () => {
  const fake = await startFake({ pipeName: 'qoder-vpn-proxy-selftest-a', port: 0, secret: 's3cret' });
  const viaPipe = await get({ socketPath: fake.pipeName, path: '/version', headers: { Host: 'localhost', Authorization: 'Bearer s3cret' } });
  assert.equal(viaPipe.status, 200);
  assert.match(viaPipe.body, /meta/);
  await assert.rejects(get({ host: '127.0.0.1', port: fake.port, path: '/version' }), /ECONNREFUSED/);
  fake.setTcpEnabled(true);
  const viaTcp = await get({ host: '127.0.0.1', port: fake.port, path: '/version', headers: { Authorization: 'Bearer s3cret' } });
  assert.equal(viaTcp.status, 200);
  await fake.close();
});

test('密钥不符返回 401；切换节点写回 state', async () => {
  const fake = await startFake({ pipeName: 'qoder-vpn-proxy-selftest-b', port: 0, secret: 'right' });
  const bad = await get({ socketPath: fake.pipeName, path: '/version', headers: { Host: 'localhost', Authorization: 'Bearer wrong' } });
  assert.equal(bad.status, 401);
  // 组名是中文：Node 的 ClientRequest 拒绝未转义字符，必须 encodeURIComponent，
  // 真实 mihomo 也收编码后的路径 —— Task 9 的客户端同样要这么做。
  const putPath = '/proxies/' + encodeURIComponent('节点选择');
  await new Promise((res, rej) => {
    const r = http.request({ socketPath: fake.pipeName, path: putPath, method: 'PUT', headers: { Host: 'localhost', Authorization: 'Bearer right', 'Content-Type': 'application/json' } }, (rr) => { rr.resume(); rr.on('end', res); });
    r.on('error', rej);
    r.end(JSON.stringify({ target: 'HK 3 | v4' }));
  });
  assert.equal(fake.state.proxies['节点选择'].now, 'HK 3 | v4');
  const readBack = await get({ socketPath: fake.pipeName, path: putPath, headers: { Host: 'localhost', Authorization: 'Bearer right' } });
  assert.equal(readBack.status, 200);
  assert.match(readBack.body, /HK 3 \| v4/);
  await fake.close();
});

test('dead-node 测速返回 503', async () => {
  const fake = await startFake({ pipeName: 'qoder-vpn-proxy-selftest-c', port: 0, secret: 'x' });
  const r = await get({ socketPath: fake.pipeName, path: '/proxies/dead-node/delay?url=http%3A%2F%2Fwww.gstatic.com&timeout=5000', headers: { Host: 'localhost', Authorization: 'Bearer x' } });
  assert.equal(r.status, 503);
  await fake.close();
});
