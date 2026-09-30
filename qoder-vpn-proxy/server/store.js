'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ApiError } = require('./envelope');

function dataDir(env = process.env) {
  if (env.QODER_VPN_PROXY_DATA) return env.QODER_VPN_PROXY_DATA;
  return path.join(os.homedir(), '.qoder', 'vpn-proxy');
}

function dirs(env = process.env) {
  const root = dataDir(env);
  return { root, backups: path.join(root, 'backups'), trash: path.join(root, '.trash'), logs: path.join(root, 'logs') };
}

function ensure(d) {
  for (const p of Object.values(d)) {
    try { fs.mkdirSync(p, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return d;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(value, null, 2));
    fs.renameSync(tmpFile, file);
  } catch (e) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* 忽略清理失败 */ }
    throw new ApiError('config_write_failed', `写入 ${path.basename(file)} 失败: ${e.code || e.message}`, '插件数据目录不可写或被占用');
  }
}

let seq = 0;

// 毫秒不够：同一毫秒内的两次备份会写到同一个文件名，后一次把前一次盖掉
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}-${String(seq += 1).padStart(3, '0')}`;
}

function moveToTrash(d, absPath) {
  if (!fs.existsSync(absPath)) throw new ApiError('config_write_failed', `要隔离的文件不存在: ${path.basename(absPath)}`, '可能已被 CVR 或上一次操作移走');
  const dest = path.join(d.trash, `${stamp()}-${path.basename(absPath)}`);
  try {
    fs.mkdirSync(d.trash, { recursive: true });
    fs.renameSync(absPath, dest);
    return dest;
  } catch (e) {
    try { fs.copyFileSync(absPath, dest); fs.unlinkSync(absPath); return dest; }
    catch (e2) { throw new ApiError('config_write_failed', `移入回收目录失败: ${e.code || e2.code}`, `${absPath} 可能被 CVR 进程占用`); }
  }
}

function listTrash(d) { try { return fs.readdirSync(d.trash); } catch { return []; } }

/** 备份目录里的文件名，按落盘时间升序（两种 stamp 格式混在同一目录，字典序会排错） */
function listBackupsIn(dirPath) {
  let files;
  try { files = fs.readdirSync(dirPath).filter((f) => /\.[\d-]+\.bak$/.test(f)); } catch { return []; }
  const mtime = (f) => { try { return fs.statSync(path.join(dirPath, f)).mtimeMs; } catch { return 0; } };
  return files.sort((a, b) => (mtime(a) - mtime(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

function latestBackupIn(dirPath, name) {
  const hits = listBackupsIn(dirPath).filter((f) => f.startsWith(`${name}.`));
  return hits.length ? path.join(dirPath, hits[hits.length - 1]) : null;
}

/**
 * 备份保留期清理。按"逻辑文件名"（verge.yaml / profiles.yaml / .npmrc）分组，各自淘汰老备份：
 * 名次超出 keepPerName 的删（reason:count），超过 olderThanDays 的删（reason:age）。
 * 每组至少留最新一份 —— 全删干净等于让 proxy_restore_config 失去还原依据，
 * 而 profiles.yaml 的备份里带着订阅 token，留着才是问题：所以两条规则同时生效。
 */
function pruneBackupsIn(dirPath, { keepPerName = 5, olderThanDays = 14, now = Date.now(), dryRun = false } = {}) {
  const all = listBackupsIn(dirPath); // 升序：老的在前
  const groups = new Map();
  for (const f of all) {
    const name = (/^(.+)\.[\d-]+\.bak$/.exec(f) || [, f])[1];
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(f);
  }
  const DAY = 86400000;
  const deleted = [];
  const failed = [];
  const kept = [];
  for (const files of groups.values()) {
    const last = files.length - 1;
    files.forEach((f, i) => {
      const rank = last - i; // 0 = 该组最新
      let reason = null;
      if (rank > 0) {
        if (rank >= keepPerName) reason = 'count';
        else {
          let age = 0;
          try { age = now - fs.statSync(path.join(dirPath, f)).mtimeMs; } catch { age = 0; }
          if (age > olderThanDays * DAY) reason = 'age';
        }
      }
      if (reason) {
        const entry = { file: f, reason };
        if (dryRun) {
          deleted.push(entry);
        } else {
          try { fs.unlinkSync(path.join(dirPath, f)); deleted.push(entry); }
          // Windows 上 CVR 可能正占着文件；删不掉就如实报 failed，不能假装已清理
          catch (e) { failed.push({ file: f, reason, error: e.code || e.message }); }
        }
      } else kept.push(f);
    });
  }
  return { deleted, failed, kept, scanned: all.length, dryRun: !!dryRun };
}

function restoreFromTrash(d, name, dest) {
  const src = path.join(d.trash, name);
  if (!fs.existsSync(src)) throw new ApiError('config_write_failed', `回收目录里没有 ${name}`, '用 proxy_restore_config 查看当前可还原项');
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); return dest; }
  catch (e) { throw new ApiError('config_write_failed', `还原 ${name} 失败: ${e.code || e.message}`, ''); }
}

module.exports = {
  dataDir, dirs, ensure, readJson, writeJsonAtomic, stamp,
  moveToTrash, listTrash, listBackupsIn, latestBackupIn, pruneBackupsIn, restoreFromTrash,
};
