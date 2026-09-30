'use strict';
const { ok, fail, ApiError, toEnvelope } = require('./envelope');
const { redactText, redactUrl } = require('./redact');
const { buildProxyEnv, inlinePrefix, GIT_PROXY_HOSTS } = require('./env');
const { probeTcp } = require('./discovery');
const { runDiagnose, DEFAULT_TARGETS } = require('./diagnose');

const MODES = ['rule', 'global', 'direct'];
const SCOPES = ['session', 'global'];
const TARGETS = ['shell', 'npm', 'git', 'pip'];
const CVR_RESTORE_TARGETS = ['verge.yaml', 'profiles.yaml', 'npm', 'git'];
const TC_TARGETS = ['npm', 'git'];
const TC_ACTIONS = ['apply', 'revert', 'status'];
const obj = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (enumVals, desc) => ({ type: 'string', description: desc, ...(enumVals ? { enum: enumVals } : {}) });
const bool = (desc) => ({ type: 'boolean', description: desc });
const arr = (desc) => ({ type: 'array', items: { type: 'string' }, description: desc });
const numSchema = (desc) => ({ type: 'number', description: desc });

function bad(message, hint) { return new ApiError('malformed_config', message, hint || ''); }

function assertEnum(value, list, label) {
  if (!list.includes(value)) throw bad(`${label} 只能是 ${list.join(' / ')}，收到 ${redactText(String(value))}`);
}

// MCP schema 写了 additionalProperties:false，但 JSON-RPC 客户端不保证遵守；
// 在这里真拦一次，否则拼错的参数名会被静默忽略，调用方以为自己做对了什么。
function rejectExtra(args, schema) {
  const known = Object.keys(schema.properties || {});
  const extra = Object.keys(args || {}).filter((k) => !known.includes(k) && args[k] !== undefined);
  if (extra.length) {
    throw bad(`不接受的参数：${extra.map((k) => redactText(k)).join(', ')}`, known.length ? `可用参数：${known.join(', ')}` : '这个工具不需要任何参数');
  }
}

function positive(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw bad(`${label} 必须是正数，收到 ${redactText(String(v))}`);
  return n;
}
const numOr = (v, def, label) => (v === undefined || v === null || v === '' ? def : positive(v, label));
const numOpt = (v, label) => (v === undefined || v === null ? undefined : positive(v, label));

function assertArray(v, label) {
  if (!Array.isArray(v)) throw bad(`${label} 必须是字符串数组，收到 ${redactText(String(v))}`, '单个元素也要写成数组：["…"]');
  return v.map(String);
}

async function requireInstalled(deps) {
  const rt = await deps.getRuntime();
  if (!rt.installed) {
    throw new ApiError('not_installed', '未检测到 Clash Verge Rev 的安装与配置目录', rt.channelHint);
  }
  return rt;
}

async function requireClient(deps) {
  const rt = await requireInstalled(deps);
  const client = await deps.getClient();
  return { rt, client };
}

// 注册表在 CVR 配置目录里：没有 configDir 时 repo 是 null，
// 直接 .list() 会变成 TypeError，用户看到的是"未预期的错误"而不是"没装"。
async function requireRepo(deps) {
  await requireInstalled(deps);
  const repo = await deps.getRepo();
  if (!repo) throw new ApiError('not_installed', '找不到 CVR 配置目录，订阅注册表无法读写', '用 proxy_detect 确认配置目录，或设置 QVP_CONFIG_DIR');
  return repo;
}

function portsOf(rt) {
  const mixed = rt.ports && rt.ports.mixed;
  if (!mixed) throw new ApiError('malformed_config', '解析不到 mixed 端口', '跑 proxy_detect 看实际监听端口，或检查 config.yaml 是否被改坏');
  return mixed;
}

function subscriptionSummary(repoEntry) {
  if (!repoEntry) return null;
  const u = repoEntry.userInfo || {};
  const gb = (n) => (n == null ? null : Math.round((n / 1024 / 1024 / 1024) * 100) / 100);
  return {
    uid: repoEntry.uid, name: repoEntry.name, url: redactUrl(repoEntry.url || ''),
    nodes: repoEntry.nodes, usedGb: gb(u.download), totalGb: gb(u.total),
    expire: u.expire ? new Date(u.expire * 1000).toISOString().slice(0, 10) : null,
    updated: repoEntry.updated,
  };
}

function groupOrThrow(groups, nodes, group) {
  const hit = groups.find((g) => g.name === group);
  if (!hit) throw new ApiError('malformed_config', `没有名为 ${redactText(String(group))} 的代理组`, `可选：${groups.map((g) => g.name).join(' / ')}`);
  return hit.all.filter((n) => nodes.includes(n));
}

function buildTools(deps) {
  return [
    {
      name: 'proxy_status',
      description: '查看本机代理现状：Clash Verge 是否在运行、控制通道走命名管道还是 TCP、mixed 端口、运行模式、当前节点与订阅余量、系统代理与 TUN 状态（只读展示，绝不改动）、插件是否改过配置文件。核心未运行时也返回成功，不可达原因在 data.core 里。',
      inputSchema: obj(),
      handler: async () => {
        const rt = await deps.getRuntime();
        const out = {
          installed: rt.installed, running: rt.running,
          configDir: rt.configDir, configSource: rt.configSource, installDir: rt.installDir,
          ports: rt.ports,
          controller: { pipe: rt.controller.pipe, tcp: rt.controller.tcp, tcpConfigured: rt.controller.tcpConfigured, tcpEnabled: rt.controller.tcpEnabled },
          settings: { enableSystemProxy: rt.settings.enableSystemProxy, enableTunMode: rt.settings.enableTunMode, enableExternalController: rt.settings.enableExternalController },
          warnings: rt.warnings,
        };
        try {
          const client = await deps.getClient();
          const cfg = await client.getConfigs();
          const proxies = await client.getProxies();
          const version = await client.version();
          out.core = { reachable: true, channel: client.channelKind, version: version.version, mode: cfg.mode, mixedPort: cfg.mixedPort, tunEnabled: cfg.tunEnabled, groups: proxies.groups.map((g) => ({ name: g.name, type: g.type, now: g.now, count: g.all.length })) };
        } catch (e) {
          const env = toEnvelope(e);
          out.core = { reachable: false, kind: env.kind, message: env.message, hint: env.hint };
        }
        try {
          const repo = await deps.getRepo();
          const subs = repo ? await repo.list() : [];
          out.subscription = { total: subs.length, current: subscriptionSummary(subs.find((s) => s.active) || null) };
        } catch (e) {
          out.subscription = { error: toEnvelope(e).kind };
        }
        try {
          const tc = await deps.getToolConfig();
          out.toolconfig = await tc.status({ expectedProxyUrl: rt.ports.mixed ? `http://127.0.0.1:${rt.ports.mixed}` : undefined });
        } catch (e) {
          out.toolconfig = { error: toEnvelope(e).kind };
        }
        try {
          const cvr = await deps.getCvr();
          out.configModified = cvr ? cvr.modifiedSinceBackup().modified : [];
        } catch { out.configModified = []; }
        return ok(out);
      },
    },
    {
      name: 'proxy_detect',
      description: '探测本机所有候选代理端口与控制器通道：从配置文件解析出的 mixed/socks/http/外部控制端口，加上常见端口，逐个做 TCP 握手，报告哪些真实可连通、哪些只是配置里写着。用于诊断"配置说有但连不上"。',
      inputSchema: obj(),
      handler: async () => {
        const rt = await deps.getRuntime();
        const candidates = [];
        const push = (label, port, protocol, fromConfig) => {
          if (port) candidates.push({ label, port, protocol, fromConfig });
        };
        push('mixed', rt.ports.mixed, 'http+socks', true);
        push('socks', rt.ports.socks, 'socks5', true);
        push('http', rt.ports.http, 'http', true);
        if (rt.controller.tcpConfigured) {
          push('external-controller', Number(String(rt.controller.tcpConfigured).split(':').pop()), 'rest-api', true);
        }
        for (const p of [7890, 7891, 7897, 7898, 7899, 9090, 9097]) {
          if (!candidates.some((c) => c.port === p)) push(`常见端口 ${p}`, p, 'unknown', false);
        }
        const results = [];
        for (const c of candidates) {
          const reachable = await probeTcp({ host: '127.0.0.1', port: c.port, timeoutMs: 900 });
          results.push({ ...c, reachable });
        }
        let channel = null;
        try { const client = await deps.getClient(); channel = client.channelKind; client.close(); }
        catch (e) { channel = { unreachable: toEnvelope(e).kind }; }
        return ok({
          installed: rt.installed, running: rt.running,
          ports: results.filter((r) => r.protocol !== 'rest-api'),
          controllers: results.filter((r) => r.protocol === 'rest-api'),
          pipePath: rt.controller.pipe,
          restChannel: channel,
          note: 'fromConfig=false 的行只是本机在监听的常见端口，可能属于其他软件',
        });
      },
    },
    {
      name: 'proxy_core_start',
      description: '启动 Clash Verge Rev。默认 scope=session：先备份 verge.yaml，再把 enable_system_proxy 与 enable_proxy_guard 置为 false，使只有本会话的工具链走代理，浏览器与游戏完全不受影响；scope=global 保留用户自己的系统代理设置。等待控制通道就绪后返回实际通道与端口。当 channel_unavailable 提示需要开启外部控制时，用 enableExternalControl=true 再调一次本工具即可（会改 verge.yaml，已先备份，启动失败自动回滚）；没有用户明确同意不要传 true。',
      inputSchema: obj({
        scope: str(SCOPES, 'session=压制系统代理（推荐）；global=按 CVR 自身配置行事，可能影响整机'),
        timeoutMs: numSchema('等待控制器就绪的毫秒数，默认 25000'),
        enableExternalControl: bool('是否在启动前把 enable_external_controller 置为 true，用于打通 TCP 9097 控制口；默认 false，只在用户确认后传 true'),
      }),
      handler: async (a = {}) => {
        const scope = a.scope === undefined ? 'session' : a.scope;
        assertEnum(scope, SCOPES, 'scope');
        const timeoutMs = numOr(a.timeoutMs, 25000, 'timeoutMs');
        const cvr = await deps.getCvr();
        if (!cvr) throw new ApiError('not_installed', '找不到 CVR 可执行文件路径', '用 proxy_detect 确认安装目录');
        const r = await cvr.start({ scope, timeoutMs, enableExternalControl: Boolean(a.enableExternalControl) });
        return ok({ ...r, backups: (r.backups || []).map((b) => ({ name: b.name, ts: b.ts, skipped: Boolean(b.skipped) })) });
      },
    },
    {
      name: 'proxy_core_stop',
      description: '结束 clash-verge.exe 与 verge-mihomo.exe 进程。restore=true（默认）时把 verge.yaml 与 profiles.yaml 还原到最近一次插件备份，让配置回到插件动手之前的状态。',
      inputSchema: obj({ restore: bool('是否还原配置备份，默认 true') }),
      handler: async (a = {}) => {
        const cvr = await deps.getCvr();
        if (!cvr) throw new ApiError('not_installed', '找不到 CVR 配置目录', '');
        return ok(await cvr.stop({ restore: a.restore !== false }));
      },
    },
    {
      name: 'proxy_nodes',
      description: '列出代理策略组与组内节点名，含每组当前选中节点 all 列表与 history。只返回名称，不含任何服务器地址、端口、密码或 uuid。',
      inputSchema: obj({ group: str(null, '只看某个组；省略则返回全部组') }),
      handler: async (a = {}) => {
        const { client } = await requireClient(deps);
        const { groups, nodes } = await client.getProxies();
        if (a.group) {
          const all = groupOrThrow(groups, nodes, a.group);
          const hit = groups.find((g) => g.name === a.group);
          return ok({ groups: [{ name: hit.name, type: hit.type, now: hit.now, all: hit.all }], nodes: all });
        }
        return ok({ groups: groups.map((g) => ({ name: g.name, type: g.type, now: g.now, all: g.all })), nodes });
      },
    },
    {
      name: 'proxy_select',
      description: '切换节点或运行模式。传 group+target 切换某组到指定节点（切换后回读确认）；或传 mode 切 rule/global/direct。',
      inputSchema: obj({ group: str(null, '策略组名'), target: str(null, '目标节点名，必须在该组 all 里'), mode: str(MODES, '运行模式；global=全部走代理，direct=全部直连，rule=按规则') }),
      handler: async (a = {}) => {
        // 先校验再碰核心：参数不合法时不该已经建过一次控制通道连接
        if (a.mode !== undefined) assertEnum(a.mode, MODES, 'mode');
        else if (!a.group || !a.target) throw bad('需要 group+target，或者 mode', '先用 proxy_nodes 看组名与节点名');
        const { client } = await requireClient(deps);
        if (a.mode !== undefined) {
          await client.setConfigs({ mode: a.mode });
          const cfg = await client.getConfigs();
          return ok({ kind: 'mode', mode: cfg.mode, confirmed: cfg.mode === a.mode });
        }
        return ok({ kind: 'node', ...(await client.select(a.group, a.target)) });
      },
    },
    {
      name: 'proxy_test',
      description: '对节点做真实延迟测速（mihomo /delay 走 url 建连），逐个串行执行，返回按延迟升序排列的结果，失败节点标 ok:false 与原因。',
      inputSchema: obj({
        group: str(null, '测该组内全部节点'),
        proxy: str(null, '只测单个节点'),
        url: str(null, '测速目标，默认 https://www.gstatic.com/generate_204'),
        timeout: numSchema('单节点毫秒超时，默认 5000'),
      }),
      handler: async (a = {}) => {
        const { client } = await requireClient(deps);
        const names = [];
        if (a.proxy) names.push(a.proxy);
        else {
          const { groups, nodes } = await client.getProxies();
          if (a.group) names.push(...groupOrThrow(groups, nodes, a.group));
          else names.push(...nodes);
        }
        const timeoutMs = numOr(a.timeout, 5000, 'timeout');
        const results = [];
        for (const name of names) {
          try { results.push({ name, ok: true, delay: await client.delay(name, { url: a.url, timeoutMs }) }); }
          catch (e) { const env = toEnvelope(e); results.push({ name, ok: false, kind: env.kind, message: env.message }); }
        }
        const sorted = [...results].sort((x, y) => (x.ok ? x.delay : Infinity) - (y.ok ? y.delay : Infinity));
        return ok({
          tested: results.length,
          passed: results.filter((r) => r.ok).length,
          url: a.url || 'https://www.gstatic.com/generate_204',
          timeoutMs,
          best: sorted.length && sorted[0].ok ? sorted[0].name : null,
          results: sorted,
        });
      },
    },
    {
      name: 'proxy_env',
      description: '给出可直接使用的代理配置片段（端口来自实时解析，不是写死的 7897）。target=shell 返回内联前缀与 export 行；npm/git/pip 返回各自专用命令。NO_PROXY 不含 CIDR（多数工具不支持）。',
      inputSchema: obj({ target: str(TARGETS, '要适配的工具，省略则返回全部形态'), noProxyExtra: arr('额外直连域名后缀，如内网域') }),
      handler: async (a = {}) => {
        const target = a.target === undefined ? 'shell' : a.target;
        assertEnum(target, TARGETS, 'target');
        const rt = await requireInstalled(deps);
        const mixed = portsOf(rt);
        const env = buildProxyEnv({ mixedPort: mixed, socksPort: rt.ports.socks || undefined, noProxyExtra: a.noProxyExtra ? assertArray(a.noProxyExtra, 'noProxyExtra') : [] });
        return ok({ target, proxyUrl: env.proxyUrl, vars: env.vars, inline: inlinePrefix(env), snippet: env[target], all: { shell: env.shell, npm: env.npm, git: env.git, pip: env.pip }, warning: '这是单次用法；要让整个会话的 npm/git 都走代理用 proxy_toolconfig' });
      },
    },
    {
      name: 'proxy_toolconfig',
      description: '把代理写进用户级工具配置，让本会话之外的 npm/git 命令也自动走代理（不需要 agent 每次加前缀）。npm 用 ~/.npmrc 的托管块，git 用按域名前缀的 http.https://<host>/.proxy（只影响 GitHub，不动全局 http.proxy，不改系统代理，因此浏览器与游戏不变）。apply 前自动备份 ~/.npmrc。action=status 回显当前是否由插件写入、值是否与当前端口一致。',
      inputSchema: obj({ action: str(TC_ACTIONS, 'apply 写入 / revert 还原 / status 查看'), target: str(TC_TARGETS, '省略则 npm 与 git 一起处理'), hosts: arr(`自定义 git 域名列表，默认 ${GIT_PROXY_HOSTS.join(' / ')}`) }, ['action']),
      handler: async (a = {}) => {
        assertEnum(a.action, TC_ACTIONS, 'action');
        if (a.target !== undefined) assertEnum(a.target, TC_TARGETS, 'target');
        const rt = await requireInstalled(deps);
        const mixed = portsOf(rt);
        const tc = await deps.getToolConfig();
        const targets = a.target ? [a.target] : ['npm', 'git'];
        const hosts = a.hosts ? assertArray(a.hosts, 'hosts') : undefined;
        const proxyUrl = `http://127.0.0.1:${mixed}`;
        if (a.action === 'apply') return ok({ action: a.action, targets, proxyUrl, ...(await tc.apply({ proxyUrl, targets, hosts })) });
        if (a.action === 'revert') return ok({ action: a.action, targets, ...(await tc.revert({ targets, hosts })) });
        return ok(await tc.status({ hosts, expectedProxyUrl: proxyUrl }));
      },
    },
    {
      name: 'proxy_subscriptions',
      description: '列出全部订阅：名称、脱敏后的 url（token 恒为 <redacted>）、是否当前激活、节点数、已用/总量流量与到期日、最后更新时间、来源（cvr=Clash Verge 原有 / plugin=插件添加）、备注。数据以 profiles.yaml 为准，每次现读不缓存。',
      inputSchema: obj(),
      handler: async () => ok(await (await requireRepo(deps)).list()),
    },
    {
      name: 'proxy_subscription_add',
      description: '添加一条新订阅（机场换链接或加第二个机场用）。用 Clash 家族 User-Agent 抓取，校验返回必须是 YAML 或 base64 节点串而不是 HTML 登录页；通过才生成 uid、写 profiles/<uid>.yaml 与 profiles.yaml 注册项，写后立即重读校验，不一致则回滚并报 profile_registry_desync。activate=true 顺带切过去并 reload。',
      inputSchema: obj({ url: str(null, '完整 http(s) 订阅链接'), name: str(null, '显示名，缺省用响应 content-disposition 里的名字'), remark: str(null, '备注，只存插件侧清单'), activate: bool('添加后立即激活'), autoUpdate: bool('是否允许自动更新，默认 true'), updateInterval: numSchema('自动更新间隔分钟数，默认 1440') }, ['url']),
      handler: async (a = {}) => {
        if (typeof a.url !== 'string' || !a.url.trim()) {
          throw new ApiError('subscription_url_invalid', '必须提供订阅 url', '示例：https://机场域名/路径?token=xxx');
        }
        return ok(await (await requireRepo(deps)).add({
          url: a.url, name: a.name, remark: a.remark,
          activate: Boolean(a.activate), autoUpdate: a.autoUpdate !== false,
          updateInterval: numOr(a.updateInterval, 1440, 'updateInterval'),
        }));
      },
    },
    {
      name: 'proxy_subscription_edit',
      description: '修改已有订阅：换 url（token 轮换或机场换域名）、改显示名、备注、自动更新策略。换 url 时会先抓取校验成功才写注册表，抓取失败则一行都不改；内容文件保持原样（只有 proxy_subscription_update 才重写）。',
      inputSchema: obj({ uid: str(null, '订阅 uid'), url: str(null, '新的订阅链接'), name: str(null, '新显示名'), remark: str(null, '新备注'), autoUpdate: bool('是否允许自动更新'), updateInterval: numSchema('更新间隔分钟数') }, ['uid']),
      handler: async (a = {}) => {
        if (!a.uid) throw new ApiError('subscription_not_found', '缺少 uid', '用 proxy_subscriptions 查看');
        return ok(await (await requireRepo(deps)).edit(String(a.uid), {
          url: a.url, name: a.name, remark: a.remark,
          autoUpdate: a.autoUpdate, updateInterval: numOpt(a.updateInterval, 'updateInterval'),
        }));
      },
    },
    {
      name: 'proxy_subscription_update',
      description: '重新抓取订阅并刷新：传 uid 更新单条，传 all=true 批量更新。返回流量余量与节点数变化。抓取失败时保留旧配置（内容文件与注册表都不动）并返回对应 kind，批量时单条失败不影响其他条。',
      inputSchema: obj({ uid: str(null, '单条订阅 uid'), all: bool('批量更新全部（此时忽略 uid）') }),
      handler: async (a = {}) => {
        const repo = await requireRepo(deps);
        if (a.all) return ok(await repo.updateAll());
        if (!a.uid) throw bad('需要 uid 或 all=true', '用 proxy_subscriptions 查看清单');
        return ok(await repo.update(String(a.uid)));
      },
    },
    {
      name: 'proxy_subscription_activate',
      description: '切换当前激活订阅：写 profiles.yaml 的 current、让 mihomo reload，并回读实际生效的组与节点作为确认。',
      inputSchema: obj({ uid: str(null, '要激活的订阅 uid') }, ['uid']),
      handler: async (a = {}) => {
        if (!a.uid) throw new ApiError('subscription_not_found', '缺少 uid', '用 proxy_subscriptions 查看');
        return ok(await (await requireRepo(deps)).activate(String(a.uid)));
      },
    },
    {
      name: 'proxy_subscription_remove',
      description: '删除订阅：从 profiles.yaml 移除注册项，内容文件移入插件回收目录（可撤销，不硬删）。删除当前激活项必须显式 force=true。',
      inputSchema: obj({ uid: str(null, '要删除的订阅 uid'), force: bool('删除当前激活项时必填 true') }, ['uid']),
      handler: async (a = {}) => {
        if (!a.uid) throw new ApiError('subscription_not_found', '缺少 uid', '');
        return ok(await (await requireRepo(deps)).remove(String(a.uid), { force: Boolean(a.force) }));
      },
    },
    {
      name: 'proxy_diagnose',
      description: '核心验收工具：对 GitHub / npm / PyPI / Qoder 等地址，同一时刻分别跑"直连"与"经代理"两轮 curl（直连轮显式 --noproxy 屏蔽环境变量），输出对比表、结论与建议。用于回答"这个域名到底需不需要代理"和"Qoder 自己该不该走代理"。',
      inputSchema: obj({ targets: arr('要测的 URL 列表，省略则用内置 5 项'), timeoutMs: numSchema('单轮毫秒超时，默认 8000') }),
      handler: async (a = {}) => {
        const rt = await requireInstalled(deps);
        const mixed = portsOf(rt);
        const alive = await probeTcp({ host: '127.0.0.1', port: mixed, timeoutMs: 1000 });
        let list = DEFAULT_TARGETS;
        if (a.targets !== undefined) {
          const raw = assertArray(a.targets, 'targets');
          if (!raw.length) throw bad('targets 是空数组', '要么给至少一个 URL，要么省略这个参数用内置 5 项');
          list = raw.map((u, i) => {
            if (!/^https?:\/\//i.test(u)) throw bad(`targets[${i + 1}] 必须是 http(s) URL`, `收到 ${redactText(u.slice(0, 60))}`);
            return { label: `自定义 ${i + 1}`, url: u, expectDirect: true };
          });
        }
        const d = deps.getDiagnoseDeps();
        return ok(await runDiagnose({
          proxyUrl: `http://127.0.0.1:${mixed}`,
          portAlive: alive,
          targets: list,
          curlRunner: d.curlRunner,
          timeoutMs: numOr(a.timeoutMs, 8000, 'timeoutMs'),
        }));
      },
    },
    {
      name: 'proxy_restore_config',
      description: '列出插件对 verge.yaml / profiles.yaml 做过的全部带时间戳备份并还原。npm 与 git 的用户级配置走 ToolConfig 的托管块撤销（name=npm|git），因为它们的备份不在 CVR 配置目录里。中途放弃或想把改动全部撤销时用它；CVR 配置还原后与备份逐字节一致。',
      inputSchema: obj({ name: str(CVR_RESTORE_TARGETS, '只还原指定项：verge.yaml / profiles.yaml 走 CVR 备份；npm / git 走托管块移除。省略则还原两个 CVR 配置文件'), listOnly: bool('只列备份不还原') }),
      handler: async (a = {}) => {
        if (a.name !== undefined) assertEnum(a.name, CVR_RESTORE_TARGETS, 'name');
        const cvr = await deps.getCvr();
        if (!cvr) throw new ApiError('not_installed', '没有可还原的 CVR 配置目录', '');
        const backups = cvr.listBackups();
        if (a.listOnly) return ok({ backups, note: '还原会把内容写回 configDir，不会删除备份' });
        // npm/git 的托管块由 ToolConfig 拥有，CvrConfig 的备份目录里根本没有它们
        if (a.name === 'npm' || a.name === 'git') {
          const tc = await deps.getToolConfig();
          return ok({ via: 'toolconfig', result: await tc.revert({ targets: [a.name] }) });
        }
        const names = a.name ? [a.name] : ['verge.yaml', 'profiles.yaml'];
        const r = await cvr.restore(names);
        return ok({ backups, restored: r.restored, skipped: names.filter((n) => !r.restored.some((x) => x.name === n)) });
      },
    },
  ];
}

const TOOL_NAMES = [
  'proxy_status', 'proxy_detect', 'proxy_core_start', 'proxy_core_stop', 'proxy_nodes', 'proxy_select',
  'proxy_test', 'proxy_env', 'proxy_toolconfig', 'proxy_subscriptions', 'proxy_subscription_add',
  'proxy_subscription_edit', 'proxy_subscription_update', 'proxy_subscription_activate',
  'proxy_subscription_remove', 'proxy_diagnose', 'proxy_restore_config',
];

async function callTool(name, args, deps) {
  const tool = buildTools(deps).find((t) => t.name === name);
  if (!tool) return fail('malformed_config', `未知工具 ${redactText(String(name))}`, `可用工具：${TOOL_NAMES.join(', ')}`);
  try {
    rejectExtra(args || {}, tool.inputSchema);
    return await tool.handler(args || {});
  } catch (e) {
    // 错误消息来自更深的层，可能带着原始 url，所以出边界前再过一次脱敏
    const env = toEnvelope(e);
    return fail(env.kind, redactText(env.message), redactText(env.hint));
  }
}

module.exports = { buildTools, callTool, TOOL_NAMES };
