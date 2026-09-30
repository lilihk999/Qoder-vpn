'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../server/store');

const tmp = (n) => path.join(os.tmpdir(), `qvp-store-${n}-${process.pid}`);

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

test('listBackupsIn 按落盘时间排，latestBackupIn 取到真正最新的那份', () => {
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
