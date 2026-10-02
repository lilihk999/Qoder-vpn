'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../server/store');
const T = require('./tmp');

const tmp = (n) => T.tmpDir(`store-${n}`);

test('dataDir 默认在 ~/.qoder/vpn-proxy，可用环境变量覆盖', () => {
  assert.equal(S.dataDir({ HOME: '/home/u' }), path.join(os.homedir(), '.qoder', 'vpn-proxy'));
  assert.equal(S.dataDir({ QODER_VPN_PROXY_DATA: '/custom/dir' }), '/custom/dir');
});

test('dirs 给出四个子目录', () => {
  const dir = tmp('dirs');
  const d = S.dirs({ QODER_VPN_PROXY_DATA: dir });
  assert.deepEqual(Object.keys(d).sort(), ['backups', 'logs', 'root', 'trash']);
  assert.equal(d.root, dir);
  assert.equal(d.backups, path.join(dir, 'backups'));
});

test('ensure 造出四个子目录且可重复调用', () => {
  const dir = tmp('ensure');
  fs.rmSync(dir, { recursive: true, force: true });
  const d = S.dirs({ QODER_VPN_PROXY_DATA: dir });
  S.ensure(d); S.ensure(d);
  for (const k of ['root', 'backups', 'trash', 'logs']) assert.ok(fs.existsSync(d[k]), k);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonAtomic 覆盖旧值且不留 .tmp', () => {
  const dir = tmp('json');
  const d = S.ensure(S.dirs({ QODER_VPN_PROXY_DATA: dir }));
  const f = path.join(d.root, 'subscriptions.json');
  S.writeJsonAtomic(f, { a: 1 });
  S.writeJsonAtomic(f, { a: 2, b: 3 });
  assert.deepEqual(S.readJson(f, null), { a: 2, b: 3 });
  assert.deepEqual(fs.readdirSync(d.root).filter((x) => x.includes('.tmp')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson 对损坏文件回 fallback 而不是抛', () => {
  const dir = tmp('broken');
  const d = S.ensure(S.dirs({ QODER_VPN_PROXY_DATA: dir }));
  const f = path.join(d.root, 'x.json');
  fs.writeFileSync(f, '{不是 json');
  assert.equal(S.readJson(f, null), null);
  assert.deepEqual(S.readJson(f, []), []);
  assert.equal(S.readJson(path.join(d.root, 'missing.json'), '兜底'), '兜底');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('moveToTrash 可撤销：移走再还原内容一致', () => {
  const dir = tmp('trash');
  const d = S.ensure(S.dirs({ QODER_VPN_PROXY_DATA: dir }));
  const src = path.join(d.root, 'victim.yaml');
  fs.writeFileSync(src, '原内容\n');
  const moved = S.moveToTrash(d, src);
  assert.ok(!fs.existsSync(src));
  assert.ok(moved.startsWith(d.trash));
  assert.deepEqual(S.listTrash(d).length, 1);
  const back = path.join(d.root, 'restored.yaml');
  S.restoreFromTrash(d, path.basename(moved), back);
  assert.equal(fs.readFileSync(back, 'utf8'), '原内容\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('moveToTrash 对不存在的文件抛 config_write_failed', () => {
  const dir = tmp('trash2');
  const d = S.ensure(S.dirs({ QODER_VPN_PROXY_DATA: dir }));
  assert.throws(() => S.moveToTrash(d, path.join(d.root, 'nope.yaml')), (e) => e.kind === 'config_write_failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stamp 连续调用不撞名（同毫秒内两次备份不能写到同一个文件）', () => {
  const seen = new Set(Array.from({ length: 200 }, () => S.stamp()));
  assert.equal(seen.size, 200);
});

test('listBackupsIn 混用两种时间戳时按时间戳排（mtime 只兜底），latestBackupIn 取到真正最新的那份', () => {
  const dir = tmp('backups');
  const bd = path.join(dir, 'backups');
  fs.mkdirSync(bd, { recursive: true });
  // 两种 stamp 格式同目录：带横杠的名字字典序更"旧"，但它是最后落盘的
  const dashed = 'profiles.yaml.20260930-235959-999-001.bak';
  const plain = 'profiles.yaml.20260930120000000-001.bak';
  fs.writeFileSync(path.join(bd, plain), 'STALE');
  fs.writeFileSync(path.join(bd, dashed), 'NEWEST');
  const at = (h) => new Date(Date.UTC(2026, 8, 30, h, 0, 0));
  fs.utimesSync(path.join(bd, plain), at(1), at(1));
  fs.utimesSync(path.join(bd, dashed), at(23), at(23));
  assert.deepEqual(S.listBackupsIn(bd), [plain, dashed], '升序：更早的在前');
  assert.equal(S.latestBackupIn(bd, 'profiles.yaml'), path.join(bd, dashed));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listBackupsIn 以时间戳为主键：copyFileSync 保留的旧 mtime 不能把真正的最新备份判成旧的', () => {
  // Windows 上 fs.copyFileSync 走 Win32 CopyFile，会原样保留源文件 mtime（真机实测）：
  // 把一份几个月前写过的基座备成"新备份"，它的 mtime 比昨天的备份还老 —— mtime 当主键时
  // "谁是最新"会判错，而 pruneBackupsIn 正是靠这个次序保证"每组至少留最新一份"，
  // 判错的后果不是排错序，是把真正最新的那份当旧的删掉。
  const dir = tmp('backups-ts-primary');
  const bd = path.join(dir, 'backups');
  fs.mkdirSync(bd, { recursive: true });
  const ancient = 'verge.yaml.20260901120000000-001.bak';
  const staleMtime = 'verge.yaml.20261002-080940-559-002.bak'; // 名字最新，mtime 最老（复制来的旧基座）
  const yesterday = 'verge.yaml.20261001120000000-001.bak';
  for (const [f, day] of [[ancient, 1], [staleMtime, 2], [yesterday, 30]]) {
    fs.writeFileSync(path.join(bd, f), f);
    const at = new Date(Date.UTC(2026, 7, day, 0, 0, 0));
    fs.utimesSync(path.join(bd, f), at, at);
  }
  assert.deepEqual(S.listBackupsIn(bd), [ancient, yesterday, staleMtime], '升序按时间戳：mtime 只兜底');
  assert.equal(S.latestBackupIn(bd, 'verge.yaml'), path.join(bd, staleMtime));
  const r = S.pruneBackupsIn(bd, { keepPerName: 1, olderThanDays: 14, now: Date.UTC(2026, 9, 2) });
  assert.deepEqual(r.deleted.map((d) => d.file), [ancient, yesterday], '留下的必须是时间戳最晚的那份');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneBackupsIn 按份数与天数淘汰，但每个名字永远至少留最新一份', () => {
  const dir = tmp('prune1');
  const bd = path.join(dir, 'backups');
  fs.mkdirSync(bd, { recursive: true });
  const DAY = 86400000;
  const now = Date.UTC(2026, 8, 30, 12);
  const touch = (name, ageDays) => {
    const f = path.join(bd, name);
    fs.writeFileSync(f, 'x');
    const t = (now - ageDays * DAY) / 1000;
    fs.utimesSync(f, t, t);
  };
  touch('verge.yaml.20260927-000000-001.bak', 40); // 第 3 新 -> 超份数
  touch('verge.yaml.20260929-000000-001.bak', 20); // 第 2 新 -> 份数内但超龄
  touch('verge.yaml.20260930-000000-001.bak', 1); // 最新 -> 永远留
  touch('profiles.yaml.20260901-000000-001.bak', 100); // 该名字唯一一份 -> 超龄也必须留
  const r = S.pruneBackupsIn(bd, { keepPerName: 2, olderThanDays: 14, now });
  assert.deepEqual(r.deleted.map((d) => d.file), [
    'verge.yaml.20260927-000000-001.bak',
    'verge.yaml.20260929-000000-001.bak',
  ]);
  assert.deepEqual(r.deleted.map((d) => d.reason), ['count', 'age'], '原因要分清，用户才知道为什么少了一份');
  assert.ok(fs.existsSync(path.join(bd, 'verge.yaml.20260930-000000-001.bak')), '最新一份不许被删');
  assert.ok(fs.existsSync(path.join(bd, 'profiles.yaml.20260901-000000-001.bak')), '只剩一份时哪怕超龄也留');
  assert.deepEqual(r.kept.sort(), ['profiles.yaml.20260901-000000-001.bak', 'verge.yaml.20260930-000000-001.bak']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneBackupsIn dryRun 只报告不删，且绝不碰非备份文件', () => {
  const dir = tmp('prune2');
  const bd = path.join(dir, 'backups');
  fs.mkdirSync(bd, { recursive: true });
  const now = Date.UTC(2026, 8, 30, 12);
  for (const n of ['verge.yaml.20260901-000000-001.bak', 'verge.yaml.20260902-000000-001.bak']) {
    const f = path.join(bd, n);
    fs.writeFileSync(f, 'x');
    const t = (now - 40 * 86400000) / 1000;
    fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(path.join(bd, 'subscriptions.json'), '{"keep":true}');
  fs.writeFileSync(path.join(bd, 'notes.md'), 'keep');
  const dry = S.pruneBackupsIn(bd, { keepPerName: 1, olderThanDays: 7, now, dryRun: true });
  assert.equal(dry.deleted.length, 1);
  assert.equal(dry.scanned, 2, '只统计备份文件');
  assert.ok(fs.existsSync(path.join(bd, 'verge.yaml.20260901-000000-001.bak')), 'dryRun 不能真删');
  const real = S.pruneBackupsIn(bd, { keepPerName: 1, olderThanDays: 7, now });
  assert.equal(real.deleted.length, 1);
  assert.ok(!fs.existsSync(path.join(bd, 'verge.yaml.20260901-000000-001.bak')));
  assert.ok(fs.existsSync(path.join(bd, 'subscriptions.json')), '非备份文件一律不碰');
  assert.ok(fs.existsSync(path.join(bd, 'notes.md')));
  fs.rmSync(dir, { recursive: true, force: true });
});
