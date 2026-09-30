'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startFake } = require('./fake-mihomo');
const T = require('../server/transport');

const rt = (fake, over = {}) => ({
  secret: 's3cret',
  controller: { pipe: fake.pipeName, tcp: `127.0.0.1:${fake.port}` },
  ...over,
});

test('parseTarget 处理标准与异常形态', () => {
  assert.deepEqual(T.parseTarget('127.0.0.1:9097'), { host: '127.0.0.1', port: 9097 });
  assert.deepEqual(T.parseTarget('[::1]:8080'), { host: '::1', port: 8080 });
  assert.equal(T.parseTarget(''), null);
  assert.equal(T.parseTarget('127.0.0.1'), null);
  assert.equal(T.parseTarget('127.0.0.1:0'), null);
  assert.equal(T.parseTarget('127.0.0.1:70000'), null);
});

test('管道优先于 TCP', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-a', port: 0, secret: 's3cret', tcpEnabled: true });
  const tr = await T.createTransport(rt(fake));
  assert.equal(tr.kind, 'pipe');
  const res = await tr.request('GET', '/version');
  assert.equal(res.status, 200);
  assert.match(res.text, /1\.19\.0/);
  tr.close();
  await fake.close();
});

test('TCP 兜底：runtime 无管道时用 TCP', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-b', port: 0, secret: 's3cret', tcpEnabled: true });
  const tr = await T.createTransport(rt(fake, { controller: { pipe: null, tcp: `127.0.0.1:${fake.port}` } }));
  assert.equal(tr.kind, 'tcp');
  assert.equal((await tr.request('GET', '/version')).status, 200);
  tr.close();
  await fake.close();
});

test('非 2xx 不抛异常，只回状态码', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-c', port: 0, secret: 's3cret' });
  const tr = await T.createTransport(rt(fake));
  const res = await tr.request('GET', '/proxies/%E4%B8%8D%E5%AD%98%E5%9C%A8');
  assert.equal(res.status, 404);
  assert.match(res.text, /not found/);
  tr.close();
  await fake.close();
});

test('两条通道都不通 -> channel_unavailable，消息含两次尝试原因', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-d', port: 0, secret: 's3cret', tcpEnabled: true });
  const deadPort = fake.port;
  await fake.close();
  await assert.rejects(
    T.createTransport(
      {
        secret: 's3cret',
        controller: { pipe: '\\\\.\\pipe\\qvp-does-not-exist', tcp: `127.0.0.1:${deadPort}` },
        channelHint: '开外部控制',
      },
      { timeoutMs: 1500 }
    ),
    (e) => e.kind === 'channel_unavailable' && /pipe/.test(e.message) && /tcp/i.test(e.message) && e.hint === '开外部控制'
  );
});

test('secret 不符 -> auth_failed 而不是 channel_unavailable', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-e', port: 0, secret: 'right' });
  await assert.rejects(T.createTransport(rt(fake, { secret: 'wrong' })), (e) => e.kind === 'auth_failed');
  await fake.close();
});

test('控制器挂起 -> timeout', async () => {
  const hang = net.createServer((sock) => { sock.on('data', () => {}); });
  await new Promise((res) => hang.listen(0, '127.0.0.1', res));
  const port = hang.address().port;
  const tr = new T.TcpTransport({ host: '127.0.0.1', port, secret: 'x', timeoutMs: 300 });
  await assert.rejects(tr.request('GET', '/version'), (e) => e.kind === 'timeout');
  tr.close();
  await new Promise((res) => hang.close(res));
});

test('PUT 带对象 body 时自动序列化并写回 state', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-f', port: 0, secret: 's3cret' });
  const tr = await T.createTransport(rt(fake));
  const res = await tr.request('PUT', '/proxies/节点选择', { body: { target: 'HK 3 | v4' } });
  assert.equal(res.status, 204);
  assert.equal(fake.state.proxies['节点选择'].now, 'HK 3 | v4');
  tr.close();
  await fake.close();
});
