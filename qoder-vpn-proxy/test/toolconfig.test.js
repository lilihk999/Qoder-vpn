'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TC = require('../server/toolconfig');

const USER_NPMRC = 'registry=https://registry.npmmirror.com\n//registry.npmjs.org/:_authToken=abc\nfund=false\n';

function mkGit(initial = {}) {
  const store = { ...initial };
  const log = [];
  return {
    log,
    store,
    runner: async (args) => {
      log.push(args.join(' '));
      if (args[0] === 'config' && args[1] === '--global' && args[2] === '--get-regexp') {
        const re = new RegExp(args[3].replace(/^\^/, ''));
        const lines = Object.entries(store).filter(([k]) => re.test(k)).map(([k, v]) => `${k} ${v}`);
        return { code: lines.length ? 0 : 1, stdout: lines.join('\n'), stderr: '' };
      }
      if (args[2] === '--unset') { delete store[args[3]]; return { code: 0, stdout: '', stderr: '' }; }
      // 写入形态是 `config --global <key> <value>`：key 在 2 不在 3
      store[args[2]] = args[3];
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function mk(t, content = USER_NPMRC) {
  const dir = path.join(os.tmpdir(), `qvp-tc-${t}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  const npmrc = path.join(dir, '.npmrc');
  fs.writeFileSync(npmrc, content);
  const git = mkGit();
  const tc = new TC.ToolConfig({ npmrcPath: npmrc, gitRunner: git.runner, backupDir: path.join(dir, 'backups'), fsImpl: fs });
  return { dir, npmrc, git, tc };
}

test('buildNpmrcBlock 生成托管块且不动用户行', () => {
  const r = TC.buildNpmrcBlock(USER_NPMRC, { proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost,127.0.0.1' });
  assert.equal(r.hadBlock, false);
  assert.ok(r.text.startsWith(USER_NPMRC), '用户内容原样在开头');
  assert.ok(r.text.includes(TC.MARK_BEGIN) && r.text.includes(TC.MARK_END));
  assert.match(r.text, /^https-proxy=http:\/\/127\.0\.0\.1:7897$/m);
  assert.match(r.text, /^noproxy=localhost,127\.0\.0\.1$/m);
});

test('buildNpmrcBlock 幂等：重复 apply 只保留一个块', () => {
  const once = TC.buildNpmrcBlock(USER_NPMRC, { proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  const twice = TC.buildNpmrcBlock(once.text, { proxyUrl: 'http://127.0.0.1:7890', noproxy: 'localhost' });
  assert.equal(twice.hadBlock, true);
  assert.equal((twice.text.match(/>>> qoder-vpn-proxy/g) || []).length, 1);
  assert.ok(!twice.text.includes('7897'), '旧端口被替换');
  assert.equal((twice.text.match(/^registry=/gm) || []).length, 1, '用户行没被复制');
});

test('stripNpmrcBlock 精确还原原文件', () => {
  const applied = TC.buildNpmrcBlock(USER_NPMRC, { proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  const back = TC.stripNpmrcBlock(applied.text);
  assert.equal(back.hadBlock, true);
  assert.equal(back.text, USER_NPMRC, '逐字节还原');
  assert.equal(TC.stripNpmrcBlock(USER_NPMRC).hadBlock, false, '没有块时不动');
});

test('gitProxyKeys 只生成域名前缀项，绝不生成 http.proxy', () => {
  const keys = TC.gitProxyKeys(['github.com', 'api.github.com']);
  assert.deepEqual(keys, ['http.https://github.com/.proxy', 'http.https://api.github.com/.proxy']);
  assert.ok(!keys.some((k) => k === 'http.proxy' || k === 'https.proxy'), '禁止全局 http.proxy');
});

test('apply 写 npmrc 与 git，并留下备份', async () => {
  const { dir, npmrc, git, tc } = mk('apply');
  const r = await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  assert.equal(r.npm.action, 'written');
  assert.equal(r.npm.before, USER_NPMRC);
  assert.match(fs.readFileSync(npmrc, 'utf8'), /proxy=http:\/\/127\.0\.0\.1:7897/);
  assert.equal(r.git.applied.length, TC.gitProxyKeys().length);
  assert.ok(git.log.every((l) => /config --global http\.https:\/\//.test(l)), git.log.join(' | '));
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.includes('.npmrc')), 'npmrc 有备份');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('apply 两次不产生重复块，git 值被更新', async () => {
  const { dir, npmrc, git, tc } = mk('idempotent');
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7890', noproxy: 'localhost' });
  const text = fs.readFileSync(npmrc, 'utf8');
  assert.equal((text.match(/>>> qoder-vpn-proxy/g) || []).length, 1);
  assert.ok(!text.includes('7897'));
  assert.equal(Object.values(git.store).filter((v) => v === 'http://127.0.0.1:7890').length, TC.gitProxyKeys().length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('apply 拒绝非 127.0.0.1 的 proxyUrl，且不留痕', async () => {
  const { dir, npmrc, git, tc } = mk('badproxy');
  await assert.rejects(tc.apply({ proxyUrl: 'http://10.0.0.9:7897' }), (e) => e.kind === 'malformed_config');
  await assert.rejects(tc.apply({ proxyUrl: 'socks5://127.0.0.1:7898' }), (e) => e.kind === 'malformed_config');
  assert.equal(fs.readFileSync(npmrc, 'utf8'), USER_NPMRC);
  assert.deepEqual(git.log, [], '校验在动 git 之前');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('revert 只删托管块，用户手写的 proxy 行逐字节保留', async () => {
  const { dir, npmrc, tc } = mk('keep-foreign', 'proxy=http://10.0.0.1:3128\nfund=false\n');
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', targets: ['npm'], noproxy: 'localhost' });
  await tc.revert({ targets: ['npm'] });
  assert.equal(fs.readFileSync(npmrc, 'utf8'), 'proxy=http://10.0.0.1:3128\nfund=false\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('revert 之后 git 的 http.* 全空、npmrc 回到原文', async () => {
  const { dir, npmrc, git, tc } = mk('revert');
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  await tc.revert({});
  assert.deepEqual(Object.keys(git.store), [], 'git 全局 http.* 清空（对应验收 6）');
  assert.equal(fs.readFileSync(npmrc, 'utf8'), USER_NPMRC);
  const again = await tc.revert({});
  assert.equal(again.npm.action, 'noop');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status 三种状态可区分：clean / managed / foreign', async () => {
  const clean = mk('clean');
  assert.equal((await clean.tc.status({})).verdict, 'clean');

  const managed = mk('managed');
  await managed.tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  const s = await managed.tc.status({});
  assert.equal(s.verdict, 'managed');
  assert.equal(s.npmrc.managed, true);
  assert.ok(s.git.managed.every((m) => m.value === m.expected && m.expected === 'http://127.0.0.1:7897'));
  assert.equal(s.git.mismatch, false);

  const foreign = mk('foreign', 'proxy=http://10.0.0.1:3128\n');
  const fs2 = await foreign.tc.status({});
  assert.equal(fs2.verdict, 'foreign', '用户自己写过 proxy 但不是我们的块');
  assert.ok(fs2.npmrc.proxyLines.some((l) => l.includes('10.0.0.1')));
  for (const x of [clean, managed, foreign]) fs.rmSync(x.dir, { recursive: true, force: true });
});

test('status 能发现 git 值与期望端口不一致（partial）', async () => {
  const { dir, tc, git } = mk('partial');
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  for (const k of TC.gitProxyKeys()) git.store[k] = 'http://127.0.0.1:8888';
  const s = await tc.status({ expectedProxyUrl: 'http://127.0.0.1:7897' });
  assert.equal(s.git.mismatch, true);
  assert.equal(s.verdict, 'partial');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('git 步骤失败时 npmrc 回滚，不留半改', async () => {
  const dir = path.join(os.tmpdir(), `qvp-tc-gitfail-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  const npmrc = path.join(dir, '.npmrc');
  fs.writeFileSync(npmrc, USER_NPMRC);
  const tc = new TC.ToolConfig({
    npmrcPath: npmrc,
    gitRunner: async () => ({ code: 128, stdout: '', stderr: 'unable to read ~/.gitconfig' }),
    backupDir: path.join(dir, 'backups'),
    fsImpl: fs,
  });
  await assert.rejects(tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' }), (e) => e.kind === 'config_write_failed');
  assert.equal(fs.readFileSync(npmrc, 'utf8'), USER_NPMRC, 'npm 半边不能单独留下托管块');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npmrc 不存在时 apply 会创建，revert 后留空文件而不是删掉用户目录里的项', async () => {
  const dir = path.join(os.tmpdir(), `qvp-tc-missing-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const npmrc = path.join(dir, '.npmrc');
  const tc = new TC.ToolConfig({ npmrcPath: npmrc, gitRunner: mkGit().runner, backupDir: path.join(dir, 'b'), fsImpl: fs });
  const r = await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', targets: ['npm'], noproxy: 'localhost' });
  assert.equal(r.npm.created, true);
  assert.ok(fs.existsSync(npmrc));
  const back = await tc.revert({ targets: ['npm'] });
  assert.equal(back.npm.action, 'removed-created', '插件创建的文件由插件自己收掉');
  assert.ok(!fs.existsSync(npmrc));
  fs.rmSync(dir, { recursive: true, force: true });
});
