'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { framer, handleMessage } = require('./protocol');
const { buildTools, callTool } = require('./tools');
const { discover } = require('./discovery');
const { ClashClient } = require('./clash-client');
const { CvrConfig } = require('./cvr-config');
const { SubscriptionRepo } = require('./subscriptions');
const { ToolConfig } = require('./toolconfig');
const { ApiError } = require('./envelope');
const { redactText } = require('./redact');
const store = require('./store');
const { createAudit } = require('./audit');

const LOG_FILE = 'mcp.log';
const RUNTIME_TTL_MS = 2000;
const DRAIN_GRACE_MS = 15000;

function makeLogger(dirs) {
  let stream = null;
  try { stream = fs.createWriteStream(path.join(dirs.logs, LOG_FILE), { flags: 'a' }); } catch { stream = null; }
  const log = (line) => {
    // 日志是唯一会留在磁盘上的输出面：异常栈里常常带着调用方传进来的订阅链接，
    // 所以红线设在写盘这一步，而不是指望每个调用点自己记得脱敏。
    const text = redactText(`[${new Date().toISOString()}] ${String(line)}`);
    const safe = text.length > 4000 ? text.slice(0, 4000) : text;
    if (stream) stream.write(safe + '\n');
    try { process.stderr.write(safe + '\n'); } catch { /* stderr 被关时忽略 */ }
  };
  // 日志流是 ref 的：不关掉它，stdin 结束后事件循环永不空转，进程挂住不退
  log.close = (cb) => { if (stream) { stream.end(cb); stream = null; } else if (cb) cb(); };
  return log;
}

function buildDeps(dirs, log, env = process.env) {
  let runtimeCache = null;
  let runtimeAt = 0;

  const getRuntime = async () => {
    // 2 秒缓存：一条工具链常常要读三四次 runtime，而 discover() 要扫盘与读三个 yaml
    if (runtimeCache && Date.now() - runtimeAt < RUNTIME_TTL_MS) return runtimeCache;
    runtimeCache = await discover();
    runtimeAt = Date.now();
    return runtimeCache;
  };

  const getClient = async () => {
    const rt = await getRuntime();
    if (!rt.installed) throw new ApiError('not_installed', '未检测到 Clash Verge Rev 的安装与配置目录', rt.channelHint);
    // 配置里没写管道路径时用 mihomo 的默认名，否则 transport 会直接跳过管道这一档
    const candidate = { ...rt, controller: { pipe: rt.controller.pipe || '\\\\.\\pipe\\verge-mihomo', tcp: rt.controller.tcp } };
    return ClashClient.connect(candidate, { timeoutMs: 3000 });
  };

  const getCvr = async () => {
    const rt = await getRuntime();
    if (!rt.configDir) return null;
    return new CvrConfig({ configDir: rt.configDir, backupDir: dirs.backups, exePath: rt.exePath });
  };

  const getRepo = async () => {
    const rt = await getRuntime();
    if (!rt.configDir) return null;
    let liveClient = null;
    try { liveClient = await getClient(); } catch { /* 核心没跑时订阅 CRUD 仍可离线进行 */ }
    return new SubscriptionRepo({ configDir: rt.configDir, dirs, client: liveClient });
  };

  const getToolConfig = async () =>
    new ToolConfig({ npmrcPath: path.join(os.homedir(), '.npmrc'), backupDir: dirs.backups });

  // 账本进程级单例：createAudit 只读一次环境变量，开关在进程生命周期内不会变
  let auditInstance = null;
  const getAudit = () => (auditInstance || (auditInstance = createAudit({ dirs, env })));

  return {
    backupDir: dirs.backups,
    getRuntime,
    getClient,
    getRepo,
    getCvr,
    getToolConfig,
    getAudit,
    // 不注入 curlRunner：真探测必须真的走网络，否则 proxy_diagnose 的结论没有意义
    getDiagnoseDeps: () => ({}),
    log,
  };
}

function main() {
  const dirs = store.ensure(store.dirs());
  const log = makeLogger(dirs);
  const deps = buildDeps(dirs, log);
  const tools = buildTools(deps);

  log(`server 启动，${tools.length} 个工具，数据目录 ${dirs.root}`);

  // 协议帧只能写 stdout；任何 console.log 都会破坏协议，所以日志一律走 stderr 与文件
  const out = (msg) => {
    try { process.stdout.write(`${JSON.stringify(msg)}\n`); }
    catch (e) { log(`写 stdout 失败: ${e.message}`); }
  };

  const f = framer();
  let pending = 0;
  let stdinClosed = false;
  let forceExit = null;

  const finishIfIdle = () => {
    if (!stdinClosed || pending > 0) return;
    if (forceExit) clearTimeout(forceExit);
    log.close();
    // 回调在 stdout 缓冲冲干净时才触发；直接 process.exit 会把最后一帧截掉
    process.stdout.write('', () => process.exit(0));
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const msg of f.push(chunk)) {
      pending += 1;
      const work = handleMessage(msg, {
        tools,
        callTool: (name, args) => callTool(name, args, deps),
        log,
      });
      work.then((res) => { if (res) out(res); }, (e) => {
        log(`分派异常: ${e && e.stack ? e.stack : e}`);
        if (msg && msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: '内部异常' } });
      });
      work.finally(() => { pending -= 1; finishIfIdle(); });
    }
  });
  process.stdin.on('end', () => {
    log('stdin 关闭，等待在途请求收尾');
    stdinClosed = true;
    // 在途工具（如 proxy_diagnose 的 curl 探测）有自己的超时，但客户端已走，不该陪着等到底
    forceExit = setTimeout(() => { log('在途请求超时，强制退出'); process.exit(0); }, DRAIN_GRACE_MS);
    finishIfIdle();
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('uncaughtException', (e) => log(`未捕获异常: ${e && e.stack ? e.stack : e}`));
  process.on('unhandledRejection', (e) => log(`未处理 rejection: ${e && e.stack ? e.stack : e}`));
}

if (require.main === module) main();

module.exports = { main, buildDeps, makeLogger };
