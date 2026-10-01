'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('./tmp');

const tmpRoot = fs.realpathSync(os.tmpdir());

test('mkTmp 建出带标签的临时目录并登记在册', () => {
  const dir = T.mkTmp('unit-a');
  assert.ok(fs.existsSync(dir), 'mkTmp 必须真的把目录建出来');
  assert.ok(fs.realpathSync(dir).startsWith(tmpRoot + path.sep));
  assert.ok(path.basename(dir).startsWith('qvp-unit-a-'));
  assert.ok(T.list().includes(dir));
});

test('tmpDir 同名可重复拿到同一路径（老测试依赖这个复位语义）', () => {
  const first = T.tmpDir('unit-b');
  assert.equal(first, T.tmpDir('unit-b'));
  assert.ok(path.basename(first).startsWith(`qvp-unit-b-${process.pid}`));
});

test('sweepTmp 删掉所有登记过的目录且对已消失的不抛', () => {
  const a = T.mkTmp('unit-c');
  const b = T.tmpDir('unit-d');
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'nested.json'), '{}');
  fs.rmSync(b, { recursive: true, force: true });
  T.sweepTmp();
  assert.ok(!fs.existsSync(a));
  assert.deepEqual(T.list(), [], '扫完要清空登记，否则重复扫会拿旧路径');
});

test('进程退出时自动扫：测试体漏写 rmSync 也不在 %TEMP% 留残留', () => {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, 'fixtures', 'tmp-leak-probe.js')],
    { encoding: 'utf8' },
  ).trim();
  const dir = JSON.parse(out).dir;
  assert.ok(path.basename(dir).startsWith('qvp-leak-'), '子进程确实建了目录');
  assert.equal(fs.existsSync(dir), false, '子进程没调 sweepTmp，退出钩子必须接手清理');
});
