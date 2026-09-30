'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../server/cvr-config');

const VERGE = [
  '# Verge Config',
  'enable_tun_mode: false',
  'enable_auto_launch: false',
  'enable_system_proxy: true',
  'enable_proxy_guard: true',
  'system_proxy_bypass: null',
  'verge_mixed_port: 7897',
  'enable_external_controller: false',
  '',
].join('\n');

const EXE = 'clash-verge.exe';

function mkSandbox(t) {
  const dir = path.join(__dirname, `sandbox-task10-${t}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'config', 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'verge.yaml'), VERGE);
  fs.writeFileSync(path.join(dir, 'config', 'profiles.yaml'), '# Profiles\n\ncurrent: A\nitems:\n- uid: A\n  type: remote\n');
  // start() 会先确认 exe 存在再 spawn，所以沙箱必须给它一个存在的可执行文件路径
  fs.writeFileSync(path.join(dir, EXE), 'placeholder');
  return dir;
}
const exe = (dir) => path.join(dir, EXE);
const stdioOf = (o) => [].concat(o.stdio).join(',');

test('patchScalar 只改目标行，其余字节不动', () => {
  const r = C.patchScalar(VERGE, 'enable_system_proxy', false);
  assert.equal(r.changed, true);
  assert.equal(r.before, 'true');
  assert.equal(r.after, 'false');
  const a = VERGE.split('\n'), b = r.text.split('\n');
  assert.equal(a.length, b.length);
  assert.deepEqual(a.map((l, i) => (l === b[i] ? null : i)).filter(Boolean), [3], '只有第 4 行变了');
});

test('patchScalar 保留 CRLF 行尾', () => {
  const crlf = VERGE.replace(/\n/g, '\r\n');
  const r = C.patchScalar(crlf, 'enable_proxy_guard', false);
  assert.ok(r.text.includes('\r\n'), '仍是 CRLF');
  assert.ok(!r.text.includes('\n\r'), '没有产生怪异行尾');
  assert.equal(C.patchScalar(r.text, 'enable_proxy_guard', false).changed, false, '幂等');
});

test('patchScalar 键缺失时追加且不破坏已有内容', () => {
  const r = C.patchScalar('a: 1\n', 'enable_system_proxy', false);
  assert.match(r.text, /^a: 1\nenable_system_proxy: false\n$/);
  assert.equal(r.before, null);
});

test('列 0 之外的同名键不误伤（如 app_theme 与 theme 之类前缀）', () => {
  const text = 'my_enable_system_proxy: true\nenable_system_proxy: true\n';
  const r = C.patchScalar(text, 'enable_system_proxy', false);
  assert.match(r.text, /my_enable_system_proxy: true/);
  assert.match(r.text, /^enable_system_proxy: false$/m);
});

test('backup 后 suppress 再 restore：逐字节一致', async () => {
  const dir = mkSandbox('restore');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
  });
  const before = fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8');
  const profBefore = fs.readFileSync(path.join(dir, 'config', 'profiles.yaml'), 'utf8');
  const made = await cvr.backup();
  assert.deepEqual(made.map((m) => m.name).sort(), ['profiles.yaml', 'verge.yaml']);
  const { changed } = await cvr.suppressSystemProxy();
  assert.deepEqual(changed.map((c) => c.key).sort(), ['enable_proxy_guard', 'enable_system_proxy']);
  assert.notEqual(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), before);
  const restored = await cvr.restore();
  assert.equal(restored.restored.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), before, 'verge.yaml 逐字节还原');
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'profiles.yaml'), 'utf8'), profBefore);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listBackups 混用两种时间戳格式时按 mtime 排，restore 取到真正的最新', async () => {
  // 真机 backups 目录里同时存在 cvr-config 的 20260930-123930-488-001 与
  // subscriptions 走 store.stamp 的 20260930125704201-001；'-'(0x2D) 比数字小，
  // 纯按文件名排序会把带横杠的（可能更晚的）备份判成最旧。
  const dir = mkSandbox('mixedstamp');
  const bd = path.join(dir, 'backups');
  const f = path.join(dir, 'config', 'verge.yaml');
  const old = fs.readFileSync(f, 'utf8');
  const dashed = path.join(bd, 'verge.yaml.20260930-235959-999-001.bak'); // 名字最"旧"，实际最新
  const plain = path.join(bd, 'verge.yaml.20260930120000000-001.bak');
  fs.writeFileSync(dashed, 'NEWEST');
  fs.writeFileSync(plain, 'STALE');
  const t = (d) => new Date(Date.UTC(2026, 8, 30, d % 24, 0, 0));
  fs.utimesSync(plain, t(1), t(1));
  fs.utimesSync(dashed, t(23), t(23));
  const cvr = new C.CvrConfig({ configDir: path.join(dir, 'config'), backupDir: bd, exePath: exe(dir), fsImpl: fs });
  assert.equal(cvr.listBackups()[0].backupPath, dashed, '最新备份必须排第一');
  await cvr.restore(['verge.yaml']);
  assert.equal(fs.readFileSync(f, 'utf8'), 'NEWEST', '还原必须用真正最新的那份');
  fs.writeFileSync(f, old);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('备份失败则不写入（spec §4：不进半改状态）', async () => {
  const dir = mkSandbox('backupfail');
  const boomFs = { ...fs, copyFileSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } };
  const cvr = new C.CvrConfig({ configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: boomFs });
  await assert.rejects(cvr.suppressSystemProxy(), (e) => e.kind === 'config_write_failed');
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), VERGE, '原文件未被动过');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start 走 session scope：先备份再压制，等通道就绪', async () => {
  const dir = mkSandbox('start');
  const calls = [];
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
    spawn: (cmd, args, opts) => { calls.push(['spawn', cmd, opts.detached, stdioOf(opts)]); return { unref() { calls.push(['unref']); } }; },
    waitForChannel: async () => ({ kind: 'pipe', ports: { mixed: 7897 } }),
  });
  const r = await cvr.start({ scope: 'session' });
  assert.equal(r.scope, 'session');
  assert.equal(r.systemProxySuppressed, true);
  assert.equal(r.channel.kind, 'pipe');
  assert.deepEqual(calls[0], ['spawn', exe(dir), true, 'ignore']);
  assert.ok(calls.includes('unref') || calls.some((c) => c[0] === 'unref'), '分离进程必须 unref，否则插件退出会卡在子进程上');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: false$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start 走 global scope 时不碰系统代理', async () => {
  const dir = mkSandbox('global');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  const r = await cvr.start({ scope: 'global' });
  assert.equal(r.systemProxySuppressed, false);
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enableExternalControl=true 时必须在 spawn 之前改 verge.yaml', async () => {
  const dir = mkSandbox('extctl');
  const seq = [];
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
    spawn: () => { seq.push('spawn'); return { unref() {} }; },
    waitForChannel: async () => { seq.push('wait'); return { kind: 'tcp', ports: { mixed: 7897 } }; },
  });
  const r = await cvr.start({ scope: 'session', enableExternalControl: true });
  assert.equal(r.externalControlEnabled, true);
  assert.deepEqual(seq, ['spawn', 'wait'], '改配置发生在 spawn 之前，所以 seq 里只剩这两步');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_external_controller: true$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('默认不传 enableExternalControl 时绝不碰该键（未确认就不改）', async () => {
  const dir = mkSandbox('extctl-off');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  const r = await cvr.start({ scope: 'session' });
  assert.equal(r.externalControlEnabled, false);
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_external_controller: false$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scope=global + enableExternalControl 超时也要回滚（只看 suppressed 会漏这条路径）', async () => {
  const dir = mkSandbox('extctl-rollback');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => { throw new C.ApiError('channel_unavailable', '不可达'); },
  });
  await assert.rejects(cvr.start({ scope: 'global', enableExternalControl: true }));
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_external_controller: false$/m, '回滚了外部控制开关');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m, 'global 本来就没压');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start 超时未就绪 -> core_not_running，且已写入的压制项被还原', async () => {
  const dir = mkSandbox('timeout');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => { throw new C.ApiError('channel_unavailable', '不可达'); },
  });
  await assert.rejects(cvr.start({ scope: 'session' }), (e) => e.kind === 'channel_unavailable' || e.kind === 'core_not_running');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m, '回滚了压制');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exePath 不存在时立刻 not_installed，而不是白等 25 秒超时', async () => {
  const dir = mkSandbox('noexe');
  let spawned = 0;
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: path.join(dir, 'missing.exe'), fsImpl: fs,
    spawn: () => { spawned += 1; return { unref() {} }; },
    waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  await assert.rejects(cvr.start({ scope: 'session' }), (e) => e.kind === 'not_installed');
  assert.equal(spawned, 0, '没确认过可执行文件就不该 spawn');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m, 'not_installed 同样要回滚压制');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session + enableExternalControl 双双失败时，两个键都回到调用前的值', async () => {
  const dir = mkSandbox('both-rollback');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => { throw new C.ApiError('channel_unavailable', '不可达'); },
  });
  await assert.rejects(cvr.start({ scope: 'session', enableExternalControl: true }));
  const text = fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8');
  assert.match(text, /^enable_system_proxy: true$/m, '压制已撤销');
  assert.match(text, /^enable_external_controller: false$/m, '外部控制开关也回滚');
  assert.equal(text, VERGE, '两个键都改过时，还原必须回到 start 入口时的整份内容');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('modifiedSinceBackup：改过报脏，还原后即便备份仍在也不报脏', async () => {
  const dir = mkSandbox('modified');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
  });
  assert.deepEqual(cvr.modifiedSinceBackup().modified, [], '没备份过 -> 无从判断，报干净');
  await cvr.backup();
  assert.deepEqual(cvr.modifiedSinceBackup().modified, [], '刚备份、内容一致 -> 干净');
  await cvr.suppressSystemProxy();
  const dirty = cvr.modifiedSinceBackup().modified;
  assert.deepEqual(dirty.map((m) => m.name), ['verge.yaml'], '压制后应报 verge.yaml 被改过');
  await cvr.restore();
  assert.deepEqual(cvr.modifiedSinceBackup().modified, [], '还原后回到干净，而不是因备份存在而永远报脏');
  assert.ok(cvr.listBackups().length > 0, '备份文件没被删，只是不再算作"当前改过"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stop：taskkill 两个镜像，restore=true 时还原备份', async () => {
  const dir = mkSandbox('stop');
  const cmds = [];
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
    execFile: (cmd, args) => { cmds.push(`${cmd} ${args.join(' ')}`); return Promise.resolve({ stdout: '' }); },
  });
  await cvr.backup(['verge.yaml']);
  await cvr.suppressSystemProxy();
  const r = await cvr.stop({ restore: true });
  assert.ok(cmds.some((c) => /tasklist|taskkill/.test(c)));
  assert.equal(r.restored, true);
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m);
  const r2 = await cvr.stop({ restore: false });
  assert.equal(r2.restored, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
