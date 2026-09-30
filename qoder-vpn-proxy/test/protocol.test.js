'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { framer, handleMessage, PROTOCOL_VERSION, SERVER_INFO } = require('../server/protocol');

const stubTools = [
  { name: 'proxy_status', description: '状态', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'proxy_env', description: 'env', inputSchema: { type: 'object', properties: { target: { type: 'string', enum: ['shell', 'npm', 'git', 'pip'] } }, additionalProperties: false } },
];
const deps = {
  callTool: async (name, args) => (name === 'proxy_status'
    ? { ok: true, data: { running: true, args } }
    : { ok: false, kind: 'core_not_running', message: '没跑', hint: 'start 它' }),
  tools: stubTools,
  log: () => {},
};

test('framer 处理跨 chunk 拆分与单 chunk 多帧', () => {
  const f = framer();
  assert.deepEqual(f.push('{"jsonrpc":"2.0","id":1,"me'), []);
  const got = f.push('thod":"initialize"}\n{"jsonrpc":"2.0","method":"ping"}\n');
  assert.equal(got.length, 2);
  assert.equal(got[0].id, 1);
  assert.equal(got[1].method, 'ping');
});

test('framer 对坏帧只丢这一帧，不阻塞后续', () => {
  const f = framer();
  const got = f.push('{坏 json}\n{"jsonrpc":"2.0","method":"ping"}\n');
  assert.equal(got.length, 1);
  assert.equal(got[0].method, 'ping');
});

test('initialize 回 protocolVersion / capabilities / serverInfo / instructions', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qoder', version: 'x' } } }, deps);
  assert.equal(res.id, 7);
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(res.result.serverInfo, SERVER_INFO);
  assert.ok(res.result.capabilities.tools);
  assert.match(res.result.instructions, /代理/);
});

test('notifications/initialized 不回帧', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps), null);
});

test('tools/list 输出 MCP 形状的 tools 数组', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps);
  assert.equal(res.result.tools.length, 2);
  assert.deepEqual(Object.keys(res.result.tools[0]).sort(), ['description', 'inputSchema', 'name']);
});

test('tools/call 把 envelope 序列化进 content[0].text，失败时 isError:true', async () => {
  const okRes = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'proxy_status', arguments: { a: 1 } } }, deps);
  assert.equal(okRes.result.isError, false);
  assert.deepEqual(JSON.parse(okRes.result.content[0].text), { ok: true, data: { running: true, args: { a: 1 } } });

  const badRes = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'proxy_env', arguments: {} } }, deps);
  assert.equal(badRes.result.isError, true);
  assert.equal(JSON.parse(badRes.result.content[0].text).kind, 'core_not_running');
});

test('未知工具 -> JSON-RPC -32602；未知方法 -> -32601', async () => {
  const a = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }, deps);
  assert.equal(a.error.code, -32602);
  assert.match(a.error.message, /nope/);
  const b = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, deps);
  assert.equal(b.error.code, -32601);
});

test('handler 抛异常时回 -32603 而不是让服务端崩', async () => {
  const boom = { tools: stubTools, log: () => {}, callTool: async () => { throw new Error('内部炸了'); } };
  const res = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'proxy_status', arguments: {} } }, boom);
  assert.equal(res.error.code, -32603);
});

test('内部异常的日志行先过脱敏：订阅地址不进 mcp.log', async () => {
  const lines = [];
  const boom = {
    tools: stubTools,
    log: (l) => lines.push(String(l)),
    callTool: async () => { throw new Error('抓取 https://panel.example.invalid/SUBPATH?token=TOKEN_PLACEHOLDER 失败'); },
  };
  const res = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'proxy_status', arguments: {} } }, boom);
  assert.equal(res.error.code, -32603);
  assert.ok(lines.length >= 1, '异常要留日志，否则无从排查');
  assert.doesNotMatch(lines.join('\n'), /panel\.example\.invalid|SUBPATH|TOKEN_PLACEHOLDER/, '日志会落盘，异常栈里的订阅链接必须抹掉');
});
