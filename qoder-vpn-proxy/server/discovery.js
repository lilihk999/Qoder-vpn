'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const CONFIG_DIR_NAME = 'io.github.clash-verge-rev.clash-verge-rev';
const FALLBACK_PIPE = '\\\\.\\pipe\\verge-mihomo';
const DEFAULT_SECRET = 'set-your-secret';
// 顺序即优先级：clash-verge.yaml 是 CVR 每次启动核心时生成的**运行时配置**，mihomo 加载的就是它；
// config.yaml 只是用户基座，可能停在几个月前（真机 2026-10-01：基座写 \\.\pipe\verge-mihomo，
// 运行时已是 \\.\pipe\verge-mihomo-sidecar-release-<64hex>，按基座连必 ENOENT）。
// 排第一的那个文件解析失败时会继续往下退，所以基座仍是坏运行时配置的兜底。
const CONFIG_SOURCES = ['clash-verge.yaml', 'config.yaml', 'clash-verge-check.yaml'];

function installCandidates(env) {
  // 显式给定候选时只用给定值：测试必须与"这台机器装没装 CVR"无关
  if (env.QVP_INSTALL_CANDIDATES) {
    return env.QVP_INSTALL_CANDIDATES.split(path.delimiter).filter(Boolean);
  }
  const list = [];
  if (env.QVP_INSTALL_DIR) list.push(env.QVP_INSTALL_DIR);
  if (env.ProgramFiles) list.push(path.join(env.ProgramFiles, 'Clash Verge'));
  if (env['ProgramFiles(x86)']) list.push(path.join(env['ProgramFiles(x86)'], 'Clash Verge'));
  list.push('C:\\Program Files\\Clash Verge', 'D:\\Program Files\\Clash Verge');
  list.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Clash Verge'));
  return list;
}

function scalarOf(raw) {
  const v = String(raw).trim();
  const quoted = v.length >= 2
    && ((v[0] === "'" && v[v.length - 1] === "'") || (v[0] === '"' && v[v.length - 1] === '"'));
  const out = quoted ? v.slice(1, -1) : v;
  if (out === '') return null;
  // 未加引号的 null / ~ 在 YAML 里就是"没有值"；保留字面量会让下游把 "null" 当成配置
  if (!quoted && (out === 'null' || out === '~')) return null;
  return out;
}

function topScalar(text, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text);
  return m ? scalarOf(m[1]) : null;
}

function intOf(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

function numOf(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function boolOf(raw) {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function nestedBool(text, parent, child) {
  const block = new RegExp(`^${parent}:[ \\t]*\\n((?:[ \\t]+.*(?:\\r?\\n|$))+)`, 'm').exec(text);
  if (!block) return null;
  const lines = block[1].split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return null;
  // topScalar 只认列 0 的键，所以按第一行的缩进把子块整体顶格；
  // 更深层的键仍带着缩进，不会被 child 误命中。
  const indent = (lines[0].match(/^[ \t]+/) || [''])[0].length;
  return boolOf(topScalar(lines.map((l) => l.slice(indent)).join('\n'), child));
}

function parseRuntimeYaml(text) {
  const pipe = topScalar(text, 'external-controller-pipe');
  return {
    ports: {
      mixed: intOf(topScalar(text, 'mixed-port')),
      socks: intOf(topScalar(text, 'socks-port')),
      http: intOf(topScalar(text, 'port')),
    },
    controller: { tcp: topScalar(text, 'external-controller'), pipe: pipe || FALLBACK_PIPE },
    secret: topScalar(text, 'secret') || DEFAULT_SECRET,
    mode: topScalar(text, 'mode') || 'rule',
    tunEnabled: nestedBool(text, 'tun', 'enable'),
  };
}

function parseVergeYaml(text) {
  return {
    enableExternalController: boolOf(topScalar(text, 'enable_external_controller')),
    enableSystemProxy: boolOf(topScalar(text, 'enable_system_proxy')),
    enableTunMode: boolOf(topScalar(text, 'enable_tun_mode')),
    mixedPort: intOf(topScalar(text, 'verge_mixed_port')),
    socksPort: intOf(topScalar(text, 'verge_socks_port')),
    httpPort: intOf(topScalar(text, 'verge_port')),
    systemProxyBypass: topScalar(text, 'system_proxy_bypass'),
  };
}

function mergePorts(runtimePorts, settings) {
  return {
    mixed: settings.mixedPort || runtimePorts.mixed || null,
    socks: settings.socksPort || runtimePorts.socks || null,
    http: settings.httpPort || runtimePorts.http || null,
  };
}

/** CVR 的开关决定 TCP 是否真的在监听；config.yaml 的声明只作为"配置过什么"保留 */
function mergeController(runtime, settings) {
  const enabled = settings.enableExternalController;
  return {
    pipe: runtime.controller.pipe || FALLBACK_PIPE,
    tcp: enabled === false ? null : runtime.controller.tcp,
    tcpConfigured: runtime.controller.tcp,
    tcpEnabled: enabled,
  };
}

function parseProfilesYaml(text) {
  const current = topScalar(text, 'current');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^items:\s*$/.test(l));
  if (start === -1) return { current, items: [] };

  const blocks = [];
  let block = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[^\s-]/.test(line) && line.trim() !== '') break;
    // CVR 把每项的第一个字段写在破折号同一行（`- uid: Merge`），这一行同样是键值对
    let m = /^-\s+([\w-]+):[ \t]*(.*)$/.exec(line);
    if (m) {
      block = { [m[1]]: scalarOf(m[2]) };
      blocks.push(block);
      continue;
    }
    if (/^-\s*$/.test(line)) { block = {}; blocks.push(block); continue; }
    if (!block) continue;
    m = /^ {2}([\w-]+):[ \t]*(.*)$/.exec(line);
    if (m && block[m[1]] === undefined) block[m[1]] = scalarOf(m[2]);
  }
  return {
    current,
    items: blocks.map((b) => ({
      uid: b.uid ?? null,
      type: b.type ?? null,
      name: b.name ?? null,
      file: b.file ?? null,
      url: b.url ?? null,
      updated: numOf(b.updated),
    })),
  };
}

function isFile(fsImpl, p) { try { return Boolean(p) && fsImpl.statSync(p).isFile(); } catch { return false; } }
function isDir(fsImpl, p) { try { return Boolean(p) && fsImpl.statSync(p).isDirectory(); } catch { return false; } }

function resolveConfigDir(env = process.env, fsImpl = fs) {
  if (env.QVP_CONFIG_DIR && isDir(fsImpl, env.QVP_CONFIG_DIR)) return env.QVP_CONFIG_DIR;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const appdata = env.APPDATA || env.appdata;
  if (appdata) {
    const candidate = path.join(appdata, CONFIG_DIR_NAME);
    if (isDir(fsImpl, candidate)) return candidate;
  } else {
    // Qoder 拉起的 MCP 子进程环境里没有 APPDATA（2026-09-30 真机验收 4），只认它会把装好 CVR 的机器报成未安装
    const derived = path.join(home, 'AppData', 'Roaming', CONFIG_DIR_NAME);
    if (isDir(fsImpl, derived)) return derived;
  }
  const unix = path.join(home, '.config', CONFIG_DIR_NAME);
  if (isDir(fsImpl, unix)) return unix;
  return null;
}

function resolveInstallDir(env = process.env, fsImpl = fs) {
  return installCandidates(env).find((d) => isDir(fsImpl, d)) || null;
}

async function isRunning(exec = execFileAsync) {
  try {
    const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq clash-verge.exe', '/NH'], {
      windowsHide: true, timeout: 6000, maxBuffer: 1 << 20,
    });
    return /clash-verge\.exe/i.test(stdout);
  } catch {
    return false;
  }
}

function probeTcp({ host = '127.0.0.1', port, timeoutMs = 1200 }) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function discover({ env = process.env, fsImpl = fs, exec = execFileAsync } = {}) {
  const warnings = [];
  const configDir = resolveConfigDir(env, fsImpl);
  const installDir = resolveInstallDir(env, fsImpl);

  let runtime = { ports: { mixed: null, socks: null, http: null }, controller: { tcp: null, pipe: FALLBACK_PIPE }, secret: DEFAULT_SECRET, mode: null, tunEnabled: null };
  let settings = parseVergeYaml('');
  let profiles = { current: null, items: [] };
  let configSource = null;

  if (configDir) {
    for (const name of CONFIG_SOURCES) {
      const p = path.join(configDir, name);
      if (!isFile(fsImpl, p)) continue;
      try { runtime = parseRuntimeYaml(fsImpl.readFileSync(p, 'utf8')); configSource = name; break; }
      catch (e) { warnings.push(`${name} 读取失败: ${e.code || e.message}`); }
    }
    if (!configSource) warnings.push('未找到 config.yaml / clash-verge.yaml，端口与通道只能靠探测');

    const vergePath = path.join(configDir, 'verge.yaml');
    if (isFile(fsImpl, vergePath)) {
      try { settings = parseVergeYaml(fsImpl.readFileSync(vergePath, 'utf8')); }
      catch (e) { warnings.push(`verge.yaml 读取失败: ${e.code || e.message}`); }
    } else warnings.push('verge.yaml 缺失，CVR 开关状态未知');

    const profilesPath = path.join(configDir, 'profiles.yaml');
    if (isFile(fsImpl, profilesPath)) {
      try { profiles = parseProfilesYaml(fsImpl.readFileSync(profilesPath, 'utf8')); }
      catch (e) { warnings.push(`profiles.yaml 解析失败: ${e.code || e.message}`); }
    } else warnings.push('profiles.yaml 缺失，订阅清单为空');
  } else {
    warnings.push(`未找到配置目录（APPDATA=${env.APPDATA || '空'} 下的 ${CONFIG_DIR_NAME}，也没有 QVP_CONFIG_DIR）`);
  }

  const running = await isRunning(exec);
  const installed = Boolean(installDir && configDir);

  return {
    installed,
    running,
    configDir,
    configSource,
    installDir,
    exePath: installDir ? path.join(installDir, 'clash-verge.exe') : null,
    corePath: installDir ? path.join(installDir, 'verge-mihomo.exe') : null,
    ports: mergePorts(runtime.ports, settings),
    controller: mergeController(runtime, settings),
    secret: runtime.secret,
    settings,
    profiles,
    warnings,
    channelHint: installed
      ? '先调用 proxy_core_start（默认 scope=session，不会打开系统代理）；若仍不可用，需取得用户确认后调用 proxy_core_start(enableExternalControl: true)，它会在启动前把 verge.yaml 的 enable_external_controller 置 true 并备份原文件，失败自动回滚'
      : '未检测到 Clash Verge Rev。请安装到默认目录 C:\\Program Files\\Clash Verge，或设置 QVP_INSTALL_DIR 指向安装目录、QVP_CONFIG_DIR 指向配置目录',
  };
}

module.exports = {
  CONFIG_DIR_NAME, FALLBACK_PIPE, DEFAULT_SECRET, CONFIG_SOURCES,
  topScalar, intOf, boolOf, nestedBool,
  parseRuntimeYaml, parseVergeYaml, mergePorts, mergeController, parseProfilesYaml,
  resolveConfigDir, resolveInstallDir, isRunning, probeTcp, discover,
};
