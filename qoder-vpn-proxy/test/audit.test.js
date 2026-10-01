'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAudit, argNames, FILE } = require('../server/audit');
const store = require('../server/store');
const T = require('./tmp');

function sandbox(label, envOver = {}) {
  const dir = T.tmpDir(`audit-${label}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const dirs = store.ensure(store.dirs({ QODER_VPN_PROXY_DATA: dir }));
  const env = { ...envOver };
  return { dir, dirs, env, file: path.join(dirs.logs, FILE) };
}

test('record 落一行 JSONL：时间、工具、参数名、成败、kind、耗时', () => {
  const { dir, dirs, env, file } = sandbox('basic');
  const a = createAudit({ dirs, env, now: () => '2026-09-30T12:00:00.000Z' });
  a.record({ tool: 'proxy_select', argNames: ['group', 'target'], ok: true, kind: null, ms: 12.6 });
  const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual(line, { ts: '2026-09-30T12:00:00.000Z', tool: 'proxy_select', args: ['group', 'target'], ok: true, kind: null, ms: 13 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('账本里没有参数值：订阅链接与节点名只留名字', () => {
  const SECRET = 'https://sub.example.invalid/Quir7aMockQwsxNcgv1234?token=abcdef0123456789abcdef0123456789';
  const { dir, dirs, env, file } = sandbox('no-values');
  const a = createAudit({ dirs, env });
  a.record({ tool: 'proxy_subscription_add', argNames: argNames({ url: SECRET, name: '南山云' }), ok: true });
  a.record({ tool: 'proxy_select', argNames: argNames({ group: '节点选择', target: 'HK 3 | v4' }), ok: false, kind: 'channel_unavailable' });
  const dump = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(dump, /sub\.example\.invalid|Quir7aMock|abcdef0123456789|南山云|HK 3/, '值一旦进账本就是永久磁盘残留');
  assert.match(dump, /"url"/);
  assert.match(dump, /channel_unavailable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('超过 maxBytes 只保留最近 keepLines 条，最新一条一定在', () => {
  const { dir, dirs, env, file } = sandbox('rotate');
  const a = createAudit({ dirs, env, maxBytes: 400, keepLines: 3, now: () => 'T' });
  for (let i = 0; i < 12; i += 1) a.record({ tool: `proxy_t${i}`, argNames: [], ok: true, ms: i });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= 3, `应当裁到 3 行以内，实际 ${lines.length}`);
  assert.equal(JSON.parse(lines[lines.length - 1]).tool, 'proxy_t11', '裁剪不能把刚刚那次调用丢掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('QODER_VPN_PROXY_AUDIT=0 时一个字节都不写', () => {
  const { dir, dirs, file } = sandbox('off', { QODER_VPN_PROXY_AUDIT: '0' });
  const a = createAudit({ dirs, env: { QODER_VPN_PROXY_AUDIT: '0' } });
  const r = a.record({ tool: 'proxy_status', argNames: [], ok: true });
  assert.equal(r, null);
  assert.equal(fs.existsSync(file), false);
  assert.equal(a.read().enabled, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('read 回最近若干条，坏行丢弃而不是抛', () => {
  const { dir, dirs, env, file } = sandbox('read');
  const a = createAudit({ dirs, env });
  a.record({ tool: 'proxy_status', argNames: [], ok: true });
  a.record({ tool: 'proxy_nodes', argNames: [], ok: true });
  fs.appendFileSync(file, '这一行不是 JSON\n');
  const r = a.read(5);
  assert.equal(r.enabled, true);
  assert.equal(r.lines, 3, '坏行算进行数（它是磁盘占用），但不进 recent');
  assert.deepEqual(r.recent.map((e) => e.tool), ['proxy_status', 'proxy_nodes']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('账本写不进去时不能拖累工具调用', () => {
  const { dir, dirs } = sandbox('broken');
  fs.rmSync(dirs.logs, { recursive: true, force: true });
  fs.writeFileSync(dirs.logs, '不是目录');
  const a = createAudit({ dirs, env: {} });
  assert.doesNotThrow(() => a.record({ tool: 'proxy_status', argNames: [], ok: true }));
  assert.deepEqual(a.read(3).recent, []);
  fs.rmSync(path.dirname(dirs.logs), { recursive: true, force: true });
});
