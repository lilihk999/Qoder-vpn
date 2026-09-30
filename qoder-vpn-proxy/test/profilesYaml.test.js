'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../server/profilesYaml');

const RAW = fs.readFileSync(path.join(__dirname, 'fixtures', 'cvr-profiles.yaml'), 'utf8');

test('round-trip 恒等（这是本层的验收定义）', () => {
  assert.equal(P.render(P.parse(RAW)), RAW);
});

test('listItems 读出 8 项，字段与真实文件一致', () => {
  const items = P.listItems(RAW);
  assert.equal(items.length, 8);
  const remote = items.find((i) => i.uid === 'TESTUIDd7225');
  assert.equal(remote.type, 'remote');
  assert.equal(remote.name, '测试订阅');
  assert.equal(remote.file, 'TESTUIDd7225.yaml');
  assert.equal(remote.url, 'https://panel.example.invalid/SUBPATH?token=TOKEN_PLACEHOLDER');
  assert.equal(remote.extra.download, '53636662825');
  assert.equal(remote.option.update_interval, '1440');
  assert.equal(remote.option.allow_auto_update, 'true');
  assert.equal(items.find((i) => i.uid === 'Merge').url, null);
});

test('setCurrent 只改 current 行', () => {
  const out = P.setCurrent(RAW, 'Merge');
  assert.equal(P.render(P.parse(out)), out, '仍然恒等');
  const diff = RAW.split('\n').map((l, i) => (l === out.split('\n')[i] ? null : i + 1)).filter(Boolean);
  assert.deepEqual(diff, [3], '只有 current 那一行');
  assert.equal(P.parse(out).blocks.length, 8);
});

test('setCurrent 到不存在的 uid -> subscription_not_found', () => {
  assert.throws(() => P.setCurrent(RAW, 'NOPE'), (e) => e.kind === 'subscription_not_found');
});

test('setField 改 url 与 name，且不波及其他项', () => {
  let out = P.setField(RAW, 'TESTUIDd7225', 'url', 'https://example.test/new?token=T2');
  out = P.setField(out, 'TESTUIDd7225', 'name', '新机场');
  assert.equal(P.getItem(out, 'TESTUIDd7225').url, 'https://example.test/new?token=T2');
  assert.equal(P.getItem(out, 'TESTUIDd7225').name, '新机场');
  assert.equal(P.listItems(out).length, 8);
  assert.equal(P.render(P.parse(out)), out);
  assert.equal(P.getItem(out, 'Merge').url, null, 'merge 项不受影响');
});

test('setField 缺失键时追加（给本地项补 url 也能成立）', () => {
  const out = P.setField(RAW, 'Merge', 'remark', '我的合并');
  assert.match(out, /^  remark: 我的合并$/m);
  assert.equal(P.getItem(out, 'Merge').file, 'Merge.yaml');
});

test('setNested 改 extra.download 与 option.allow_auto_update', () => {
  let out = P.setNested(RAW, 'TESTUIDd7225', 'extra', 'download', '999');
  out = P.setNested(out, 'TESTUIDd7225', 'option', 'allow_auto_update', 'false');
  assert.equal(P.listItems(out).find((i) => i.uid === 'TESTUIDd7225').extra.download, '999');
  assert.equal(P.listItems(out).find((i) => i.uid === 'TESTUIDd7225').option.allow_auto_update, 'false');
  assert.equal(P.render(P.parse(out)), out);
});

test('setNested 父键缺失时创建', () => {
  const out = P.setNested(RAW, 'Merge', 'extra', 'total', '0');
  assert.match(out, /^  extra:\n    total: 0$/m);
  assert.equal(P.listItems(out).find((i) => i.uid === 'Merge').extra.total, '0');
});

test('setSelected 整体替换 selected 列表', () => {
  const out = P.setSelected(RAW, 'TESTUIDd7225', { name: '测试订阅', now: 'HK 3 | v4' });
  assert.match(out, /^  selected:\n  - name: 测试订阅\n    now: HK 3 \| v4$/m);
  assert.equal(P.render(P.parse(out)), out);
  assert.equal(P.listItems(out).length, 8, '没有吞掉 extra: 块');
});

test('appendItem 追加合法 remote 项并可读回', () => {
  const item = {
    uid: 'NewUid123456', type: 'remote', name: '第二家', file: 'NewUid123456.yaml',
    url: 'https://b.test/sub?token=T', updated: 1790000000,
    extra: { upload: 0, download: 0, total: 0, expire: 0 },
    option: { update_interval: 1440, allow_auto_update: true },
  };
  const out = P.appendItem(RAW, item);
  const items = P.listItems(out);
  assert.equal(items.length, 9);
  const added = items.find((i) => i.uid === 'NewUid123456');
  assert.equal(added.name, '第二家');
  assert.equal(added.option.allow_auto_update, 'true');
  assert.equal(P.render(P.parse(out)), out, '新文件仍然恒等');
});

test('removeItem 只删目标块', () => {
  const out = P.removeItem(RAW, 'TESTUIDd7225');
  const items = P.listItems(out);
  assert.equal(items.length, 7);
  assert.ok(!items.some((i) => i.uid === 'TESTUIDd7225'));
  assert.equal(items.find((i) => i.uid === 'TESTUIDc197f').type, 'groups', '最后一块的其他项完好');
  assert.ok(out.endsWith('\n'), '删掉末块也要保留文件末尾换行，CVR 自己的写法就是这样');
  assert.throws(() => P.removeItem(RAW, 'NOPE'), (e) => e.kind === 'subscription_not_found');
});

test('uid 重复时报 malformed_config 而不是静默改第一个', () => {
  const dup = RAW.replace('uid: TESTUIDc197f', 'uid: TESTUIDd7225');
  assert.throws(() => P.setField(dup, 'TESTUIDd7225', 'name', 'X'), (e) => e.kind === 'malformed_config');
});

test('yamlScalar 处理 null、数字与含冒号的字符串', () => {
  assert.equal(P.yamlScalar(null), 'null');
  assert.equal(P.yamlScalar(7), '7');
  assert.equal(P.yamlScalar(true), 'true');
  assert.equal(P.yamlScalar('测试订阅'), '测试订阅');
  // 竖线只有在行首才是 YAML 指示符；CVR 自己写的是 `now: TW 2 | v4`，加引号就变了它的风格
  assert.equal(P.yamlScalar('HK 3 | v4'), 'HK 3 | v4');
  assert.equal(P.yamlScalar('|leading'), '"|leading"');
  assert.equal(P.yamlScalar('a: b'), '"a: b"');
  assert.equal(P.yamlScalar('https://x.test/sub?token=t'), 'https://x.test/sub?token=t');
  // readNested 交回来的是字符串，读改写若给数字加引号，CVR 的 serde 会在 u64/bool 字段上反序列化失败
  assert.equal(P.yamlScalar('1234'), '1234');
  assert.equal(P.yamlScalar(''), '""');
});
