'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../server/discovery');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const sandbox = (name) => path.join(__dirname, name);

test('topScalar 处理引号、空串与缺失', () => {
  assert.equal(D.topScalar('secret: set-your-secret\n', 'secret'), 'set-your-secret');
  assert.equal(D.topScalar("external-controller: ''\n", 'external-controller'), null);
  assert.equal(D.topScalar('mixed-port: 7897\n', 'mixed-port'), '7897');
  assert.equal(D.topScalar('a: 1\n', 'missing'), null);
  assert.equal(D.topScalar('a: null\n', 'a'), null, 'YAML 裸 null 等于没有值');
  assert.equal(D.topScalar("a: 'null'\n", 'a'), 'null', '带引号的 null 是真字符串');
  assert.equal(D.topScalar('tun:\n  enable: false\n', 'enable'), null, '缩进行不能当顶层键');
});

test('nestedBool 顶格读子块', () => {
  assert.equal(D.nestedBool('tun:\n  enable: false\n  stack: system\n', 'tun', 'enable'), false);
  assert.equal(D.nestedBool('tun:\n  enable: true\n', 'tun', 'enable'), true);
  assert.equal(D.nestedBool('tun: {}\n', 'tun', 'enable'), null);
  assert.equal(D.nestedBool('interface-name: tun0\n', 'tun', 'enable'), null);
});

test('parseRuntimeYaml 取端口、双通道、secret、mode、tun', () => {
  const r = D.parseRuntimeYaml(fx('cvr-config.yaml'));
  assert.equal(r.ports.mixed, 7897);
  assert.equal(r.ports.socks, 7898);
  assert.equal(r.ports.http, 7899);
  assert.equal(r.controller.tcp, '127.0.0.1:9097');
  assert.equal(r.controller.pipe, '\\\\.\\pipe\\verge-mihomo');
  assert.equal(r.secret, 'set-your-secret');
  assert.equal(r.mode, 'rule');
  assert.equal(r.tunEnabled, false);
});

test('parseVergeYaml 读开关而不猜默认', () => {
  const s = D.parseVergeYaml(fx('cvr-verge.yaml'));
  assert.equal(s.enableExternalController, false);
  assert.equal(s.enableSystemProxy, true);
  assert.equal(s.enableTunMode, false);
  assert.equal(s.mixedPort, 7897);
  assert.equal(s.systemProxyBypass, null, '裸 null 不能变成字符串 "null"');
  const empty = D.parseVergeYaml('# nothing\n');
  assert.equal(empty.enableExternalController, null);
  assert.equal(empty.mixedPort, null);
});

test('开关 false 时 controller.tcp 为 null 但保留 tcpConfigured', () => {
  const c = D.mergeController(D.parseRuntimeYaml(fx('cvr-config.yaml')), D.parseVergeYaml(fx('cvr-verge.yaml')));
  assert.equal(c.tcp, null);
  assert.equal(c.tcpConfigured, '127.0.0.1:9097');
  assert.equal(c.tcpEnabled, false);
  assert.equal(c.pipe, '\\\\.\\pipe\\verge-mihomo');
  const on = D.mergeController(D.parseRuntimeYaml(fx('cvr-config.yaml')), { enableExternalController: true });
  assert.equal(on.tcp, '127.0.0.1:9097');
  const unknown = D.mergeController(D.parseRuntimeYaml(fx('cvr-config.yaml')), { enableExternalController: null });
  assert.equal(unknown.tcp, '127.0.0.1:9097', '未知开关时保留声明值，交给探活判定');
});

test('mergePorts：verge 覆盖 config，缺失则回落', () => {
  assert.deepEqual(
    D.mergePorts({ mixed: 7897, socks: 7898, http: 7899 }, { mixedPort: 7890, socksPort: null, httpPort: 7899 }),
    { mixed: 7890, socks: 7898, http: 7899 }
  );
  assert.deepEqual(D.mergePorts({ mixed: null, socks: null, http: null }, {}), { mixed: null, socks: null, http: null });
});

test('parseProfilesYaml 认出 current、全部 item 与类型差异', () => {
  const p = D.parseProfilesYaml(fx('cvr-profiles.yaml'));
  assert.equal(p.current, 'TESTUIDd7225');
  assert.equal(p.items.length, 8);
  const remote = p.items.filter((i) => i.type === 'remote');
  assert.equal(remote.length, 1);
  assert.equal(remote[0].uid, 'TESTUIDd7225');
  assert.equal(remote[0].name, '测试订阅');
  assert.match(remote[0].url, /token=TOKEN_PLACEHOLDER$/);
  assert.ok(p.items.filter((i) => i.type === 'merge').every((i) => i.url === null), '本地项没有 url 字段，不能凭空造');
  assert.equal(p.items.find((i) => i.uid === 'Merge').updated, 1787138083);
});

test('discover：目录不存在时 installed:false 且 hint 可执行', async () => {
  const rt = await D.discover({
    env: {
      APPDATA: sandbox('no-such-dir'),
      ProgramFiles: sandbox('no-such-dir'),
      QVP_CONFIG_DIR: '',
      // 必须显式覆盖安装目录候选：本机 C:\Program Files\Clash Verge 真实存在，
      // 留着硬编码兜底候选会让这条测试只在"没装 CVR 的机器"上过。
      QVP_INSTALL_CANDIDATES: sandbox('no-such-dir'),
    },
    exec: async () => ({ stdout: '' }),
  });
  assert.equal(rt.installed, false);
  assert.equal(rt.running, false);
  assert.match(rt.channelHint, /安装/);
  assert.ok(rt.warnings.length > 0, '配置目录找不到时必须留 warning，否则调用方看不出为什么失败');
});

test('discover：真实形态沙箱组装 Runtime', async () => {
  const dir = sandbox('sandbox-task8');
  fs.rmSync(dir, { recursive: true, force: true });
  const appdata = path.join(dir, 'Roaming', D.CONFIG_DIR_NAME);
  fs.mkdirSync(path.join(appdata, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(appdata, 'config.yaml'), fx('cvr-config.yaml'));
  fs.writeFileSync(path.join(appdata, 'verge.yaml'), fx('cvr-verge.yaml'));
  fs.writeFileSync(path.join(appdata, 'profiles.yaml'), fx('cvr-profiles.yaml'));

  const rt = await D.discover({
    env: {
      APPDATA: path.join(dir, 'Roaming'),
      ProgramFiles: path.join(dir, 'PF'),
      QVP_INSTALL_CANDIDATES: path.join(dir, 'PF'),
    },
    exec: async () => ({ stdout: 'clash-verge.exe  1234 Console  1  50,000 K\n' }),
  });
  assert.equal(rt.configDir, appdata);
  assert.equal(rt.configSource, 'config.yaml');
  assert.equal(rt.running, true);
  assert.equal(rt.ports.mixed, 7897);
  assert.equal(rt.controller.tcp, null);
  assert.equal(rt.profiles.current, 'TESTUIDd7225');
  assert.equal(rt.secret, 'set-your-secret');
  assert.equal(rt.installed, false, 'PF 目录不存在，只装了配置目录不算 installed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('discover：config.yaml 缺失时降级到 clash-verge.yaml 并记 warning', async () => {
  const dir = sandbox('sandbox-task8b');
  fs.rmSync(dir, { recursive: true, force: true });
  const appdata = path.join(dir, 'Roaming', D.CONFIG_DIR_NAME);
  fs.mkdirSync(appdata, { recursive: true });
  fs.writeFileSync(path.join(appdata, 'clash-verge.yaml'), fx('cvr-config.yaml'));
  fs.writeFileSync(path.join(appdata, 'profiles.yaml'), fx('cvr-profiles.yaml'));
  const rt = await D.discover({ env: { APPDATA: path.join(dir, 'Roaming') }, exec: async () => ({ stdout: '信息: 没有运行的任务\n' }) });
  assert.equal(rt.configSource, 'clash-verge.yaml');
  assert.ok(rt.warnings.some((w) => /verge\.yaml/.test(w)));
  assert.equal(rt.running, false);
  assert.equal(rt.controller.pipe, '\\\\.\\pipe\\verge-mihomo');
  fs.rmSync(dir, { recursive: true, force: true });
});
