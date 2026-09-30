'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../server/store');
const P = require('../server/profilesYaml');
const { SubscriptionRepo } = require('../server/subscriptions');

const PROFILES = fs.readFileSync(path.join(__dirname, 'fixtures', 'cvr-profiles.yaml'), 'utf8');
const FIXTURE_URL = 'https://panel.example.invalid/SUBPATH?token=TOKEN_PLACEHOLDER';

const FETCH_OK = {
  format: 'yaml',
  yaml: 'proxies:\n- name: HK 1\n  server: 192.0.2.10\nproxy-groups: []\n',
  nodes: 3,
  bytes: 20000,
  name: '新机场',
  userInfo: { upload: 1, download: 2, total: 1 << 30, expire: 1798761600 },
};
const fetchImpl = async (url) => {
  if (url.includes('bad')) {
    const e = new Error('html');
    e.kind = 'subscription_format_unexpected';
    throw e;
  }
  return FETCH_OK;
};

function sandbox(t) {
  const dir = path.join(os.tmpdir(), `qvp-sub-${t}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const configDir = path.join(dir, 'cvr');
  fs.mkdirSync(path.join(configDir, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'profiles.yaml'), PROFILES);
  fs.writeFileSync(path.join(configDir, 'verge.yaml'), 'enable_system_proxy: true\nenable_proxy_guard: true\n');
  const dirs = store.ensure(store.dirs({ QODER_VPN_PROXY_DATA: path.join(dir, 'data') }));
  const reloads = [];
  const client = {
    reload: async (o) => { reloads.push(o); return { reloaded: true }; },
    getProxies: async () => ({ groups: [{ name: '节点选择', now: 'HK 1', all: ['HK 1'], type: 'Selector' }], nodes: ['HK 1'] }),
    close() {},
  };
  const repo = new SubscriptionRepo({ configDir, dirs, fetchImpl, now: () => 1790000000, client });
  return { dir, configDir, dirs, repo, reloads };
}

test('首次 list 从 profiles.yaml 导入 remote 项，url 已脱敏', async () => {
  const { dir, repo } = sandbox('list');
  const items = await repo.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].uid, 'TESTUIDd7225');
  assert.equal(items[0].name, '测试订阅');
  assert.equal(items[0].active, true);
  assert.equal(items[0].source, 'cvr');
  assert.match(items[0].url, /token=<redacted>$/);
  assert.ok(!items[0].urlPathOnly.includes('TOKEN_PLACEHOLDER'), 'urlPathOnly 也不能带 query');
  assert.equal(items[0].nodes, null, '没抓过就报 null，不能编节点数');
  assert.ok(!JSON.stringify(items).includes('TOKEN_PLACEHOLDER'), '任何字段都不出现原 token');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 生成 12 位 uid、写 profile 文件与注册表、返回条目', async () => {
  const { dir, configDir, dirs, repo } = sandbox('add');
  const e = await repo.add({ url: 'https://b.test/sub?token=XYZ', name: '第二家', remark: '备用' });
  assert.match(e.uid, /^[A-Za-z0-9]{12}$/);
  assert.equal(e.name, '第二家');
  assert.equal(e.remark, '备用');
  assert.equal(e.source, 'plugin');
  assert.equal(e.nodes, 3);
  assert.ok(fs.existsSync(path.join(configDir, 'profiles', `${e.uid}.yaml`)));
  const raw = fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8');
  assert.ok(raw.includes(`uid: ${e.uid}`));
  assert.ok(raw.includes('token=XYZ'), 'profiles.yaml 里是原 token（CVR 需要用它抓取）');
  // 备份命名要跟 CvrConfig 一致，Task 15 的 proxy_restore_config 靠这个正则找可还原项
  assert.ok(store.listBackupsIn(dirs.backups).some((f) => /^profiles\.yaml\.[\d-]+\.bak$/.test(f)), '写注册表前必须已有备份');
  assert.equal((await repo.list()).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 只追加：原有 8 项逐字段完好', async () => {
  const { dir, configDir, repo } = sandbox('add-intact');
  const before = P.listItems(PROFILES);
  const e = await repo.add({ url: 'https://b.test/sub?token=XYZ' });
  const after = P.listItems(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8'));
  assert.equal(after.length, 9);
  for (const b of before) assert.deepEqual(after.find((i) => i.uid === b.uid), b, `${b.uid} 应保持原样`);
  assert.equal(P.render(P.parse(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8'))), fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8'));
  assert.ok(after.find((i) => i.uid === e.uid).url.includes('token=XYZ'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 的 url 重复时报 subscription_duplicate 并给出已有 uid', async () => {
  const { dir, repo } = sandbox('dup');
  await assert.rejects(repo.add({ url: FIXTURE_URL }), (e) => e.kind === 'subscription_duplicate' && /TESTUIDd7225/.test(e.hint + e.message));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 非法 url 时报 subscription_url_invalid 且不抓取', async () => {
  const { dir, repo } = sandbox('badurl');
  await assert.rejects(repo.add({ url: 'ping.example.invalid/sub' }), (e) => e.kind === 'subscription_url_invalid');
  await assert.rejects(repo.add({ url: '' }), (e) => e.kind === 'subscription_url_invalid');
  assert.equal((await repo.list()).length, 1, '没写出第二项');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 带 activate:true 时改 current 并 reload', async () => {
  const { dir, configDir, repo, reloads } = sandbox('activate-add');
  const e = await repo.add({ url: 'https://b.test/sub?token=XYZ', activate: true });
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8').split('\n').find((l) => /^current:/.test(l)), `current: ${e.uid}`);
  assert.equal(reloads.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 抓取失败时一个文件都不写', async () => {
  const { dir, configDir, repo } = sandbox('addfetchfail');
  const before = fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8');
  await assert.rejects(repo.add({ url: 'https://bad.test/sub?token=X' }), (e) => e.kind === 'subscription_format_unexpected');
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8'), before);
  assert.equal(store.listBackupsIn(path.join(dir, 'data', 'backups')).length, 0, '没写就不该有备份');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('edit 改 url（token 轮换）后旧 profile 文件不被破坏', async () => {
  const { dir, configDir, repo } = sandbox('edit');
  fs.writeFileSync(path.join(configDir, 'profiles', 'TESTUIDd7225.yaml'), '# 原订阅内容\nproxies: []\n');
  const before = fs.readFileSync(path.join(configDir, 'profiles', 'TESTUIDd7225.yaml'), 'utf8');
  const e = await repo.edit('TESTUIDd7225', { url: 'https://panel.example.invalid/NEWPATH?token=NEW' });
  assert.match(e.url, /token=<redacted>$/);
  assert.ok(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8').includes('token=NEW'));
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles', 'TESTUIDd7225.yaml'), 'utf8'), before, 'edit url 不动内容文件；只有 update 才重写');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('edit 只改备注时不碰 profiles.yaml', async () => {
  const { dir, configDir, repo } = sandbox('edit-remark');
  const before = fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8');
  const e = await repo.edit('TESTUIDd7225', { remark: '主力' });
  assert.equal(e.remark, '主力');
  assert.equal(e.source, 'cvr', '只改备注不把它说成插件创建的');
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8'), before, 'CVR 拥有的文件一个字节都不动');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('edit 不存在的 uid -> subscription_not_found 且 hint 列出现有清单', async () => {
  const { dir, repo } = sandbox('notfound');
  await assert.rejects(repo.edit('NOPE', { name: 'x' }), (e) => e.kind === 'subscription_not_found' && /测试订阅/.test(e.hint));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('update 重写内容文件并回写 updated/extra', async () => {
  const { dir, configDir, repo } = sandbox('update');
  const e = await repo.update('TESTUIDd7225');
  const body = fs.readFileSync(path.join(configDir, 'profiles', 'TESTUIDd7225.yaml'), 'utf8');
  assert.match(body, /proxy-groups:/);
  assert.equal(e.updated, 1790000000);
  assert.equal(e.userInfo.total, 1 << 30);
  const raw = fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8');
  assert.ok(raw.includes('updated: 1790000000'));
  assert.ok(raw.includes('total: 1073741824'));
  assert.equal(P.render(P.parse(raw)), raw, '回写后仍要满足 round-trip 恒等');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('update 抓取失败时保留旧配置（内容文件与注册表都不动）', async () => {
  const { dir, configDir, repo } = sandbox('updatefail');
  const profilesBefore = fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8');
  fs.writeFileSync(path.join(configDir, 'profiles', 'TESTUIDd7225.yaml'), '# 旧内容\n');
  await assert.rejects(
    repo.update('TESTUIDd7225', { fetchImpl: async () => { const e = new Error('boom'); e.kind = 'subscription_format_unexpected'; throw e; } }),
    (e) => e.kind === 'subscription_format_unexpected'
  );
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8'), profilesBefore);
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles', 'TESTUIDd7225.yaml'), 'utf8'), '# 旧内容\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('activate 写 current、reload 并回读组确认', async () => {
  const { dir, configDir, repo, reloads } = sandbox('activate');
  const e = await repo.add({ url: 'https://b.test/sub?token=XYZ' });
  const r = await repo.activate(e.uid);
  assert.equal(r.current, e.uid);
  assert.equal(r.groups[0].now, 'HK 1');
  assert.equal(reloads.length, 1);
  assert.ok(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8').includes(`current: ${e.uid}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove 当前激活项且未 force -> subscription_active_protected', async () => {
  const { dir, repo } = sandbox('protected');
  await assert.rejects(repo.remove('TESTUIDd7225'), (e) => e.kind === 'subscription_active_protected');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove force 后文件进 .trash 且可还原', async () => {
  const { dir, configDir, dirs, repo } = sandbox('trash');
  fs.writeFileSync(path.join(configDir, 'profiles', 'TESTUIDd7225.yaml'), '# 可撤销\n');
  const r = await repo.remove('TESTUIDd7225', { force: true });
  assert.equal(r.trashed.length, 2, 'profile 内容文件 + profiles.yaml 备份都在回收/备份体系里');
  assert.ok(!fs.existsSync(path.join(configDir, 'profiles', 'TESTUIDd7225.yaml')));
  const raw = fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8');
  assert.ok(!raw.includes('uid: TESTUIDd7225'));
  assert.equal((await repo.list()).length, 0);
  const trashed = store.listTrash(dirs);
  assert.ok(trashed.some((t) => t.endsWith('TESTUIDd7225.yaml')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('写 profiles.yaml 后被外部覆盖 -> profile_registry_desync 并回滚', async () => {
  const { dir, configDir, repo } = sandbox('desync');
  // 模拟 CVR 内存态回写覆盖：写入钩子里把文件改回原样
  const realWrite = fs.writeFileSync.bind(fs);
  const before = fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8');
  let fired = false;
  fs.writeFileSync = (p, data, ...rest) => {
    if (String(p).endsWith('profiles.yaml') && !fired) { fired = true; return realWrite(p, before, ...rest); }
    return realWrite(p, data, ...rest);
  };
  await assert.rejects(
    repo.add({ url: 'https://c.test/sub?token=Q', name: '会被回滚的' }),
    (e) => e.kind === 'profile_registry_desync'
  );
  fs.writeFileSync = realWrite;
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8'), before, '回滚到备份，不留半改');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updateAll 一条失败不影响另一条', async () => {
  const { dir, repo } = sandbox('all');
  await repo.add({ url: 'https://b.test/sub?token=XYZ', name: '好的' });
  const out = await repo.updateAll({
    fetchImpl: async (url) => {
      if (url.includes('panel.example.invalid')) {
        const e = new Error('html');
        e.kind = 'subscription_format_unexpected';
        throw e;
      }
      return FETCH_OK;
    },
  });
  assert.equal(out.results.length, 2);
  assert.equal(out.results.filter((r) => r.ok).length, 1);
  assert.equal(out.results.filter((r) => !r.ok).length, 1);
  assert.equal(out.results.find((r) => !r.ok).kind, 'subscription_format_unexpected');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('updateAll 跳过 autoUpdate 关闭的项', async () => {
  const { dir, repo } = sandbox('all-skip');
  const e = await repo.add({ url: 'https://b.test/sub?token=XYZ', autoUpdate: false });
  const out = await repo.updateAll();
  assert.equal(out.results.find((r) => r.uid === e.uid).kind, 'skipped');
  assert.equal(out.results.filter((r) => r.ok).length, 1, '另一条（当前订阅）照常更新');
  fs.rmSync(dir, { recursive: true, force: true });
});
