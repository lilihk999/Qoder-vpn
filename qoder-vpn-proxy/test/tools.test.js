'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildTools, callTool, TOOL_NAMES } = require('../server/tools');
const { ApiError } = require('../server/envelope');
const { startFake } = require('./fake-mihomo');
const { createTransport } = require('../server/transport');
const { ClashClient } = require('../server/clash-client');
const { SubscriptionRepo } = require('../server/subscriptions');
const store = require('../server/store');

const RUNTIME = {
  installed: true, running: true, configDir: '/tmp/cvr', configSource: 'config.yaml',
  installDir: '/tmp/inst', exePath: '/tmp/inst/clash-verge.exe', corePath: '/tmp/inst/verge-mihomo.exe',
  ports: { mixed: 7897, socks: 7898, http: 7899 },
  controller: { pipe: '\\\\.\\pipe\\verge-mihomo', tcp: null, tcpConfigured: '127.0.0.1:9097', tcpEnabled: false },
  secret: 'set-your-secret',
  settings: { enableExternalController: false, enableSystemProxy: false, enableTunMode: false, mixedPort: 7897, socksPort: 7898, httpPort: 7899, systemProxyBypass: null },
  profiles: { current: 'Rq14DVii2DNo', items: [{ uid: 'Rq14DVii2DNo', type: 'remote', name: '测试订阅', file: 'Rq14DVii2DNo.yaml', url: 'https://x.test/s?token=T', updated: 1 }] },
  warnings: [],
  // 与 discovery.js 未安装分支的 channelHint 同源（discovery.test.js 断言它含"安装"）：
  // 假 runtime 塞一个 'hint' 占位，下面"未安装要给安装指引"那条就只是在测占位符。
  channelHint: '未检测到 Clash Verge Rev。请安装到默认目录 C:\\Program Files\\Clash Verge，或设置 QVP_INSTALL_DIR 指向安装目录、QVP_CONFIG_DIR 指向配置目录',
};

// 假件必须和真模块一样拒收非法 url：真 SubscriptionRepo.add 第一行就是 isUrl 校验，
// 假件若来者不拒，"校验失败不能已经调过底层"这条测试就是在测一个不存在的实现。
const httpUrl = (u) => /^https?:\/\/[^/?#\s]+\.[^/?#\s]/i.test(String(u || ''));

function fakeDeps(over = {}) {
  const calls = [];
  const client = {
    channelKind: 'pipe',
    getConfigs: async () => ({ mode: 'rule', mixedPort: 7897, tunEnabled: false, socksPort: 7898, port: 7899, externalController: '' }),
    getProxies: async () => ({ groups: [{ name: '节点选择', type: 'Selector', now: 'HK 3 | v4', all: ['HK 3 | v4', 'JP 1 | v3', 'dead-node'], history: [] }], nodes: ['HK 3 | v4', 'JP 1 | v3', 'dead-node'] }),
    select: async (g, t) => ({ group: g, now: t }),
    setConfigs: async (p) => p,
    // 真 delay 在 HTTP 503 时抛 ApiError('timeout')，假件也必须抛 ApiError，
    // 否则 proxy_test 里的 per-node kind 分类根本没被 exercised（只断言 ok:false 看不出来）。
    delay: async (n) => { if (n === 'dead-node') throw new ApiError('timeout', '测速 dead-node 失败: HTTP 503', '该节点不可达或超时，可跳过它换下一个'); return n.length * 10; },
    reload: async () => ({ reloaded: true }),
    version: async () => ({ version: '1.19.0' }),
    close() {},
  };
  const repo = {
    list: async () => [{ uid: 'Rq14DVii2DNo', name: '测试订阅', url: 'https://x.test/s?token=<redacted>', active: true, type: 'remote', nodes: 40, userInfo: { total: 1, upload: 1, download: 1, expire: null }, updated: 1, remark: '', source: 'cvr' }],
    add: async ({ url }) => {
      if (!httpUrl(url)) throw new ApiError('subscription_url_invalid', '订阅地址必须是完整的 http(s) 链接', '示例：https://机场域名/路径?token=xxx');
      calls.push(['add', url]);
      return { uid: 'AAAAAAAAAAAA', url: 'https://x.test/s?token=<redacted>', name: '新' };
    },
    edit: async (uid, p) => {
      if (p.url !== undefined && !httpUrl(p.url)) throw new ApiError('subscription_url_invalid', '订阅地址必须是完整的 http(s) 链接', '');
      calls.push(['edit', uid, p]);
      return { uid, url: 'https://x.test/s?token=<redacted>' };
    },
    update: async (uid) => ({ uid, nodes: 41 }),
    updateAll: async () => ({ results: [{ uid: 'Rq14DVii2DNo', ok: true }] }),
    activate: async (uid) => ({ current: uid, groups: [] }),
    remove: async () => ({ removed: 'Rq14DVii2DNo', trashed: ['Rq14DVii2DNo.yaml'] }),
  };
  // start 的返回值必须含 backups：真 CvrConfig.start 一定返回它，漏了就会让
  // proxy_core_start 的 r.backups.map 只在测试里炸（Task 13 假 git runner 的同款错误）。
  const cvr = { start: async (o) => { calls.push(['start', o]); return { scope: o.scope, systemProxySuppressed: o.scope === 'session', channel: { kind: 'pipe', ports: RUNTIME.ports }, ports: RUNTIME.ports, waitedMs: 1200, backups: [{ name: 'verge.yaml', ts: '20260930-1', backupPath: '/tmp/b', skipped: false }, { name: 'profiles.yaml', ts: '20260930-1', skipped: true }] }; }, stop: async (o) => ({ killed: ['clash-verge.exe'], restored: o.restore }), listBackups: () => [{ name: 'verge.yaml', ts: '20260930-1', backupPath: '/tmp/b' }], modifiedSinceBackup: () => ({ modified: [] }), restore: async () => ({ restored: [{ name: 'verge.yaml', backupPath: '/tmp/b' }] }), suppressSystemProxy: async () => ({ changed: [] }), setExternalController: async (v) => ({ changed: v ? [{ key: 'enable_external_controller', before: 'false', after: 'true' }] : [] }) };
  const toolConfig = { apply: async (a) => { calls.push(['tc-apply', a]); return { npm: { action: 'written' }, git: { applied: [{ key: 'http.https://github.com/.proxy', value: a.proxyUrl }] } }; }, revert: async () => ({ npm: { action: 'stripped' }, git: { removed: [] } }), status: async () => ({ verdict: 'clean', npmrc: { exists: true, managed: false, proxyLines: [] }, git: { managed: [], mismatch: false, otherHttpKeys: [] } }) };

  const deps = {
    getRuntime: async () => RUNTIME,
    getClient: async () => client,
    getRepo: async () => repo,
    getCvr: async () => cvr,
    getToolConfig: async () => toolConfig,
    getDiagnoseDeps: () => ({ curlRunner: async (args) => (args.includes('--proxy') ? { code: 0, stdout: '200 0.1 0.9 1.1.1.1' } : { code: 28, stdout: '000 0.000 8.001 0.0.0.0', stderr: 'timeout' }) }),
    log: () => {},
    ...over,
  };
  return { deps, calls, client, repo };
}

test('17 个工具全部注册，schema 合规且 description 是中文', () => {
  const { deps } = fakeDeps();
  const tools = buildTools(deps);
  assert.equal(TOOL_NAMES.length, 17, 'spec §3.3 规定 17 个工具');
  assert.equal(tools.length, TOOL_NAMES.length);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} 必须收紧额外参数`);
    assert.match(t.description, /[一-龥]/, `${t.name} 描述要中文`);
    assert.equal(typeof t.handler, 'function');
    assert.doesNotMatch(t.name, /[A-Z]/);
  }
  assert.deepEqual(new Set(tools.map((t) => t.name)).size, tools.length, '工具名不得重复');
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(), 'TOOL_NAMES 与实际注册必须一一对应');
});

test('每个工具都能跑通一次并返回 ok:true', async () => {
  const { deps } = fakeDeps();
  const tools = buildTools(deps);
  const SAMPLE = {
    proxy_core_start: { scope: 'session' },
    proxy_core_stop: { restore: true },
    proxy_nodes: { group: '节点选择' },
    proxy_select: { group: '节点选择', target: 'HK 3 | v4' },
    proxy_test: { group: '节点选择' },
    proxy_env: { target: 'shell' },
    proxy_toolconfig: { action: 'apply', target: 'npm' },
    proxy_subscription_add: { url: 'https://x.test/new?token=T' },
    proxy_subscription_edit: { uid: 'Rq14DVii2DNo', url: 'https://x.test/rotated?token=T2' },
    proxy_subscription_update: { uid: 'Rq14DVii2DNo' },
    proxy_subscription_activate: { uid: 'Rq14DVii2DNo' },
    proxy_subscription_remove: { uid: 'Rq14DVii2DNo', force: true },
    proxy_diagnose: { targets: ['https://github.com'] },
    proxy_restore_config: { name: 'verge.yaml' },
  };
  for (const t of tools) {
    const env = await callTool(t.name, SAMPLE[t.name] || {}, deps);
    assert.equal(env.ok, true, `${t.name} 应成功，实得 ${JSON.stringify(env)}`);
    assert.ok(env.data !== undefined, `${t.name} 必须有 data`);
  }
});

test('开启外部控制不单列为工具：由 proxy_core_start 的 enableExternalControl 转发，默认 false', async () => {
  const { deps, calls } = fakeDeps();
  const start = buildTools(deps).find((t) => t.name === 'proxy_core_start');
  assert.ok(start.inputSchema.properties.enableExternalControl, 'schema 必须暴露这个开关，否则 channel_unavailable 的 hint 无路可走');
  assert.equal(TOOL_NAMES.includes('proxy_enable_external_control'), false, 'spec §3.3 明确不要第 18 个工具');
  await callTool('proxy_core_start', { scope: 'session' }, deps);
  assert.equal(calls[0][1].enableExternalControl, false, '未经用户确认不得改 enable_external_controller');
  await callTool('proxy_core_start', { scope: 'session', enableExternalControl: true }, deps);
  assert.equal(calls[1][1].enableExternalControl, true);
});

test('参数校验：非法 mode / 缺 url / 非法 action 都被拒且不碰底层', async () => {
  const { deps, calls } = fakeDeps();
  assert.equal((await callTool('proxy_select', { mode: 'turbo' }, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_select', {}, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_subscription_add', { url: '不是链接' }, deps)).kind, 'subscription_url_invalid');
  assert.equal((await callTool('proxy_toolconfig', { action: 'explode' }, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_core_start', { scope: 'planet' }, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_diagnose', { targets: 'https://github.com' }, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_env', { timeoutish: 1 }, deps)).kind, 'malformed_config');
  assert.equal(calls.length, 0, '校验失败不能已经调过底层');
});

test('未知工具名 -> 明确错误而不是静默', async () => {
  const { deps } = fakeDeps();
  const e = await callTool('proxy_nothing', {}, deps);
  assert.equal(e.ok, false);
  assert.match(e.message, /proxy_nothing/);
});

test('核心不可达时按 kind 分类，proxy_status 例外仍回 ok:true', async () => {
  // 真 transport/clash-client 一律抛 ApiError（kind+hint 都在实例上），
  // 用"普通 Error 加 .kind 属性"的假件会让 toEnvelope 走未预期错误分支，hint 变成兜底文案 —— 假件必须在撒谎。
  const { deps } = fakeDeps({
    getClient: async () => { throw new ApiError('channel_unavailable', '连不上', '先 start'); },
  });
  for (const name of ['proxy_nodes', 'proxy_test', 'proxy_select']) {
    const env = await callTool(name, name === 'proxy_select' ? { group: 'a', target: 'b' } : { group: 'a' }, deps);
    assert.equal(env.ok, false, name);
    assert.equal(env.kind, 'channel_unavailable', name);
    assert.equal(env.hint, '先 start', name);
  }
  const status = await callTool('proxy_status', {}, deps);
  assert.equal(status.ok, true);
  assert.equal(status.data.core.reachable, false);
  assert.equal(status.data.core.kind, 'channel_unavailable');
  // 订阅 CRUD 刻意不依赖核心：核心没跑时切订阅仍要能写注册表，repo 自己会跳过 reload
  const act = await callTool('proxy_subscription_activate', { uid: 'Rq14DVii2DNo' }, deps);
  assert.equal(act.ok, true);
});

test('未安装时给 not_installed + 安装指引', async () => {
  const { deps } = fakeDeps({ getRuntime: async () => ({ ...RUNTIME, installed: false, configDir: null, running: false }) });
  const e = await callTool('proxy_nodes', {}, deps);
  assert.equal(e.kind, 'not_installed');
  assert.match(e.hint, /安装|QVP_INSTALL_DIR/);
  for (const name of ['proxy_subscriptions', 'proxy_subscription_add', 'proxy_env', 'proxy_toolconfig', 'proxy_diagnose']) {
    // 每个工具都要给到"参数合法"的程度，否则测到的是参数校验而不是未安装分支
    const args = name === 'proxy_subscription_add' ? { url: 'https://x.test/s?token=T' }
      : name === 'proxy_toolconfig' ? { action: 'status' } : {};
    assert.equal((await callTool(name, args, deps)).kind, 'not_installed', name);
  }
});

test('输出全过脱敏：订阅 token 与节点地址不出现', async () => {
  const { deps } = fakeDeps();
  const list = await callTool('proxy_subscriptions', {}, deps);
  assert.doesNotMatch(JSON.stringify(list), /token=T\b(?!<)/);
  const nodes = await callTool('proxy_nodes', {}, deps);
  assert.doesNotMatch(JSON.stringify(nodes), /server|password|uuid/i);
  const diag = await callTool('proxy_diagnose', { targets: ['https://x.test/s?token=SECRET'] }, deps);
  assert.doesNotMatch(JSON.stringify(diag), /SECRET/);
});

test('全链路：fake-mihomo + 沙箱 profiles 跑 nodes/select/test/status', async () => {
  const fake = await startFake({ pipeName: 'qvp-t15-e2e', port: 0, secret: 'set-your-secret' });
  const dir = path.join(os.tmpdir(), `qvp-t15-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const configDir = path.join(dir, 'cvr');
  fs.mkdirSync(path.join(configDir, 'profiles'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'cvr-profiles.yaml'), path.join(configDir, 'profiles.yaml'));
  fs.writeFileSync(path.join(configDir, 'verge.yaml'), 'enable_system_proxy: true\nenable_proxy_guard: true\nverge_mixed_port: 7897\nenable_external_controller: false\n');
  const dirs = store.ensure(store.dirs({ QODER_VPN_PROXY_DATA: path.join(dir, 'data') }));
  const client = new ClashClient(await createTransport({ secret: 'set-your-secret', controller: { pipe: fake.pipeName, tcp: null } }));
  const repo = new SubscriptionRepo({ configDir, dirs, fetchImpl: async () => ({ format: 'yaml', yaml: 'proxies: []\n', nodes: 2, bytes: 10, name: '沙盒', userInfo: null }) });
  const deps = {
    getRuntime: async () => ({ ...RUNTIME, configDir, ports: { mixed: 7897, socks: 7898, http: 7899 } }),
    getClient: async () => client,
    getRepo: async () => repo,
    getCvr: async () => null,
    getToolConfig: async () => ({ status: async () => ({ verdict: 'clean', npmrc: { exists: false, managed: false, proxyLines: [] }, git: { managed: [], mismatch: false, otherHttpKeys: [] } }), apply: async () => ({}), revert: async () => ({}) }),
    getDiagnoseDeps: () => ({ curlRunner: async () => ({ code: 0, stdout: '200 0.1 0.2 1.1.1.1' }) }),
    log: () => {},
  };
  const nodes = await callTool('proxy_nodes', {}, deps);
  assert.equal(nodes.ok, true);
  assert.ok(nodes.data.groups[0].all.includes('HK 3 | v4'));

  const sel = await callTool('proxy_select', { group: '节点选择', target: 'JP 1 | v3' }, deps);
  assert.equal(sel.data.now, 'JP 1 | v3');
  assert.equal(fake.state.proxies['节点选择'].now, 'JP 1 | v3', '真写到了 fake');

  const tested = await callTool('proxy_test', { group: '节点选择' }, deps);
  const dead = tested.data.results.find((r) => r.name === 'dead-node');
  assert.equal(dead.ok, false);
  assert.equal(dead.kind, 'timeout', '坏节点是节点问题，不能被归成通道问题');
  assert.ok(tested.data.results.find((r) => r.name === 'HK 3 | v4').delay > 0);
  assert.ok(tested.data.best === 'TW 2 | v4' || /^[A-Z]/.test(tested.data.best), 'best 排序后有值');

  const add = await callTool('proxy_subscription_add', { url: 'https://sandbox.test/sub?token=ZZZ', name: '沙盒二' }, deps);
  assert.equal(add.ok, true, JSON.stringify(add));
  const subs = await callTool('proxy_subscriptions', {}, deps);
  assert.equal(subs.data.length, 2);
  assert.ok(!JSON.stringify(subs).includes('ZZZ'), '全链路也不泄露 token');

  const status = await callTool('proxy_status', {}, deps);
  assert.equal(status.data.core.channel, 'pipe');
  assert.equal(status.data.core.mode, 'rule');
  assert.equal(status.data.subscription.current.uid, 'Rq14DVii2DNo');

  client.close();
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
