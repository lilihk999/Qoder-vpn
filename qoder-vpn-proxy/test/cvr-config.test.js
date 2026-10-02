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

test('listBackups 混用两种时间戳格式时按时间戳排（mtime 只兜底），restore 取到真正的最新', async () => {
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
  assert.deepEqual(cvr.modifiedSinceBackup().modified, []);
  assert.deepEqual(cvr.modifiedSinceBackup().noBackup.sort(), ['profiles.yaml', 'verge.yaml'],
    '一个插件备份都没有时，报的是"无从判断"，不能报成"和基线一致"');
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

test('modifiedSinceBackup 返回三态：脏 / 干净 / 无可比备份', async () => {
  const dir = mkSandbox('drift-shape');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
  });
  await cvr.backup();
  fs.writeFileSync(path.join(dir, 'config', 'profiles.yaml'), '# 用户手改\n');
  const r = cvr.modifiedSinceBackup();
  assert.deepEqual(r.modified.map((m) => m.name), ['profiles.yaml']);
  assert.deepEqual(r.clean, ['verge.yaml'], '干净的那个要能被点名，否则 proxy_status 无法说"另一个没问题"');
  assert.equal(typeof r.modified[0].backupTs, 'string', '报脏要带它是在跟哪一份备份比');
  // 备份目录被清空 -> 两个文件都退化成"无从判断"
  for (const b of cvr.listBackups()) fs.unlinkSync(b.backupPath);
  const gone = cvr.modifiedSinceBackup();
  assert.deepEqual(gone.modified, []);
  assert.deepEqual(gone.clean, []);
  assert.deepEqual(gone.noBackup.sort(), ['profiles.yaml', 'verge.yaml']);
  // 配置文件整个不见了：这是最严重的一种偏离，不能算"没得比"
  await cvr.backup();
  fs.unlinkSync(path.join(dir, 'config', 'verge.yaml'));
  const missing = cvr.modifiedSinceBackup();
  assert.deepEqual(missing.modified.map((m) => m.name), ['verge.yaml']);
  assert.equal(missing.modified[0].missing, true, '要能和"内容不同"区分开：文件不见了不该建议 diff，该建议还原');
  assert.deepEqual(missing.clean, ['profiles.yaml']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stop 只还原 verge.yaml：profiles.yaml 里用户主动切的订阅不能被撤销', async () => {
  // 真机踩过：activate 到新区块后 stop({restore:true}) 把 profiles.yaml 回滚到切换前，
  // 用户以为订阅换成功了，重启完核心又变回去。会话级要还原的只有系统代理压制。
  const dir = mkSandbox('stop-profiles');
  const cfg = path.join(dir, 'config');
  const cvr = new C.CvrConfig({
    configDir: cfg, backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: fs,
    execFile: () => Promise.resolve({ stdout: '' }),
  });
  await cvr.backup(['verge.yaml', 'profiles.yaml']);
  await cvr.suppressSystemProxy();
  fs.writeFileSync(path.join(cfg, 'profiles.yaml'), '# Profiles\n\ncurrent: B\nitems:\n- uid: B\n  type: remote\n');
  const r = await cvr.stop({ restore: true });
  assert.deepEqual(r.restoredList.map((x) => x.name), ['verge.yaml'], 'stop 只碰 verge.yaml');
  assert.match(fs.readFileSync(path.join(cfg, 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m, '压制已还原');
  assert.match(fs.readFileSync(path.join(cfg, 'profiles.yaml'), 'utf8'), /^current: B$/m, '用户切的订阅保持住');
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

// 缺陷 8：真机上 proxy_core_stop 之后 ProxyEnable 变成 0x1 而 7897 无人监听，浏览器全部连接被拒。
// 原因是 taskkill 之后立刻 copyFileSync 还原 verge.yaml（里面 enable_system_proxy: true），
// 而此时 CVR 还在拆除中 —— 它读到新配置就把系统代理又打开了。
test('stop 必须先确认 CVR 进程真的退出，再还原 verge.yaml', async () => {
  const dir = mkSandbox('stop-exit-order');
  const cfg = path.join(dir, 'config');
  const events = [];
  let polls = 0;
  const execFile = (cmd, args) => {
    if (cmd === 'taskkill') { events.push(`kill:${args[1]}`); return Promise.resolve({ stdout: '' }); }
    if (cmd === 'tasklist') {
      const image = /IMAGENAME eq (\S+)/.exec(args.join(' '))[1];
      const alive = (polls += 1) <= 3; // 第一轮三次轮询进程都还在，第二轮才消失
      events.push(`poll:${image}:${alive ? 'alive' : 'gone'}`);
      return Promise.resolve({ stdout: alive
        ? `${image}                   1234 Console                    1     10,240 K\n`
        : 'INFO: No Tasks are running which match the specified criteria.\n' });
    }
    if (cmd === 'reg') return Promise.resolve({ stdout: '    ProxyEnable    REG_DWORD    0x0\n' });
    throw new Error(`不该调用 ${cmd} ${args.join(' ')}`);
  };
  const fsSpy = Object.create(fs);
  const vergeFile = path.join(cfg, 'verge.yaml');
  // backup() 也走 copyFileSync（方向是 config -> backups），只统计"写回配置"这一侧
  fsSpy.copyFileSync = (a, b) => { if (b === vergeFile) events.push('copy'); return fs.copyFileSync(a, b); };
  const cvr = new C.CvrConfig({
    configDir: cfg, backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: fsSpy, execFile,
  });
  await cvr.backup(['verge.yaml']);
  await cvr.suppressSystemProxy();
  const r = await cvr.stop({ restore: true, exitTimeoutMs: 1000, pollMs: 10 });
  const copyAt = events.indexOf('copy');
  const lastPoll = events.reduce((acc, e, i) => (e.startsWith('poll:') ? i : acc), -1);
  assert.ok(copyAt > -1, '还原确实发生了');
  assert.equal(events.filter((e) => e === 'copy').length, 1, '还原只发生在进程退出之后这一次');
  assert.ok(lastPoll > -1, 'stop 必须查过进程是否还在');
  assert.ok(lastPoll < copyAt, `顺序应为"轮询到进程消失"->"还原"，实际事件：${events.join(' | ')}`);
  assert.deepEqual(r.stillRunning, [], '最终三个镜像都退出了');
  assert.match(fs.readFileSync(path.join(cfg, 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m);
  assert.equal(r.systemProxyEnabled, false, 'ProxyEnable=0x0 应读成 false');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('进程杀不掉时 stop 依然要还原配置并上报，等待有上限', async () => {
  const dir = mkSandbox('stop-stuck');
  const cmds = [];
  const execFile = (cmd, args) => {
    cmds.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'tasklist') return Promise.resolve({ stdout: 'clash-verge.exe   1234 Console 1 10 K\nverge-mihomo.exe   5678 Console 1 10 K\n' });
    if (cmd === 'reg') return Promise.resolve({ stdout: '    ProxyEnable    REG_DWORD    0x0\n' });
    return Promise.resolve({ stdout: '' });
  };
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: fs, execFile,
  });
  await cvr.backup(['verge.yaml']);
  await cvr.suppressSystemProxy();
  const t0 = Date.now();
  const r = await cvr.stop({ restore: true, exitTimeoutMs: 250, pollMs: 50 });
  assert.ok(Date.now() - t0 < 4000, `等不到退出也不能挂住，实测 ${Date.now() - t0}ms`);
  assert.equal(r.stillRunning.length, 2, 'clash-verge.exe 与 verge-mihomo.exe 仍存活');
  assert.equal(r.restored, true, '等不到退出也要把压制还原掉');
  assert.ok(r.warnings.some((w) => /仍在运行/.test(w)), '要把没杀干净报成警告');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('waitForExit 靠镜像名判断存活，不受 tasklist 中文提示的 GBK 乱码影响', async () => {
  const dir = mkSandbox('wait-exit-buffer');
  const nongbk = Buffer.from('信息: 没有运行的任务匹配指定标准。\r\n', 'latin1'); // 真机 stdout 是 Buffer，码页还不是 UTF-8
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: fs,
    execFile: () => Promise.resolve({ stdout: nongbk }),
  });
  assert.deepEqual(await cvr.waitForExit(['clash-verge.exe', 'verge-mihomo.exe'], { timeoutMs: 300, pollMs: 20 }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('核心已停但系统代理还开着时，stop 要报出泄漏并给出修复命令，且不自己写注册表', async () => {
  const dir = mkSandbox('stop-leak');
  const cmds = [];
  const execFile = (cmd, args) => {
    cmds.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'reg') return Promise.resolve({ stdout: '    ProxyEnable    REG_DWORD    0x1\n' });
    return Promise.resolve({ stdout: '' });
  };
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: fs, execFile,
  });
  await cvr.backup(['verge.yaml']);
  await cvr.suppressSystemProxy();
  const r = await cvr.stop({ restore: true, exitTimeoutMs: 200, pollMs: 50 });
  assert.equal(r.systemProxyEnabled, true);
  const leak = r.warnings.find((w) => /ProxyEnable/.test(w));
  assert.ok(leak && /reg add/.test(leak), `泄漏警告里必须带上用户可执行的修复命令，实际：${leak}`);
  assert.ok(cmds.every((c) => !/^reg (add|delete)\b/i.test(c)), '插件只能读注册表，不能写');
  assert.ok(cmds.some((c) => /^reg query\b/i.test(c)), '确实做过只读复查');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- 缺陷 ⑧：被中断的 core_start 会把"压制系统代理"留成无主状态 ---------- */

const markerOf = (dir) => path.join(dir, 'suppression.json');
const readMarker = (dir) => JSON.parse(fs.readFileSync(markerOf(dir), 'utf8'));
const entryOf = (m, key) => m.entries.find((e) => e.key === key);

test('start(session) 压制成功后落 marker，把压制前的原值记在盘上', async () => {
  const dir = mkSandbox('marker-write');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, markerPath: markerOf(dir),
    spawn: () => ({ unref() {} }), waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  const r = await cvr.start({ scope: 'session' });
  assert.ok(r.suppressionMarker, '返回值要自证落了 marker，否则调用方还得自己去猜');
  assert.equal(r.suppressionMarker.path, markerOf(dir));
  const m = readMarker(dir);
  const proxy = entryOf(m, 'enable_system_proxy');
  assert.deepEqual([proxy.before, proxy.after], ['true', 'false'],
    '必须记下压制前的值：进程一被中断，"该改回什么"就只剩这份记录知道');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start(global) 没改系统代理，也就不该留下 marker', async () => {
  const dir = mkSandbox('marker-global');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, markerPath: markerOf(dir),
    spawn: () => ({ unref() {} }), waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  const r = await cvr.start({ scope: 'global' });
  assert.equal(r.suppressionMarker, null);
  assert.ok(!fs.existsSync(markerOf(dir)), '没压制过就不要凭空造一份"看起来欠着东西"的记录');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stop 把值还原到位后清除 marker', async () => {
  const dir = mkSandbox('marker-clear');
  const cfg = path.join(dir, 'config');
  const mk = () => new C.CvrConfig({
    configDir: cfg, backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: fs,
    markerPath: markerOf(dir), execFile: () => Promise.resolve({ stdout: '' }),
    spawn: () => ({ unref() {} }), waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  await mk().start({ scope: 'session' });
  assert.ok(fs.existsSync(markerOf(dir)));
  const r = await mk().stop({ restore: true, exitTimeoutMs: 200, pollMs: 50 });
  assert.match(fs.readFileSync(path.join(cfg, 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m);
  assert.equal(r.suppression.cleared, true);
  assert.ok(!fs.existsSync(markerOf(dir)), '正常一轮走完，marker 必须跟着消失');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('跨会话的无主压制：备份链本身就是压制态时，stop 仍要按 marker 记的原值补写', async () => {
  // 真机踩法：会话 A 的 core_start 之后调用方进程被 SIGPIPE 打死（没有 stop），
  // 会话 B 的 core_start 又"备份"了一次已经是压制态的 verge.yaml ——
  // 于是 stop() 光靠"还原最近一份备份"永远修不好，压制成了孤儿。
  const dir = mkSandbox('marker-orphan');
  const cfg = path.join(dir, 'config');
  const mk = () => new C.CvrConfig({
    configDir: cfg, backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: fs,
    markerPath: markerOf(dir), execFile: () => Promise.resolve({ stdout: '' }),
    spawn: () => ({ unref() {} }), waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  await mk().start({ scope: 'session' });
  await mk().backup(['verge.yaml']); // 会话 B 的入口备份：内容已经是 enable_system_proxy: false
  assert.match(fs.readFileSync(path.join(cfg, 'verge.yaml'), 'utf8'), /^enable_system_proxy: false$/m);
  const r = await mk().stop({ restore: true, exitTimeoutMs: 200, pollMs: 50 });
  const text = fs.readFileSync(path.join(cfg, 'verge.yaml'), 'utf8');
  assert.match(text, /^enable_system_proxy: true$/m, '无主压制必须被补还原，不能只信备份链');
  assert.deepEqual(r.suppression.repaired.map((x) => x.key).sort(), ['enable_proxy_guard', 'enable_system_proxy']);
  assert.equal(r.suppression.cleared, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('第二次 start 不能把 marker 里的原值覆盖成压制值', async () => {
  const dir = mkSandbox('marker-merge');
  const cfg = path.join(dir, 'config');
  const mk = () => new C.CvrConfig({
    configDir: cfg, backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: fs,
    markerPath: markerOf(dir), execFile: () => Promise.resolve({ stdout: '' }),
    spawn: () => ({ unref() {} }), waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  await mk().start({ scope: 'session' });
  await mk().start({ scope: 'session' }); // 上一轮的压制还没还原，这一轮的"前值"就是 false
  const m = readMarker(dir);
  assert.equal(entryOf(m, 'enable_system_proxy').before, 'true',
    'marker 记的是"用户自己的值"，多次压制只能合并、不能把原值洗成 false');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stop({restore:false}) 要保留 marker：压制还在生效，不能装作已经交还', async () => {
  const dir = mkSandbox('marker-keep');
  const cfg = path.join(dir, 'config');
  const mk = () => new C.CvrConfig({
    configDir: cfg, backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: fs,
    markerPath: markerOf(dir), execFile: () => Promise.resolve({ stdout: '' }),
    spawn: () => ({ unref() {} }), waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  await mk().start({ scope: 'session' });
  const r = await mk().stop({ restore: false });
  assert.equal(r.suppression.present, true, '没还原就得承认还欠着');
  assert.equal(r.suppression.cleared, false);
  assert.ok(fs.existsSync(markerOf(dir)));
  assert.match(fs.readFileSync(path.join(cfg, 'verge.yaml'), 'utf8'), /^enable_system_proxy: false$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start 失败回滚时也要把 marker 撤掉，不留假欠条', async () => {
  const dir = mkSandbox('marker-rollback');
  const mk = (waitForChannel) => new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, markerPath: markerOf(dir),
    spawn: () => ({ unref() {} }), waitForChannel,
  });
  // 先让一轮成功的 start 把 marker 落到盘上：否则这条用例在"根本没写过 marker"的实现上
  // 也会通过，测的就不是"回滚会撤欠条"而是"欠条从来不存在"。
  await mk(async () => ({ kind: 'pipe', ports: {} })).start({ scope: 'session' });
  assert.ok(fs.existsSync(markerOf(dir)), '前置条件：这一轮成功压制并留下 marker');
  await assert.rejects(mk(async () => { throw new C.ApiError('channel_unavailable', '不可达'); }).start({ scope: 'session' }));
  assert.ok(!fs.existsSync(markerOf(dir)), '配置已回滚，marker 若还留着就是在谎称"欠着压制"');
  // 入口备份此刻本身就是压制态（第一轮 start 留下的），只靠 restoreFrom 回不到用户的原值，
  // 所以失败路径也要按 marker 记的 before 补写一次 —— 否则"启动失败机器状态不变"这句承诺是假的。
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listBackups 以时间戳为主键：mtime 更旧但 ts 更晚的备份排第一', async () => {
  // fs.copyFileSync 走 Win32 CopyFile，会原样保留源文件 mtime（真机实测），
  // 所以 mtime 一旦当主键，"哪份备份最新"就会在"复制旧基座 -> 落新备份"的流程里判错。
  const dir = mkSandbox('ts-primary');
  const bd = path.join(dir, 'backups');
  const f = path.join(dir, 'config', 'verge.yaml');
  const laterTsOlderMtime = path.join(bd, 'verge.yaml.20260930-235959-999-001.bak');
  const earlierTsNewerMtime = path.join(bd, 'verge.yaml.20260930120000000-001.bak');
  fs.writeFileSync(laterTsOlderMtime, 'REAL_NEWEST');
  fs.writeFileSync(earlierTsNewerMtime, 'STALE_BUT_FRESH_MTIME');
  const old = (d) => new Date(Date.UTC(2026, 7, d, 0, 0, 0)); // 8 月，比另一份的 9 月早
  fs.utimesSync(laterTsOlderMtime, old(1), old(1));
  fs.utimesSync(earlierTsNewerMtime, old(28), old(28));
  const cvr = new C.CvrConfig({ configDir: path.join(dir, 'config'), backupDir: bd, exePath: exe(dir), fsImpl: fs });
  assert.equal(cvr.listBackups()[0].backupPath, laterTsOlderMtime, '排序主键必须是 ts，不是 mtime');
  await cvr.restore(['verge.yaml']);
  assert.equal(fs.readFileSync(f, 'utf8'), 'REAL_NEWEST', '还原要挑真正晚近的那份');
  fs.rmSync(dir, { recursive: true, force: true });
});
