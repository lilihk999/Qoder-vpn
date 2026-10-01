'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFake } = require('./fake-mihomo');
const { ClashClient } = require('../server/clash-client');
const { createTransport } = require('../server/transport');

let seq = 0;
async function client(over = {}) {
  const fake = await startFake({
    pipeName: `qvp-t9-${(seq += 1)}`, port: 0, secret: 's3cret',
    ...over,
  });
  const tr = await createTransport({ secret: 's3cret', controller: { pipe: fake.pipeName, tcp: null } });
  return { fake, client: new ClashClient(tr) };
}

test('version 与 getConfigs 映射字段名', async () => {
  const { fake, client: c } = await client();
  assert.match((await c.version()).version, /^1\./);
  const cfg = await c.getConfigs();
  assert.equal(cfg.mode, 'rule');
  assert.equal(cfg.mixedPort, 7897);
  assert.equal(cfg.tunEnabled, false);
  assert.equal(c.channelKind, 'pipe');
  c.close(); await fake.close();
});

test('setConfigs 用 PATCH，PUT 会被真机静默吞掉（v1.19.25 实测）', async () => {
  const { fake, client: c } = await client();
  await c.setConfigs({ mode: 'global' });
  assert.equal(fake.state.mode, 'global');
  assert.ok(fake.hits.includes('PATCH /configs'), `hits=${fake.hits.join(',')}`);
  c.close(); await fake.close();
});

test('PUT /configs 在真机上回 204 但不改状态', async () => {
  const { fake, client: c } = await client();
  await c.request('PUT', '/configs', { body: { mode: 'global' }, expectEmpty: true });
  assert.equal((await c.getConfigs()).mode, 'rule', 'PUT 成功返回却没生效，正是真机行为');
  c.close(); await fake.close();
});

test('getProxies 只暴露策略组，输出不含 server/port/password/uuid', async () => {
  const { fake, client: c } = await client();
  const { groups, nodes } = await c.getProxies();
  assert.deepEqual(groups.map((g) => g.name).sort(), ['漏网之鱼', '节点选择'].sort());
  assert.ok(nodes.includes('HK 3 | v4'));
  assert.ok(!nodes.includes('DIRECT'), '内置策略不进 nodes');
  assert.ok(!nodes.includes('节点选择'), '组名不进 nodes');
  assert.equal(new Set(nodes).size, nodes.length, 'nodes 去重');
  assert.doesNotMatch(JSON.stringify(groups), /server|"port"|password|uuid/i);
  c.close(); await fake.close();
});

test('select 切换后回读确认', async () => {
  const { fake, client: c } = await client();
  assert.deepEqual(await c.select('节点选择', 'JP 1 | v3'), { group: '节点选择', now: 'JP 1 | v3' });
  c.close(); await fake.close();
});

test('select 不存在的 target 抛 ApiError 而不是假装成功', async () => {
  const { fake, client: c } = await client();
  await assert.rejects(c.select('节点选择', '不存在的节点'), (e) => e.name === 'ApiError');
  await assert.rejects(c.select('不存在的组', 'HK 3 | v4'), (e) => e.kind === 'malformed_config');
  c.close(); await fake.close();
});

test('HTTP 404 是"名称/路径不对"，不能算通道故障', async () => {
  // 真机 2026-10-01 实测：核心可达（running:true）时 proxy_select 传不存在的组，
  // 仍回 kind=channel_unavailable；而 skill 对 channel_unavailable 的动作是"先 proxy_core_start"，
  // 于是打错节点名会把调用方支去重启核心。404 归 malformed_config，hint 仍要给出核对名字的办法。
  const { fake, client: c } = await client();
  const e = await c.select('不存在的组', 'HK 3 | v4').then(() => null, (err) => err);
  assert.equal(e.kind, 'malformed_config');
  assert.match(e.hint, /proxy_nodes/);
  assert.doesNotMatch(e.message, /password|uuid/i, '错误消息里不带节点秘密字段');
  c.close(); await fake.close();
});

test('delay 正常节点回数字，dead-node 抛 timeout', async () => {
  const { fake, client: c } = await client();
  assert.equal(typeof (await c.delay('HK 3 | v4')), 'number');
  await assert.rejects(c.delay('dead-node'), (e) => e.kind === 'timeout');
  c.close(); await fake.close();
});

test('delay 把 url 与 timeout 放进 query', async () => {
  const { fake, client: c } = await client();
  await c.delay('HK 3 | v4', { url: 'https://cp.cloudflare.com/generate_204', timeoutMs: 4321 });
  assert.ok(
    fake.hits.some((h) => /delay\?url=https%3A%2F%2Fcp\.cloudflare\.com%2Fgenerate_204&timeout=4321$/.test(h)),
    fake.hits.join(' | ')
  );
  c.close(); await fake.close();
});

test('reload 在真机上不存在（POST /configs/reload -> 404），closeConnections 走 DELETE', async () => {
  const { fake, client: c } = await client();
  await assert.rejects(() => c.reload({ proxyProviders: true }), /404/);
  assert.equal(fake.state.reloadCount, 1, '请求确实发出去了，是核心没这个端点');
  await c.closeConnections();
  assert.ok(fake.hits.includes('DELETE /connections'));
  assert.ok(!fake.hits.includes('GET /traffic'), '不订阅流式端点，否则会挂住请求');
  assert.deepEqual(await c.connections(), { total: 0, uplink: 0, downlink: 0, connections: [] });
  c.close(); await fake.close();
});

test('401 在客户端层转成 auth_failed', async () => {
  const fake = await startFake({ pipeName: 'qvp-t9-secret-mismatch', port: 0, secret: 'right' });
  const { TcpTransport } = require('../server/transport');
  await fake.setTcpEnabled(true);
  const c = new ClashClient(new TcpTransport({ host: '127.0.0.1', port: fake.port, secret: 'wrong' }));
  await assert.rejects(c.getConfigs(), (e) => e.kind === 'auth_failed');
  c.close(); await fake.close();
});
