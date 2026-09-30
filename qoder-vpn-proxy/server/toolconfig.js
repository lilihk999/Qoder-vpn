'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ApiError } = require('./envelope');
const { GIT_PROXY_HOSTS } = require('./env');
const store = require('./store');

const execFileAsync = promisify(execFile);

const MARK_BEGIN = '# >>> qoder-vpn-proxy >>> (由 proxy_toolconfig 维护，请勿手工编辑此块)';
const MARK_END = '# <<< qoder-vpn-proxy <<<';

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

function blockRange(lines) {
  const b = lines.indexOf(MARK_BEGIN);
  const e = lines.indexOf(MARK_END);
  if (b === -1 || e === -1 || e < b) return null;
  return { b, e };
}

function blockLines(proxyUrl, noproxy) {
  return [MARK_BEGIN, `proxy=${proxyUrl}`, `https-proxy=${proxyUrl}`, `noproxy=${noproxy || 'localhost,127.0.0.1'}`, MARK_END];
}

function buildNpmrcBlock(text, { proxyUrl, noproxy }) {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const range = blockRange(lines);
  const hadBlock = Boolean(range);
  const kept = range ? [...lines.slice(0, range.b), ...lines.slice(range.e + 1)] : lines;
  // 去掉尾部空行，块后面统一补一个，还原时才能逐字节回到原样
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return { text: [...kept, ...blockLines(proxyUrl, noproxy), ''].join(eol), hadBlock, replaced: hadBlock };
}

function stripNpmrcBlock(text) {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const range = blockRange(lines);
  if (!range) return { text, hadBlock: false };
  const kept = [...lines.slice(0, range.b), ...lines.slice(range.e + 1)];
  while (kept.length > 1 && kept[kept.length - 1] === '' && kept[kept.length - 2] === '') kept.pop();
  return { text: kept.join(eol), hadBlock: true };
}

/** git 的按域名代理：key 里的 URL 前缀让 git 只对指定 host 走代理，绝不写全局 http.proxy */
function gitProxyKeys(hosts = GIT_PROXY_HOSTS) {
  return hosts.map((h) => `http.https://${h}/.proxy`);
}

class ToolConfig {
  constructor({
    npmrcPath = path.join(os.homedir(), '.npmrc'),
    backupDir,
    gitRunner,
    fsImpl = fs,
    env = process.env,
  } = {}) {
    this.npmrcPath = npmrcPath;
    this.backupDir = backupDir;
    this.fs = fsImpl;
    this.env = env;
    this.gitRunner = gitRunner || (async (args) => {
      try {
        const { stdout, stderr } = await execFileAsync('git', args, {
          windowsHide: true, timeout: 15000, maxBuffer: 1 << 20, env: this.env,
        });
        return { code: 0, stdout, stderr };
      } catch (e) {
        return { code: e.code === 'ENOENT' ? 127 : (e.status ?? 1), stdout: e.stdout || '', stderr: e.stderr || e.message };
      }
    });
  }

  readNpmrc() {
    const exists = this.fs.existsSync(this.npmrcPath);
    return { exists, text: exists ? this.fs.readFileSync(this.npmrcPath, 'utf8') : '' };
  }

  backupNpmrc() {
    if (!this.fs.existsSync(this.npmrcPath)) return null;
    const dest = path.join(this.backupDir, `.npmrc.${store.stamp()}.bak`);
    try {
      this.fs.mkdirSync(this.backupDir, { recursive: true });
      this.fs.copyFileSync(this.npmrcPath, dest);
      return dest;
    } catch (e) {
      throw new ApiError('config_write_failed', `备份 ${this.npmrcPath} 失败: ${e.code || e.message}`, '不改动 npmrc');
    }
  }

  writeNpmrc(text) {
    try { this.fs.writeFileSync(this.npmrcPath, text, 'utf8'); }
    catch (e) { throw new ApiError('config_write_failed', `写入 ${this.npmrcPath} 失败: ${e.code || e.message}`, '该文件可能被 npm 进程占用'); }
  }

  async apply({ proxyUrl, targets = ['npm', 'git'], hosts, noproxy }) {
    // 只允许指向本机 mixed 端口：写进 git/npm 全局配置的代理地址不能是外部机器
    if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(String(proxyUrl))) {
      throw new ApiError('malformed_config', `proxyUrl 形态异常: ${proxyUrl}`, '应为 http://127.0.0.1:<mixed 端口>，端口取自 proxy_status');
    }
    const out = {};
    if (targets.includes('npm')) out.npm = this.applyNpm({ proxyUrl, noproxy });
    if (targets.includes('git')) {
      try {
        out.git = await this.applyGit({ proxyUrl, hosts });
      } catch (err) {
        // 两处配置要么都改，要么都不改：只写 npmrc 会让用户以为代理已全量生效
        if (out.npm) this.restoreNpm(out.npm);
        throw err;
      }
    }
    return out;
  }

  applyNpm({ proxyUrl, noproxy }) {
    const { exists, text } = this.readNpmrc();
    const backupPath = exists ? this.backupNpmrc() : null;
    const built = buildNpmrcBlock(text, { proxyUrl, noproxy });
    this.writeNpmrc(built.text);
    return {
      action: built.hadBlock ? 'updated' : exists ? 'written' : 'created',
      created: !exists,
      file: this.npmrcPath,
      backupPath,
      before: text,
      after: built.text,
      lines: blockLines(proxyUrl, noproxy).slice(1, 4),
    };
  }

  restoreNpm(npm) {
    if (npm.created && this.fs.existsSync(this.npmrcPath)) { try { this.fs.unlinkSync(this.npmrcPath); } catch { /* 交给调用方的错误 */ } return; }
    if (!npm.backupPath) return;
    try { this.fs.copyFileSync(npm.backupPath, this.npmrcPath); } catch { /* 回滚失败时至少报了 git 侧的错误 */ }
  }

  async applyGit({ proxyUrl, hosts }) {
    const keys = gitProxyKeys(hosts);
    const applied = [];
    for (const key of keys) {
      const r = await this.gitRunner(['config', '--global', key, proxyUrl]);
      if (r.code !== 0) {
        throw new ApiError('config_write_failed', `git config --global ${key} 失败: ${(r.stderr || '').slice(0, 120)}`, '确认 git 在 PATH 且可写 ~/.gitconfig');
      }
      applied.push({ key, value: proxyUrl });
    }
    return { applied };
  }

  async revert({ targets = ['npm', 'git'], hosts } = {}) {
    const out = {};
    if (targets.includes('npm')) out.npm = this.revertNpm();
    if (targets.includes('git')) out.git = await this.revertGit({ hosts });
    return out;
  }

  revertNpm() {
    const { exists, text } = this.readNpmrc();
    if (!exists) return { action: 'noop', file: this.npmrcPath };
    const stripped = stripNpmrcBlock(text);
    if (!stripped.hadBlock) return { action: 'noop', file: this.npmrcPath, note: 'npmrc 里没有插件写入的块' };
    const backupPath = this.backupNpmrc();
    if (stripped.text === '') {
      // 文件本来是我们创建的（内容只剩托管块）：删掉，避免留下空文件
      try { this.fs.unlinkSync(this.npmrcPath); return { action: 'removed-created', file: this.npmrcPath, backupPath }; }
      catch (e) { throw new ApiError('config_write_failed', `删除 ${this.npmrcPath} 失败: ${e.code || e.message}`, ''); }
    }
    this.writeNpmrc(stripped.text);
    return { action: 'stripped', file: this.npmrcPath, backupPath };
  }

  async revertGit({ hosts } = {}) {
    const keys = gitProxyKeys(hosts);
    const removed = [];
    for (const key of keys) {
      const r = await this.gitRunner(['config', '--global', '--unset', key]);
      // git --unset 对不存在的 key 返回 5；这是"本来就没有"，不是失败
      if (r.code !== 0 && r.code !== 5 && r.code !== 1) {
        throw new ApiError('config_write_failed', `git config --global --unset ${key} 失败: ${(r.stderr || '').slice(0, 120)}`, '');
      }
      removed.push({ key, existed: r.code === 0 });
    }
    return { removed };
  }

  async status({ hosts, expectedProxyUrl } = {}) {
    const { exists, text } = this.readNpmrc();
    const lines = text.split(/\r?\n/);
    const range = blockRange(lines);
    const proxyLines = lines.filter((l) => /^(proxy|https-proxy|noproxy|silent-proxy)\s*=/i.test(l));
    const managedNpmLines = range ? lines.slice(range.b + 1, range.e) : [];

    const r = await this.gitRunner(['config', '--global', '--get-regexp', '^http\\.']);
    const gitPairs = r.stdout.trim()
      ? r.stdout.trim().split(/\r?\n/).map((l) => {
        const i = l.indexOf(' ');
        return { key: l.slice(0, i), value: l.slice(i + 1).trim() };
      })
      : [];
    const keys = gitProxyKeys(hosts);
    const managed = keys.map((key) => {
      const hit = gitPairs.find((p) => p.key === key);
      return { key, value: hit ? hit.value : null, expected: expectedProxyUrl || (hit ? hit.value : null) };
    });
    const mismatch = Boolean(expectedProxyUrl) && managed.some((m) => m.value !== expectedProxyUrl);

    const npmManaged = Boolean(range);
    const gitManaged = managed.some((m) => m.value);
    let verdict;
    if (npmManaged && gitManaged && !mismatch) verdict = 'managed';
    else if (npmManaged || gitManaged) verdict = 'partial';
    else if (proxyLines.length || gitPairs.length) verdict = 'foreign';
    else verdict = 'clean';

    return {
      npmrc: { path: this.npmrcPath, exists, managed: npmManaged, managedLines: managedNpmLines, proxyLines },
      git: { managed, mismatch, otherHttpKeys: gitPairs.filter((p) => !keys.includes(p.key)).map((p) => p.key) },
      verdict,
    };
  }
}

module.exports = { ToolConfig, buildNpmrcBlock, stripNpmrcBlock, gitProxyKeys, MARK_BEGIN, MARK_END };
