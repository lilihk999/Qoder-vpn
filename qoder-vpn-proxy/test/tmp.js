'use strict';
// 缺陷 ⑦：跑一次全量测试，%TEMP% 就多出一批 qvp-* 目录（2026-10-01 实测 15 → 20）。
// 各测试文件里的 fs.rmSync 只写在"断言全过"的那条路径上，中途 throw 就漏；
// session-start.test.js 干脆一处清理都没写，每次都留两个整目录。残留里装着
// 订阅链接形态的配置，于是"清空 Temp"变成每次测试后的人工活。集中登记 + 进程退出
// 统一扫之后，测试体不再自带清理义务，也不依赖它自己的诚实。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registered = new Set();

function register(dir) {
  registered.add(dir);
  return dir;
}

/** 唯一目录（mkdtemp 语义）：同一文件里多条测试各拿各的，互不串台 */
function mkTmp(label) {
  return register(fs.mkdtempSync(path.join(os.tmpdir(), `qvp-${label}-`)));
}

/** 固定目录（`qvp-<label>-<pid>`）：同标签两次拿到同一路径，保留原来"先 rm 再建"的复位语义 */
function tmpDir(label) {
  return register(path.join(os.tmpdir(), `qvp-${label}-${process.pid}`));
}

/** 删掉本进程登记过的目录，返回没删掉的个数 */
function sweepTmp() {
  const dirs = [...registered];
  registered.clear();
  let failed = 0;
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上子进程还攥着句柄时会 EBUSY/EPERM；清理失败不该反过来弄挂测试
      failed += 1;
    }
  }
  return failed;
}

function list() {
  return [...registered];
}

process.on('exit', sweepTmp);

module.exports = { mkTmp, tmpDir, sweepTmp, list };
