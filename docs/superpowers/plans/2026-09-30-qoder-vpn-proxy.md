# qoder-vpn-proxy 插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个 Qoder 插件，复用本机已装的 Clash Verge Rev / mihomo 作为代理内核，让 agent 能识别代理状态、管理订阅与节点，并让会话内的 `npm` / `git` 等工具链实际走代理。

**Architecture:** 插件不实现代理转发，只做"发现 → 控制 → 诊断"。传输层抽象出命名管道与 TCP 两个实现（本机 TCP 控制口默认关闭，管道是唯一可用通道）；业务层用 mihomo REST API 提供状态、节点、测速、订阅 CRUD；生效层不依赖 agent 配合，直接写用户级 `~/.npmrc` 与 git 全局域名代理。全部代码为 CommonJS，零第三方依赖。

**Tech Stack:** Node.js v22（仅 `node:http`、`node:net`、`node:fs`、`node:child_process`、`node:crypto`）、`node:test` 测试框架、MCP stdio JSON-RPC 2.0、Windows 命名管道。

**Spec:** `docs/superpowers/specs/2026-09-30-qoder-vpn-proxy-design.md`（含 §2 全部实测事实基线、§3.4 已被推翻的假设记录、§8 未验证项）

## Global Constraints

以下为项目级硬约束，每个任务都隐含遵守：

- 运行时只用 Node.js v22 内置模块。**禁止 `npm install` 任何依赖**（本机 npm 直连可能失败，且插件必须零安装即可运行）。测试用内置 `node:test` + `node:assert/strict`。
- 所有 17 个 MCP 工具统一返回 `{ok: true, data}` 或 `{ok: false, kind, message, hint}`。`kind` 取值限定为 spec §4 表中的：`not_installed`、`core_not_running`、`channel_unavailable`、`auth_failed`、`timeout`、`subscription_format_unexpected`、`subscription_url_invalid`、`subscription_duplicate`、`subscription_not_found`、`subscription_active_protected`、`profile_registry_desync`、`config_write_failed`、`malformed_config`。
- 任何工具输出、错误消息、日志都必须过 `redactText()`：订阅 URL 的 `token=<值>` 一律替换为 `token=<redacted>`；`ss://`、`vmess://`、`trojan://`、`vless://` 整条替换为 `<node-url-redacted>`；YAML 中的 `password:`、`uuid:`、`sni:`、`server:` 值不进入输出。
- `proxy_nodes` 只返回节点名，绝不返回 `server` / `port` / `password` / `uuid` / `sni`。
- 只连接 `127.0.0.1` 与本机命名管道，不向任何第三方发送用户配置。用户自行添加的订阅地址不做额外探测。
- 代理端口一律取自 `discovery()` 的返回值，**不得硬编码 7897**。
- 写 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\` 下任何文件（`verge.yaml`、`profiles.yaml`）之前，必须先做带时间戳的完整备份；备份失败则中止，不进入半改状态。
- MCP stdio 服务端的 `process.stdout` 只写 JSON-RPC 帧。日志一律写 `stderr` 或插件数据目录文件，否则会破坏协议。
- 面向用户的文案（工具 `description`、`hint`、`SKILL.md`、README）用中文。
- 每个任务结束时 `node --test` 必须全绿，然后提交一次 git commit。

## 文件结构

在 `C:\Users\Administrator\Documents\Qoder\2026-09-30\aa25fd26\qoder-vpn-proxy\` 下开发：

| 文件 | 职责 |
|---|---|
| `package.json` | 声明 `"type":"commonjs"` 与 `test` 脚本；无 dependencies |
| `server/envelope.js` | `{ok,data}` / `{ok:false,kind,message,hint}` 构造器与错误类型 |
| `server/redact.js` | token 与节点凭据脱敏 |
| `server/env.js` | 代理环境变量块、按 target 适配的 NO_PROXY |
| `server/subscription.js` | 无状态：UA 门控抓取、格式嗅探、userinfo 解析 |
| `server/transport.js` | `Transport` 接口 + `PipeTransport` + `TcpTransport` + `createTransport` |
| `server/discovery.js` | 只读发现：目录、端口、控制器、settings、profiles |
| `server/clash-client.js` | mihomo REST 语义方法 |
| `server/cvr-config.js` | 配置备份/改写/还原、CVR 进程启停 |
| `server/profilesYaml.js` | `profiles.yaml` 外科式文本编辑 |
| `server/store.js` | 插件数据目录、原子写、备份索引、`.trash` |
| `server/subscriptions.js` | 订阅仓库 CRUD + 与 `profiles.yaml` 同步 |
| `server/toolconfig.js` | `~/.npmrc` 与 git 全局配置的 apply/revert/status |
| `server/diagnose.js` | 直连 vs 经代理 对比探测 |
| `server/protocol.js` | MCP JSON-RPC 编解码与分派 |
| `server/tools.js` | 17 个工具的 schema 与 handler 表 |
| `server/index.js` | stdio 入口 |
| `.qoder-plugin/plugin.json` | 插件清单 |
| `mcp.json` | stdio MCP server 声明 |
| `hooks/hooks.json`、`hooks/run-hook.cmd`、`hooks/session-start` | SessionStart 提示注入 |
| `skills/vpn-proxy/SKILL.md` | agent 使用指引 |
| `test/fake-mihomo.js` | 桩化 mihomo 的 TCP+管道双监听服务端 |
| `test/*.test.js` | 各层单测 |
| `scripts/probe-pipe.js` | 任务 1 的命名管道探针 |

---

## 阶段 0：探针（产出结论，不产出保留代码）

### Task 1: 命名管道能否完成 mihomo REST 握手

这是全设计的最大不确定点（spec §8）。`enable_external_controller: false` 意味着 TCP 9097 未绑定，命名管道是唯一通道。**本任务会真实启动用户的 Clash Verge，并连带打开系统代理，属于对外可见的机器级改动。**

**Files:**
- Create: `qoder-vpn-proxy/scripts/probe-pipe.js`
- Create: `docs/superpowers/probes/01-named-pipe.md`

**Interfaces:**
- Produces: 一条结论写进 probe 文档，供 Task 7 决定 `createTransport()` 的默认顺序；供 Task 10 决定 `startCore()` 是否必须先开 TCP 外部控制。

- [x] **Step 1: 向用户取得启动 Clash Verge 的许可**

显式说明三件事后再动手：会启动 GUI 进程与托盘图标；因 `enable_system_proxy: true`，整机会走代理（浏览器、游戏等受影响）；验证结束会还原。用户同意才继续。

- [x] **Step 2: 备份当前 verge.yaml 与记录系统代理原状**

```bash
CVR="$APPDATA/io.github.clash-verge-rev.clash-verge-rev"
mkdir -p probe-backups && cp "$CVR/verge.yaml" "probe-backups/verge.yaml.$(date +%s)"
cmd //c "reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" | grep -i -E 'ProxyEnable|ProxyServer' || echo "无 ProxyEnable 项(系统代理关闭)"
```

Expected: 打印出备份文件与"无 ProxyEnable 项"。把原状记进 probe 文档。

- [x] **Step 3: 启动 CVR**

```bash
cmd //c start "" "C:\\Program Files\\Clash Verge\\clash-verge.exe"
sleep 12
tasklist | grep -i -E 'clash-verge|verge-mihomo' || echo "未启动"
netstat -ano -p tcp | grep LISTEN | grep -E ':(7897|7898|7899|9097)\b' || echo "无端口监听"
```

Expected: 两个进程都在；7897 监听；**9097 不监听**（证明 TCP 控制口确实关着）。

- [x] **Step 4: 写探针脚本，用 `socketPath` 走命名管道**

`qoder-vpn-proxy/scripts/probe-pipe.js`：

```js
'use strict';
const http = require('node:http');

const PIPE = '\\\\.\\pipe\\verge-mihomo';
const SECRET = 'set-your-secret';

function req(opts, label) {
  return new Promise((resolve) => {
    const r = http.request({ ...opts, timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ label, status: res.statusCode, body: body.slice(0, 400) }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ label, error: 'timeout' }); });
    r.on('error', (e) => resolve({ label, error: `${e.code} ${e.message}` }));
    r.end();
  });
}

const base = { path: '/version', headers: { Host: 'localhost', Authorization: `Bearer ${SECRET}` } };
(async () => {
  console.log(JSON.stringify(await req({ socketPath: PIPE, ...base }, 'pipe /version')));
  console.log(JSON.stringify(await req({ socketPath: PIPE, path: '/proxies', ...base }, 'pipe /proxies')));
  console.log(JSON.stringify(await req({ host: '127.0.0.1', port: 9097, ...base }, 'tcp /version')));
})();
```

- [x] **Step 5: 跑探针并记录原始输出**

Run: `cd qoder-vpn-proxy && node scripts/probe-pipe.js`
Expected: 三条 JSON。关键看 `pipe /version` 是否 `status:200` 且 body 含 mihomo 版本；`tcp /version` 预期 `error: ECONNREFUSED`。

- [ ] **Step 6: 若管道失败，测降级路径**

  > **未触发，故意留空**：Step 5 的命名管道一次成功（`enable_external_controller:false` 也能跑完整 REST），所以这条降级分支不需要走。TCP 兜底代码仍保留并测试（Task 7），因为换机器可能就是另一回事。结论见 `docs/superpowers/probes/01-named-pipe.md`。

管道返回 error 或 401 时：在 GUI 中打开"外部控制"（或直接改 `verge.yaml` 的 `enable_external_controller: true` 并重启 CVR），再跑一次 Step 5，记录 TCP 通道是否可用。这条结论决定 Task 7 的默认顺序。

- [x] **Step 7: 还原现场**

```bash
taskkill //IM clash-verge.exe //F
taskkill //IM verge-mihomo.exe //F 2>/dev/null
cmd //c "reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings /v ProxyEnable /t REG_DWORD /d 0 /f"
CVR="$APPDATA/io.github.clash-verge-rev.clash-verge-rev"
cp probe-backups/verge.yaml.<时间戳> "$CVR/verge.yaml"
netstat -ano -p tcp | grep -E ':(7897|9097)\b' || echo "端口已释放"
```

Expected: 进程清空、ProxyEnable=0、7897/9097 不再监听。

- [x] **Step 8: 写结论并提交**

`docs/superpowers/probes/01-named-pipe.md` 必须包含：三条 JSON 原始输出（脱敏后）、"命名管道 HTTP 可用 = 是/否"、"TCP 9097 默认可用 = 是/否"、系统代理是否被 CVR 打开、还原是否逐字节一致。

```bash
git add -A && git commit -m "probe: 命名管道 mihomo REST 握手实测结论"
```

---

### Task 2: Hook 能力边界（SessionStart 已确认，PreToolUse 待测）

**Files:**
- Create: `docs/superpowers/probes/02-hooks.md`

**Interfaces:**
- Produces: 结论决定 Task 16 是否实现 `hooks/session-start` 的提示注入，以及 Task 13 的 `toolconfig` 是否必须承担全部生效责任。

- [x] **Step 1: 定位 Qoder CLI 自身的 JS 包**

```bash
ls -d "/c/Program Files/Qoder"* 2>/dev/null
find "$HOME/.qoder/app" -maxdepth 3 -name '*.js' 2>/dev/null | head
find "/c/Users/Administrator/AppData/Local" -maxdepth 4 -iname '*qoder*' -type d 2>/dev/null | head
```

Expected: 找到 CLI 的 JS 目录（后续 grep 目标）。

- [x] **Step 2: grep hook 事件与支持字段**

在 Step 1 找到的 JS 目录里搜：

```bash
grep -r -o -E 'hookSpecificOutput|additionalContext|updatedInput|"PreToolUse"|"SessionStart"|"PostToolUse"' <js目录> 2>/dev/null | sort | uniq -c | sort -rn | head -20
```

Expected: 出现 `hookSpecificOutput` 与 `additionalContext` 即确认 SessionStart 通道；出现 `updatedInput` 即说明 PreToolUse 可改写工具输入。

- [x] **Step 3: 记录结论，明确"环境变量注入不可行"**

已确认的事实（写进文档，勿再假设）：superpowers 的 `session-start.cjs` 只 `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext}}))`；`~/.qoder/session-env/<uuid>/sessionstart-hook-N.sh` 是 Qoder 自己创建的空文件，**不是**被 source 的注入点。因此 hook 无法 export 环境变量给 Bash 工具。

- [x] **Step 4: 标注需重启才能终验**

插件的 hook 需 Qoder 重启才生效，而重启会中断当前会话。文档中写明：最终验证放在 Task 17，由用户手动重启后确认新会话是否出现代理提示。

- [x] **Step 5: 提交**

```bash
git add docs/superpowers/probes/02-hooks.md && git commit -m "probe: Qoder hook 能力边界与 additionalContext 机制"
```

---

## 阶段 1：纯函数层（完全离线，可先于任何真实代理开发）

### Task 3: 项目脚手架与 envelope / redact

**Files:**
- Create: `qoder-vpn-proxy/package.json`
- Create: `qoder-vpn-proxy/server/envelope.js`
- Create: `qoder-vpn-proxy/server/redact.js`
- Test: `qoder-vpn-proxy/test/redact.test.js`

**Interfaces:**
- Produces:
  - `envelope.ok(data) -> {ok:true, data}`；`envelope.fail(kind, message, hint) -> {ok:false, kind, message, hint}`；`class ApiError extends Error {constructor(kind, message, hint)}`；`ENVELOPE_KINDS`（§Global Constraints 的 13 个 kind 的数组，用于校验）
  - `redact.redactText(str) -> str`；`redact.redactUrl(str) -> str`

- [x] **Step 1: 写 package.json**

```json
{
  "name": "qoder-vpn-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "description": "识别并使用本机 Clash Verge Rev 代理的 Qoder 插件",
  "scripts": { "test": "node --test" }
}
```

- [x] **Step 2: 写失败的测试**

`test/redact.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactText, redactUrl } = require('../server/redact');

test('redactUrl 抹掉 token 但保留域名与路径', () => {
  const out = redactUrl('https://sub.example.invalid/SUBPATH?token=0123456789abcdef0123456789abcdef');
  assert.equal(out, 'https://sub.example.invalid/SUBPATH?token=<redacted>');
});

test('redactText 抹掉 token 型 query', () => {
  assert.match(redactText('拉取失败 ?token=abc123 状态 500'), /\?token=<redacted>/);
  assert.doesNotMatch(redactText('?token=abc123'), /abc123/);
});

test('redactText 抹掉节点 URL', () => {
  const s = 'ss://YWVzLWc4LXBvbHk6cHc@1.2.3.4:8388#HK 和 vmess://eyJhZG0iOiIxQDEuMi4zLjQifQ==#JP';
  const out = redactText(s);
  assert.doesNotMatch(out, /1\.2\.3\.4/);
  assert.equal((out.match(/<node-url-redacted>/g) || []).length, 2);
});

test('redactText 抹掉 yaml 中的 server/password/uuid', () => {
  const y = '  - name: HK1\n    server: 9.9.9.9\n    port: 443\n    password: sekret\n    uuid: 11112222-3333';
  const out = redactText(y);
  assert.doesNotMatch(out, /9\.9\.9\.9|sekret|11112222/);
  assert.match(out, /name: HK1/);
});

test('redactText 对 undefined 与数字安全', () => {
  assert.equal(redactText(undefined), '');
  assert.equal(redactText(42), '42');
});
```

- [x] **Step 3: 跑测试确认失败**

Run: `cd qoder-vpn-proxy && node --test`
Expected: FAIL，`Cannot find module '../server/redact'`

- [x] **Step 4: 实现 redact.js**

`server/redact.js`：

```js
'use strict';

const NODE_SCHEME = /\b(?:ss|vmess|trojan|vless|hysteria2|hy2|tuic|wireguard):\/\/\S+/g;
const SENSITIVE_KV = /^(\s*)(server|server_port|port|password|passwd|uuid|sni|client-fingerprint|public-key|private-key)(\s*[:=]\s*)(\S+)(\s*(?:#.*)?)$/gim;

function redactUrl(url) {
  if (typeof url !== 'string') return '';
  return url.replace(/([?&]token=)[^&#]*/gi, '$1<redacted>');
}

function redactText(value) {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s
    .replace(NODE_SCHEME, '<node-url-redacted>')
    .replace(SENSITIVE_KV, '$1$2$3<redacted>$5')
    .replace(/([?&]token=)[^&#\s"']*/gi, '$1<redacted>');
}

module.exports = { redactUrl, redactText };
```

- [x] **Step 5: 实现 envelope.js**

`server/envelope.js`：

```js
'use strict';

const ENVELOPE_KINDS = [
  'not_installed', 'core_not_running', 'channel_unavailable', 'auth_failed', 'timeout',
  'subscription_format_unexpected', 'subscription_url_invalid', 'subscription_duplicate',
  'subscription_not_found', 'subscription_active_protected', 'profile_registry_desync',
  'config_write_failed', 'malformed_config',
];

class ApiError extends Error {
  constructor(kind, message, hint) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.hint = hint || '';
  }
}

const ok = (data) => ({ ok: true, data });
const fail = (kind, message, hint) => ({ ok: false, kind, message, hint: hint || '' });

function toEnvelope(err) {
  if (err instanceof ApiError) return fail(err.kind, err.message, err.hint);
  if (err && (err.code === 'ETIMEDOUT' || /timeout/i.test(String(err.message)))) {
    return fail('timeout', String(err.message || err), '控制器或节点响应超时，可缩短 timeout 或换节点');
  }
  return fail('channel_unavailable', String((err && err.message) || err), '未预期的错误，详见插件日志');
}

module.exports = { ok, fail, ApiError, ENVELOPE_KINDS, toEnvelope };
```

- [x] **Step 6: 跑测试确认通过**

Run: `node --test`
Expected: PASS（5 个测试）

- [x] **Step 7: 提交**

```bash
git add qoder-vpn-proxy/package.json qoder-vpn-proxy/server qoder-vpn-proxy/test
git commit -m "feat: envelope 与 redact —— 统一返回结构与 token/节点凭据脱敏"
```

---

### Task 4: env.js —— 按工具适配的代理环境块

**Files:**
- Create: `qoder-vpn-proxy/server/env.js`
- Test: `qoder-vpn-proxy/test/env.test.js`

**Interfaces:**
- Consumes: 无（纯函数，端口由调用方传入）
- Produces: `buildProxyEnv({mixedPort, socksPort, noProxyExtra?: string[]}) -> { proxyUrl, socksUrl, vars: {HTTP_PROXY,HTTPS_PROXY,ALL_PROXY,NO_PROXY}, shell: string[], npm: string[], git: string[], pip: string[] }`；`inlinePrefix(env) -> string`

- [x] **Step 1: 写失败的测试**

`test/env.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildProxyEnv, inlinePrefix } = require('../server/env');

test('端口来自入参而非硬编码', () => {
  const e = buildProxyEnv({ mixedPort: 7890, socksPort: 7891 });
  assert.equal(e.proxyUrl, 'http://127.0.0.1:7890');
  assert.equal(e.vars.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(e.vars.ALL_PROXY, 'socks5://127.0.0.1:7890');
});

test('NO_PROXY 恒含 loopback 且不含 CIDR', () => {
  const e = buildProxyEnv({ mixedPort: 7897, socksPort: 7898, noProxyExtra: ['*.corp.example'] });
  const parts = e.vars.NO_PROXY.split(',');
  assert.ok(parts.includes('127.0.0.1') && parts.includes('localhost') && parts.includes('::1'));
  assert.ok(parts.includes('*.corp.example'));
  assert.doesNotMatch(e.vars.NO_PROXY, /\/\d+/);
});

test('git 用域名前缀代理而不是全局 http.proxy', () => {
  const e = buildProxyEnv({ mixedPort: 7897, socksPort: 7898 });
  assert.ok(e.git.some((l) => l.includes('http.https://github.com.proxy')));
  assert.ok(!e.git.some((l) => /(^| )http\.proxy/.test(l)), '不允许全局 http.proxy');
});

test('npm 片段含 registry 与 noproxy', () => {
  const e = buildProxyEnv({ mixedPort: 7897, socksPort: 7898 });
  assert.ok(e.npm.some((l) => l.startsWith('https-proxy=')));
  assert.ok(e.npm.some((l) => l.startsWith('noproxy=')));
});

test('shell 片段是可直接 export 的形式', () => {
  const e = buildProxyEnv({ mixedPort: 7897, socksPort: 7898 });
  assert.deepEqual(e.shell, [
    'export HTTP_PROXY=http://127.0.0.1:7897',
    'export HTTPS_PROXY=http://127.0.0.1:7897',
    'export ALL_PROXY=socks5://127.0.0.1:7897',
    `export NO_PROXY="${e.vars.NO_PROXY}"`,
  ]);
  assert.equal(inlinePrefix(e), 'HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=' + JSON.stringify(e.vars.NO_PROXY));
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/env.test.js`
Expected: FAIL，`Cannot find module '../server/env'`

- [x] **Step 3: 实现**

`server/env.js`：

```js
'use strict';

const GIT_PROXY_HOSTS = ['github.com', 'objects.githubusercontent.com', 'api.github.com'];
const BASE_NO_PROXY = ['127.0.0.1', 'localhost', '::1', '*.cn', '*.com.cn', '*.localhost', '169.254.169.254'];
const NPM_NO_PROXY = ['localhost', '127.0.0.1'];

function buildProxyEnv({ mixedPort, socksPort, noProxyExtra = [] }) {
  if (!Number.isInteger(mixedPort) || mixedPort < 1 || mixedPort > 65535) {
    throw new RangeError(`mixedPort 非法: ${mixedPort}`);
  }
  const proxyUrl = `http://127.0.0.1:${mixedPort}`;
  const socksUrl = `socks5://127.0.0.1:${mixedPort}`;
  const noProxy = [...BASE_NO_PROXY, ...noProxyExtra].join(',');

  return {
    proxyUrl,
    socksUrl,
    mixedPort,
    socksPort,
    vars: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: socksUrl, NO_PROXY: noProxy },
    shell: [
      `export HTTP_PROXY=${proxyUrl}`,
      `export HTTPS_PROXY=${proxyUrl}`,
      `export ALL_PROXY=${socksUrl}`,
      `export NO_PROXY="${noProxy}"`,
    ],
    npm: [`proxy=${proxyUrl}`, `https-proxy=${proxyUrl}`, `noproxy=${NPM_NO_PROXY.join(',')}`],
    git: GIT_PROXY_HOSTS.map((h) => `git config --global http.https://${h}/.proxy ${proxyUrl}`),
    pip: [`python -m pip config set global.proxy ${proxyUrl}`, `python -m pip config set global.trusted_host ""`],
  };
}

function inlinePrefix(e) {
  return `HTTP_PROXY=${e.proxyUrl} HTTPS_PROXY=${e.proxyUrl} NO_PROXY=${JSON.stringify(e.vars.NO_PROXY)}`;
}

module.exports = { buildProxyEnv, inlinePrefix, GIT_PROXY_HOSTS };
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test test/env.test.js`
Expected: PASS（5 个测试）

- [x] **Step 5: 提交**

```bash
git add qoder-vpn-proxy/server/env.js qoder-vpn-proxy/test/env.test.js
git commit -m "feat: env 生成按 curl/npm/git 分别适配的代理配置"
```

---

### Task 5: subscription.js —— UA 门控抓取与格式嗅探

**Files:**
- Create: `qoder-vpn-proxy/server/subscription.js`
- Create: `qoder-vpn-proxy/test/fixtures/sub-yaml.txt`（从真实响应复制后脱敏：所有 `server:` 值改 `192.0.2.10`，`password:`/`uuid:` 改占位）
- Create: `qoder-vpn-proxy/test/fixtures/sub-base64.txt`
- Create: `qoder-vpn-proxy/test/fixtures/sub-html.txt`
- Test: `qoder-vpn-proxy/test/subscription.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CLASH_UA: string`（`'clash-verge/v2.3.0'`）
  - `sniffFormat(body: string) -> 'yaml' | 'base64' | 'html' | 'unknown'`
  - `parseUserInfo(header: string) -> {upload,download,total,expire}|null`（字节数字段为 number，`expire` 为空或 `0` 时返回 `null`）
  - `parseSubscriptionName(contentDisposition: string) -> string|null`
  - `countNodes(parsed) -> number`
  - `decodeBody(body, format) -> {yaml: string|null, nodes: number}`
  - `fetchSubscription(url, {timeoutMs?}) -> Promise<{format, userInfo, name, yaml, nodes, bytes}>`（失败抛 `ApiError`）

- [x] **Step 1: 准备 fixture**

用 Task 1 之前已跑通的抓取方式生成 fixture。抓取产物放在仓库外（`%TEMP%`），再用一次性脱敏脚本写入 `test/fixtures/`，**原始文件绝不进仓库、也不打印到终端**：

```bash
U='https://<订阅站主机>/<订阅路径>?token=<TOKEN>'   # 真实链接由用户提供，不要写进计划或仓库
curl -sS -A 'clash-verge/v2.3.0' --max-time 25 "$U" -o "$TEMP/raw-yaml.txt"
curl -sS -A 'curl/8.4'          --max-time 25 "$U" -o "$TEMP/raw-b64.txt"
printf '<!DOCTYPE html>\n<html><head><title>会员订阅</title></head><body>登录</body></html>' > test/fixtures/sub-html.txt
```

脱敏脚本要做的事（按实测响应结构确定，不要只改 `server:`）：

- 截到 `^rules:` 之前，保证 `proxies:` 与 `proxy-groups:` 两段完整。
- `server:` → `192.0.2.10`，`password:` → `REDACTED`，`uuid:` → `REDACTED-UUID`，
  `public-key:` → `REDACTED-PUBKEY`，`short-id:` → `REDACTED-SHORTID`，
  `servername:`/`sni:` → `example.invalid`。必须同时匹配 **flow 风格** `{ server: x, password: y }`
  与 block 风格，所以用 `(\b<key>:\s*)[^,}\]\n]*` 而不是行尾匹配。
- `*nameserver:` 的公共 resolver 列表换成 `[192.0.2.10, 192.0.2.11]`，否则 Step 6 的宽松 grep 会误报。
- 供应商身份同样不入库：面板域名 → `panel.example.invalid`，订阅品牌名 → `示例订阅`。
  测试里的 `content-disposition` 用例也随之用 `%E7%A4%BA%E4%BE%8B%E8%AE%A2%E9%98%85`。
- base64 fixture 由解码后的**假节点**重新编码（`ss://` 用 `REDACTED` 凭据 + `192.0.2.10`），
  节点名保留以覆盖中文/emoji/竖线等形状。

- [x] **Step 2: 写失败的测试**

`test/subscription.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../server/subscription');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

test('UA 必须是 Clash 家族', () => { assert.match(S.CLASH_UA, /^clash-verge\//); });

test('sniffFormat 区分 yaml / base64 / html', () => {
  assert.equal(S.sniffFormat(fx('sub-yaml.txt')), 'yaml');
  assert.equal(S.sniffFormat(fx('sub-base64.txt')), 'base64');
  assert.equal(S.sniffFormat(fx('sub-html.txt')), 'html');
  assert.equal(S.sniffFormat(''), 'unknown');
});

test('parseUserInfo 解析标准头', () => {
  assert.deepEqual(
    S.parseUserInfo('upload=359591668; download=53636662825; total=74826208722; expire=1798761600'),
    { upload: 359591668, download: 53636662825, total: 74826208722, expire: 1798761600 });
  assert.equal(S.parseUserInfo('upload=0; download=0; total=74826208722; expire=').expire, null);
  assert.equal(S.parseUserInfo(undefined), null);
});

test('parseSubscriptionName 解 RFC5987 中文文件名', () => {
  assert.equal(S.parseSubscriptionName("attachment;filename*=UTF-8''%E7%A4%BA%E4%BE%8B%E8%AE%A2%E9%98%85"), '示例订阅');
  assert.equal(S.parseSubscriptionName('attachment;filename=sub.txt'), 'sub.txt');
  assert.equal(S.parseSubscriptionName(undefined), null);
});

test('yaml 能数出节点数且不含凭据', () => {
  const { yaml, nodes } = S.decodeBody(fx('sub-yaml.txt'), 'yaml');
  assert.match(yaml, /proxy-groups:/);
  assert.ok(nodes > 0);
  // fixture 是 flow 风格（- { name: ... }），且 proxy-groups 也用同一形状：
  // 计数器只能统计 proxies 段，不能被 proxy-groups 的 name 混入
  assert.equal(nodes, 15);
});

test('base64 解出 ss:// 列表并计数', () => {
  const { yaml, nodes } = S.decodeBody(fx('sub-base64.txt'), 'base64');
  assert.equal(yaml, null);
  assert.equal(nodes, 15);
});

test('html 判定为格式异常并抛 ApiError', () => {
  assert.throws(() => S.decodeBody(fx('sub-html.txt'), 'html'), (e) => e.kind === 'subscription_format_unexpected');
});
```

- [x] **Step 3: 跑测试确认失败**

Run: `node --test test/subscription.test.js`
Expected: FAIL，`Cannot find module '../server/subscription'`

- [x] **Step 4: 实现**

`server/subscription.js`：

```js
'use strict';
const https = require('node:https');
const http = require('node:http');
const { ApiError } = require('./envelope');
const { redactUrl, redactText } = require('./redact');

const CLASH_UA = 'clash-verge/v2.3.0';

function sniffFormat(body) {
  if (!body || !body.trim()) return 'unknown';
  const head = body.slice(0, 400).toLowerCase();
  if (/^\s*(proxy|<!doctype html|<html|<!doctype)/.test(head)) {
    return /<!doctype html|<html|<head/.test(head) ? 'html' : 'yaml';
  }
  if (/^(mixed-port|port|socks-port|proxies|proxy-groups|dns|rules|mode|allow-lan):/m.test(body.slice(0, 4000))) return 'yaml';
  if (/^\s*(ss|vmess|trojan|vless|hy2|hysteria2|tuic):\/\//m.test(body.slice(0, 4000))) return 'base64';
  const oneLine = body.trim().replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(oneLine) && oneLine.length > 40) {
    try {
      const decoded = Buffer.from(oneLine, 'base64').toString('utf8');
      if (/(ss|vmess|trojan|vless):\/\//.test(decoded)) return 'base64';
    } catch { /* 落到 unknown */ }
  }
  if (/<\s*(html|!doctype)/i.test(body.slice(0, 2000))) return 'html';
  return 'unknown';
}

function parseUserInfo(header) {
  if (!header) return null;
  const num = (k) => {
    const m = new RegExp(`${k}\\s*=\\s*(\\d+)`, 'i').exec(header);
    return m ? Number(m[1]) : null;
  };
  const out = { upload: num('upload'), download: num('download'), total: num('total'), expire: num('expire') };
  return out.total === null && out.download === null ? null : out;
}

function parseSubscriptionName(contentDisposition) {
  if (!contentDisposition) return null;
  const star = /filename\*\s*=\s*([^;']*)'([^']*)'([^;]+)/i.exec(contentDisposition);
  if (star) { try { return decodeURIComponent(star[3].trim()); } catch { return star[3].trim(); } }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition);
  if (plain) { try { return decodeURIComponent(plain[1].trim()); } catch { return plain[1].trim(); } }
  return null;
}

function decodeBody(body, format) {
  if (format === 'yaml') {
    const m = /\nproxies:\s*\n([\s\S]*?)(?=\n[a-zA-Z_-]+:|\nproxy-groups:|$)/.exec(body);
    // 机场两种写法都有：`- name: x` 块式与 `- { name: x, ... }` 流式
    const nodes = m ? (m[1].match(/^\s*-\s*(?:\{\s*)?name:/gm) || []).length : 0;
    return { yaml: body, nodes };
  }
  if (format === 'base64') {
    const decoded = Buffer.from(body.trim().replace(/\s+/g, ''), 'base64').toString('utf8');
    // 真实订阅既有逗号连接的单行，也有换行连接的多行，两者都要数对
    const nodes = decoded.split(/[,\n]/).map((s) => s.trim()).filter((s) => /:\/\//.test(s)).length;
    if (!nodes) throw new ApiError('subscription_format_unexpected', 'base64 解码后没有可用节点', '订阅可能已过期或链接被重置');
    return { yaml: null, nodes };
  }
  throw new ApiError(
    'subscription_format_unexpected',
    redactText(`订阅返回格式为 ${format}，不是 Clash 配置`),
    '该机场按 User-Agent 分流：必须用 Clash 家族 UA 才返回完整 YAML；也可能链接已失效'
  );
}

function countNodes(parsed) { return parsed.nodes; }

function fetchSubscription(url, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return reject(new ApiError('subscription_url_invalid', `URL 无法解析: ${redactUrl(String(url))}`, '需要完整的 http(s) 订阅链接')); }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return reject(new ApiError('subscription_url_invalid', '只支持 http(s) 订阅链接', ''));
    }
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const req = mod.request(parsedUrl, {
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'User-Agent': CLASH_UA, Accept: '*/*' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchSubscription(new URL(res.headers.location, parsedUrl).href, { timeoutMs }).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new ApiError('subscription_format_unexpected',
            `HTTP ${res.statusCode}`, `订阅站返回非 200；${redactUrl(url)}`));
        }
        const format = sniffFormat(body);
        const decoded = decodeBody(body, format);
        resolve({
          format,
          userInfo: parseUserInfo(res.headers['subscription-userinfo']),
          name: parseSubscriptionName(res.headers['content-disposition']),
          yaml: decoded.yaml,
          nodes: decoded.nodes,
          bytes: Buffer.byteLength(body),
        });
      });
    });
    req.on('timeout', () => req.destroy(new ApiError('timeout', '抓取订阅超时', '订阅站可能被墙，需先开代理再更新')));
    req.on('error', (e) => reject(new ApiError('timeout', `抓取订阅失败: ${e.code || e.message}`, '确认该域名能否直连')));
    req.end();
  });
}

module.exports = { CLASH_UA, sniffFormat, parseUserInfo, parseSubscriptionName, decodeBody, countNodes, fetchSubscription };
```

- [x] **Step 5: 跑测试确认通过**

Run: `node --test test/subscription.test.js`
Expected: PASS（7 个测试）。若 `sniffFormat(fx('sub-base64.txt'))` 判成 `unknown`，检查 fixture 是否含换行并被 `oneLine` 分支正确解码。

- [x] **Step 6: 确认 fixture 已脱敏**

Run: `grep -E -o '(server:|password:|uuid:)\s*\S+' test/fixtures/sub-yaml.txt | grep -v -E '192\.0\.2\.10|REDACTED' || echo "脱敏 OK"`
Expected: `脱敏 OK`。仓库里绝不能留真实节点地址。

- [x] **Step 7: 提交**

```bash
git add qoder-vpn-proxy/server/subscription.js qoder-vpn-proxy/test
git commit -m "feat: subscription 抓取与 UA 门控格式嗅探(含脱敏 fixture)"
```

---

## 阶段 2：传输层

### Task 6: fake-mihomo 测试替身

先建测试替身，因为 Task 7 的测试要对着它跑。它同时监听 TCP 与命名管道，模拟真实约束（默认只有管道可用）。

**Files:**
- Create: `qoder-vpn-proxy/test/fake-mihomo.js`
- Test: `qoder-vpn-proxy/test/fake-mihomo.test.js`

**Interfaces:**
- Produces:
  - `startFake({ pipeName, port?, secret?, opts? }) -> Promise<Fake>`，`Fake = { pipeName, port, state, hits: [], close(): Promise<void>, setTcpEnabled(bool) }`
  - `state` 形状：`{ version, mode, tunEnabled, systemProxySuppressed, proxies: {[group]: {now, all[], history{}}}, profiles: {current, items[]} }`
  - 路由：`GET /version`、`GET /configs`、`PUT /configs`、`GET /proxies`、`GET /proxies/{name}`、`PUT /proxies/{name}`、`GET /proxies/{name}/delay?url=&timeout=`、`POST /profiles/{uid}/update`、未匹配 404、`Authorization` 不符 401。
  - 名为 `dead-node` 的节点 delay 请求返回 503（模拟超时/失败节点）。

- [x] **Step 1: 写失败的测试**

`test/fake-mihomo.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startFake } = require('./fake-mihomo');

const get = (opts) => new Promise((res, rej) => {
  const r = http.request(opts, (rr) => { let b = ''; rr.setEncoding('utf8'); rr.on('data', (c) => (b += c)); rr.on('end', () => res({ status: rr.statusCode, body: b })); });
  r.on('error', rej); r.end();
});

test('管道可通、TCP 默认关', async () => {
  const fake = await startFake({ pipeName: 'qoder-vpn-proxy-selftest-a', port: 0, secret: 's3cret' });
  const viaPipe = await get({ socketPath: fake.pipeName, path: '/version', headers: { Host: 'localhost', Authorization: 'Bearer s3cret' } });
  assert.equal(viaPipe.status, 200);
  assert.match(viaPipe.body, /meta/);
  await assert.rejects(get({ host: '127.0.0.1', port: fake.port, path: '/version' }), /ECONNREFUSED/);
  fake.setTcpEnabled(true);
  const viaTcp = await get({ host: '127.0.0.1', port: fake.port, path: '/version', headers: { Authorization: 'Bearer s3cret' } });
  assert.equal(viaTcp.status, 200);
  await fake.close();
});

test('密钥不符返回 401；切换节点写回 state', async () => {
  const fake = await startFake({ pipeName: 'qoder-vpn-proxy-selftest-b', port: 0, secret: 'right' });
  const bad = await get({ socketPath: fake.pipeName, path: '/version', headers: { Host: 'localhost', Authorization: 'Bearer wrong' } });
  assert.equal(bad.status, 401);
  // 组名是中文：Node 的 ClientRequest 拒绝未转义字符，必须 encodeURIComponent，
  // 真实 mihomo 也收编码后的路径 —— Task 9 的客户端同样要这么做。
  const putPath = '/proxies/' + encodeURIComponent('节点选择');
  await new Promise((res, rej) => {
    const r = http.request({ socketPath: fake.pipeName, path: putPath, method: 'PUT', headers: { Host: 'localhost', Authorization: 'Bearer right', 'Content-Type': 'application/json' } }, (rr) => { rr.resume(); rr.on('end', res); });
    r.on('error', rej);
    r.end(JSON.stringify({ target: 'HK 3 | v4' }));
  });
  assert.equal(fake.state.proxies['节点选择'].now, 'HK 3 | v4');
  const readBack = await get({ socketPath: fake.pipeName, path: putPath, headers: { Host: 'localhost', Authorization: 'Bearer right' } });
  assert.equal(readBack.status, 200);
  assert.match(readBack.body, /HK 3 \| v4/);
  await fake.close();
});

test('dead-node 测速返回 503', async () => {
  const fake = await startFake({ pipeName: 'qoder-vpn-proxy-selftest-c', port: 0, secret: 'x' });
  const r = await get({ socketPath: fake.pipeName, path: '/proxies/dead-node/delay?url=http%3A%2F%2Fwww.gstatic.com&timeout=5000', headers: { Host: 'localhost', Authorization: 'Bearer x' } });
  assert.equal(r.status, 503);
  await fake.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/fake-mihomo.test.js`
Expected: FAIL，`Cannot find module './fake-mihomo'`

- [x] **Step 3: 实现**

`test/fake-mihomo.js`：

```js
'use strict';
const http = require('node:http');
const net = require('node:net');

const PROXIES = {
  节点选择: { now: 'TW 2 | v4', all: ['TW 2 | v4', 'HK 3 | v4', 'JP 1 | v3', 'dead-node'], history: {} },
  漏网之鱼: { now: '节点选择', all: ['节点选择', 'DIRECT'], history: {} },
};

function makeHandlers(state) {
  return function handle(method, url, headers, body) {
    const p = decodeURIComponent(url.split('?')[0]);
    const q = new URLSearchParams(url.split('?')[1] || '');
    if (headers.authorization !== `Bearer ${state.secret}`) return { status: 401, json: { message: 'unauthorized' } };
    if (p === '/version') return { status: 200, json: { meta: { version: '1.19.0', 'meta': true } } };
    if (p === '/configs' && method === 'GET') return { status: 200, json: { mode: state.mode, 'mixed-port': state.mixedPort, tun: { enable: state.tunEnabled }, 'external-controller': state.tcpEnabled ? `127.0.0.1:${state.controllerPort}` : '' } };
    if (p === '/configs' && method === 'PUT') {
      const patch = body ? JSON.parse(body) : {};
      if (patch.mode) state.mode = patch.mode;
      if (patch.tun) state.tunEnabled = !!patch.tun.enable;
      return { status: 204 };
    }
    if (p === '/proxies') return { status: 200, json: { proxies: renderProxies(state) } };
    if (/^\/proxies\/.+\/delay$/.test(p)) {
      const name = p.split('/')[2];
      if (name === 'dead-node') return { status: 503, json: { message: `Test ${name} error: context deadline exceeded` } };
      return { status: 200, json: { delay: 120 + name.length } };
    }
    if (/^\/proxies\//.test(p)) {
      const g = decodeURIComponent(p.split('/')[2]);
      const all = renderProxies(state);
      if (method === 'GET') return all[g] ? { status: 200, json: all[g] } : { status: 404, json: { message: 'proxy not found' } };
      if (method === 'PUT') {
        if (!state.proxies[g]) return { status: 404, json: { message: 'proxy group not found' } };
        const t = JSON.parse(body).target;
        if (!state.proxies[g].all.includes(t)) return { status: 503, json: { message: 'bad target' } };
        state.proxies[g].now = t;
        return { status: 204 };
      }
    }
    if (/^\/profiles\/[^/]+\/update$/.test(p) && method === 'POST') {
      return { status: 200, json: { name: p.split('/')[2], updated: true, proxies: renderProxies(state) } };
    }
    return { status: 404, json: { message: 'not found' } };
  };
}

function renderProxies(state) {
  const out = { DIRECT: { name: 'DIRECT', type: 'Direct', now: 'DIRECT' }, REJECT: { name: 'REJECT', type: 'Reject', now: 'REJECT' } };
  for (const [g, v] of Object.entries(state.proxies)) out[g] = { name: g, type: 'Selector', now: v.now, all: v.all, history: v.history };
  for (const n of state.proxies['节点选择'].all) out[n] = { name: n, type: 'SS', udp: true };
  return out;
}

async function startFake({ pipeName, port = 0, secret = 'set-your-secret', mixedPort = 7897, tcpEnabled = false } = {}) {
  const fullPipe = `\\\\.\\pipe\\${pipeName}`;
  const state = { secret, mode: 'rule', mixedPort, tunEnabled: false, tcpEnabled, controllerPort: port, proxies: JSON.parse(JSON.stringify(PROXIES)), hits: [] };
  const handler = makeHandlers(state);

  const dispatch = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits.push(`${req.method} ${req.url}`);
      const r = handler(req.method, req.url, req.headers, body);
      if (r.status === 204) { res.writeHead(204); return res.end(); }
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  };

  const servers = [];
  // port=0 时先占位探得一个空闲端口并立即释放，保证"TCP 默认关"时连接稳定得到 ECONNREFUSED
  let chosen = port;
  if (!chosen) {
    const probe = net.createServer();
    await new Promise((res) => probe.listen(0, '127.0.0.1', res));
    chosen = probe.address().port;
    await new Promise((res) => probe.close(res));
  }
  // 命名管道同样要跑 HTTP 语义：必须是 http.Server，net.Server 拿不到 req.url/res.writeHead
  const tcpSrv = http.createServer(dispatch);
  const pipeSrv = http.createServer(dispatch);
  if (tcpEnabled) await new Promise((res) => tcpSrv.listen(chosen, '127.0.0.1', res));
  await new Promise((res, rej) => { pipeSrv.once('error', rej); pipeSrv.listen(fullPipe, res); });
  servers.push(pipeSrv);

  return {
    pipeName: fullPipe,
    port: chosen,
    state,
    hits: state.hits,
    async setTcpEnabled(v) {
      state.tcpEnabled = v;
      if (v && !tcpSrv.listening) await new Promise((res) => tcpSrv.listen(chosen, '127.0.0.1', res));
      if (!v && tcpSrv.listening) await new Promise((res) => tcpSrv.close(res));
    },
    async close() {
      for (const s of servers) await new Promise((r) => s.close(r));
      if (tcpSrv.listening) await new Promise((r) => tcpSrv.close(r));
    },
  };
}

module.exports = { startFake };
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test test/fake-mihomo.test.js`
Expected: PASS（3 个测试）。三条实测踩过的坑：

- 管道服务端必须用 `http.createServer`。写成 `net.createServer(dispatch)` 时 `dispatch` 拿到的是
  Socket，`req.url`/`res.writeHead` 都不存在，每个管道请求都抛 TypeError。
- 中文组名要 `encodeURIComponent`。`http.request({ path: '/proxies/节点选择' })` 直接抛
  `ERR_UNESCAPED_CHARACTERS`；这个错发生在测试体内、`fake.close()` 之前，泄漏的管道服务端会让
  `node --test` 一直不退出（表现为"卡死"而不是"失败"）。Task 7/9 的客户端同样要编码路径。
- 若报 `proxy group not found`，检查 `PROXIES` 的组名与断言里的 `节点选择` 是否逐字符一致（全角字符易被编辑器改错）。
  若 `ECONNREFUSED` 断言不稳定，说明 `port` 传的不是 `0` —— 必须让 fake 自己探空闲端口。

- [x] **Step 5: 跑全量测试**

Run: `node --test`
Expected: PASS，Task 3–6 的全部测试绿。注意 Node 会把 `test/` 目录下的**每个** `.js` 都当测试文件收集，
所以 `test/fake-mihomo.js` 这种纯导出的辅助文件也会占一条 `ok`（本任务后总数 = 断言测试数 + 1）。
以后核对数量时把这条算进去，不要误以为某个测试消失了。

- [x] **Step 6: 提交**

```bash
git add qoder-vpn-proxy/test/fake-mihomo.js qoder-vpn-proxy/test/fake-mihomo.test.js
git commit -m "test: fake-mihomo 桩(管道常开/TCP 可控/401/delay 503)"
```

---

### Task 7: transport.js —— 管道优先、TCP 兜底

Task 1 的结论决定 `ORDER`：本任务先按"命名管道可用"实现；若探针证明管道不能完成 HTTP 握手，则把 `ORDER` 改为 `['tcp', 'pipe']` 并同步调整本任务"管道优先"那条测试，同时在 probe 文档记录这次改动。

管道用 `http.request({socketPath})` 而非 spec §3.2 写的手写 HTTP/1.1：Node 原生处理分块传输与多包重组，Task 1 探针已验证该写法可用，比手写解析少一类 bug。这是对 spec 的一处有意偏离，理由要写进 probe 文档。

**Files:**
- Create: `qoder-vpn-proxy/server/transport.js`
- Test: `qoder-vpn-proxy/test/transport.test.js`

**Interfaces:**
- Consumes: `startFake` (Task 6)、`ApiError` (Task 3)
- Produces:
  - `DEFAULT_TIMEOUT_MS = 8000`
  - `parseTarget("127.0.0.1:9097") -> {host, port} | null`
  - `class PipeTransport { kind:"pipe"; constructor({pipeName, secret, timeoutMs}); request(method, path, {body?, headers?, timeoutMs?}) -> Promise<{status, headers, text}>; close() }`
  - `class TcpTransport { kind:"tcp"; 同上，构造参数 {host, port, secret, timeoutMs} }`
  - `createTransport(runtime, {timeoutMs?}) -> Promise<Transport>`
    按 `pipe → tcp` 顺序对 `/version` 探活，返回第一个成功的传输。`request` 对非 2xx **不抛异常**（只回 `status`），只在传输层失败时抛 `ApiError`：连接类错误（`ECONNREFUSED`/`ENOENT` 等）→ `channel_unavailable`，超时 → `timeout`，全通道 401 → `auth_failed`。

- [x] **Step 1: 写失败的测试**

`test/transport.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startFake } = require('./fake-mihomo');
const T = require('../server/transport');

const rt = (fake, over = {}) => ({
  secret: 's3cret',
  controller: { pipe: fake.pipeName, tcp: `127.0.0.1:${fake.port}` },
  ...over,
});

test('parseTarget 处理标准与异常形态', () => {
  assert.deepEqual(T.parseTarget('127.0.0.1:9097'), { host: '127.0.0.1', port: 9097 });
  assert.deepEqual(T.parseTarget('[::1]:8080'), { host: '::1', port: 8080 });
  assert.equal(T.parseTarget(''), null);
  assert.equal(T.parseTarget('127.0.0.1'), null);
  assert.equal(T.parseTarget('127.0.0.1:0'), null);
  assert.equal(T.parseTarget('127.0.0.1:70000'), null);
});

test('管道优先于 TCP', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-a', port: 0, secret: 's3cret', tcpEnabled: true });
  const tr = await T.createTransport(rt(fake));
  assert.equal(tr.kind, 'pipe');
  const res = await tr.request('GET', '/version');
  assert.equal(res.status, 200);
  assert.match(res.text, /1\.19\.0/);
  tr.close();
  await fake.close();
});

test('TCP 兜底：runtime 无管道时用 TCP', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-b', port: 0, secret: 's3cret', tcpEnabled: true });
  const tr = await T.createTransport(rt(fake, { controller: { pipe: null, tcp: `127.0.0.1:${fake.port}` } }));
  assert.equal(tr.kind, 'tcp');
  assert.equal((await tr.request('GET', '/version')).status, 200);
  tr.close();
  await fake.close();
});

test('非 2xx 不抛异常，只回状态码', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-c', port: 0, secret: 's3cret' });
  const tr = await T.createTransport(rt(fake));
  const res = await tr.request('GET', '/proxies/%E4%B8%8D%E5%AD%98%E5%9C%A8');
  assert.equal(res.status, 404);
  assert.match(res.text, /not found/);
  tr.close();
  await fake.close();
});

test('两条通道都不通 -> channel_unavailable，消息含两次尝试原因', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-d', port: 0, secret: 's3cret', tcpEnabled: true });
  // 关掉 fake 后用它刚释放的端口当"死端口"：确定是 ECONNREFUSED。
  // 不要写 fake.port + 1000 —— 临时端口接近 65535 时会被 parseTarget 判非法，
  // attempts 里就没有 TCP 那条，测试变成偶发失败。
  const deadPort = fake.port;
  await fake.close();
  await assert.rejects(
    T.createTransport(
      {
        secret: 's3cret',
        controller: { pipe: '\\\\.\\pipe\\qvp-does-not-exist', tcp: `127.0.0.1:${deadPort}` },
        channelHint: '开外部控制',
      },
      { timeoutMs: 1500 }
    ),
    (e) => e.kind === 'channel_unavailable' && /pipe/.test(e.message) && /tcp/i.test(e.message) && e.hint === '开外部控制'
  );
});

test('secret 不符 -> auth_failed 而不是 channel_unavailable', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-e', port: 0, secret: 'right' });
  await assert.rejects(T.createTransport(rt(fake, { secret: 'wrong' })), (e) => e.kind === 'auth_failed');
  await fake.close();
});

test('控制器挂起 -> timeout', async () => {
  const hang = net.createServer((sock) => { sock.on('data', () => {}); });
  await new Promise((res) => hang.listen(0, '127.0.0.1', res));
  const port = hang.address().port;
  const tr = new T.TcpTransport({ host: '127.0.0.1', port, secret: 'x', timeoutMs: 300 });
  await assert.rejects(tr.request('GET', '/version'), (e) => e.kind === 'timeout');
  tr.close();
  await new Promise((res) => hang.close(res));
});

test('PUT 带对象 body 时自动序列化并写回 state', async () => {
  const fake = await startFake({ pipeName: 'qvp-t7-f', port: 0, secret: 's3cret' });
  const tr = await T.createTransport(rt(fake));
  const res = await tr.request('PUT', '/proxies/节点选择', { body: { target: 'HK 3 | v4' } });
  assert.equal(res.status, 204);
  assert.equal(fake.state.proxies['节点选择'].now, 'HK 3 | v4');
  tr.close();
  await fake.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/transport.test.js`
Expected: FAIL，`Cannot find module '../server/transport'`

- [x] **Step 3: 实现**

`server/transport.js`：

```js
'use strict';
const http = require('node:http');
const { ApiError } = require('./envelope');

const DEFAULT_TIMEOUT_MS = 8000;
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOENT', 'EADDRNOTAVAIL', 'EPIPE', 'ECONNRESET', 'ENOTFOUND', 'EPERM', 'EACCES',
]);

function parseTarget(target) {
  if (typeof target !== 'string') return null;
  const s = target.trim();
  const i = s.lastIndexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  const host = s.slice(0, i).replace(/^\[|\]$/g, '');
  const port = Number(s.slice(i + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

// Node 的 ClientRequest 拒绝 path 里的非 ASCII（ERR_UNESCAPED_CHARACTERS），而 mihomo 的
// 组名/节点名经常就是中文。已编码的 %XX 不在替换范围内，所以对同一字符串重复调用是安全的。
function encodePath(p) {
  return String(p).replace(/[^\x21-\x7E]+/g, encodeURIComponent);
}

function authHeaders(secret, extra = {}) {
  const h = { Host: 'localhost', Accept: 'application/json', ...extra };
  if (secret) h.Authorization = `Bearer ${secret}`;
  return h;
}
  if (secret) h.Authorization = `Bearer ${secret}`;
  return h;
}

function send(connectOpts, method, path, { body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null
      ? undefined
      : typeof body === 'string' ? body : JSON.stringify(body);
    const finalHeaders = { ...connectOpts.headers, ...headers };
    if (payload !== undefined) {
      finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
      finalHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { ...connectOpts, method, path: encodePath(path), headers: finalHeaders, timeout: timeoutMs, agent: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new ApiError('timeout', `${method} ${path} 响应超过 ${timeoutMs}ms`, '控制器可能正在重启，或节点全部不可达')));
    req.on('error', (err) => {
      if (err instanceof ApiError) return reject(err);
      if (UNAVAILABLE_CODES.has(err.code)) return reject(new ApiError('channel_unavailable', `${method} ${path} 连接失败: ${err.code}`, ''));
      reject(err);
    });
    req.end(payload);
  });
}

class PipeTransport {
  constructor({ pipeName, secret = '', timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.kind = 'pipe';
    this.pipeName = pipeName;
    this.secret = secret;
    this.timeoutMs = timeoutMs;
  }
  request(method, path, opts = {}) {
    const { headers, ...rest } = opts;
    return send({ socketPath: this.pipeName, headers: authHeaders(this.secret, headers) }, method, path, {
      ...rest, timeoutMs: opts.timeoutMs || this.timeoutMs,
    });
  }
  close() {}
}

class TcpTransport {
  constructor({ host = '127.0.0.1', port, secret = '', timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.kind = 'tcp';
    this.host = host;
    this.port = port;
    this.secret = secret;
    this.timeoutMs = timeoutMs;
  }
  request(method, path, opts = {}) {
    const { headers, ...rest } = opts;
    return send({ host: this.host, port: this.port, headers: authHeaders(this.secret, headers) }, method, path, {
      ...rest, timeoutMs: opts.timeoutMs || this.timeoutMs,
    });
  }
  close() {}
}

const ORDER = ['pipe', 'tcp'];

async function createTransport(runtime, { timeoutMs = 3000 } = {}) {
  const controller = (runtime && runtime.controller) || {};
  const secret = (runtime && runtime.secret) || '';
  const attempts = [];
  let authDenied = false;

  for (const kind of ORDER) {
    let transport = null;
    let label = '';
    if (kind === 'pipe') {
      if (!controller.pipe) continue;
      label = `命名管道 ${controller.pipe}`;
      transport = new PipeTransport({ pipeName: controller.pipe, secret, timeoutMs });
    } else {
      const target = parseTarget(controller.tcp);
      if (!target) continue;
      label = `TCP ${controller.tcp}`;
      transport = new TcpTransport({ ...target, secret, timeoutMs });
    }
    try {
      const res = await transport.request('GET', '/version');
      if (res.status === 401) {
        authDenied = true;
        transport.close();
        attempts.push(`${label}: 401 密钥不符`);
        continue;
      }
      if (res.status >= 200 && res.status < 300) return transport;
      transport.close();
      attempts.push(`${label}: HTTP ${res.status}`);
    } catch (err) {
      transport.close();
      attempts.push(`${label}: ${err.kind === 'timeout' ? '握手超时' : err.message}`);
    }
  }

  if (authDenied) {
    throw new ApiError(
      'auth_failed',
      `控制通道可达但密钥不匹配（${attempts.join('；')}）`,
      '在 Clash Verge 的设置界面读取实际的外部控制密钥，或检查 config.yaml 的 secret 字段'
    );
  }
  throw new ApiError(
    'channel_unavailable',
    `mihomo 控制器不可达（${attempts.join('；') || '未发现任何通道'}）`,
    (runtime && runtime.channelHint) || '先 proxy_core_start 启动 Clash Verge；若仍不可用，需向用户确认后改调 proxy_core_start(enableExternalControl: true) 开启 enable_external_controller（会改动 verge.yaml，插件会先备份并可回滚）'
  );
}

module.exports = { DEFAULT_TIMEOUT_MS, parseTarget, PipeTransport, TcpTransport, createTransport };
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test test/transport.test.js`
Expected: PASS（8 个测试）。"TCP 兜底"那条传的是 `controller: {pipe: null, ...}`，`ORDER` 的 pipe 分支见 `!controller.pipe` 会 `continue` —— 不要改成传一个不存在的管道名，那样测的是错误分支。

最后一条 `PUT /proxies/节点选择` 传的是**未编码**的中文：`http.request` 对这种 path 直接抛
`ERR_UNESCAPED_CHARACTERS`（同步、在 Promise executor 里），所以 `send()` 必须过一层
`encodePath()`。编码放在 `send()` 这个唯一出口，Task 9 的调用方就不用各自记得转义；
而"非 2xx"那条传的是已编码路径，`encodePath` 对 `%XX` 不动，两种写法都能通。

- [x] **Step 5: 全量测试与提交**

```bash
node --test
git add qoder-vpn-proxy/server/transport.js qoder-vpn-proxy/test/transport.test.js
git commit -m "feat: transport 抽象(管道优先/TCP 兜底/auth_failed 与 channel_unavailable 分流)"
```

---

## 阶段 3：发现与客户端

### Task 8: discovery.js —— 只读发现本机现状

产出 spec §3.2 的 `Runtime`。规则：**读 `config.yaml` 得到 mihomo 侧声明，读 `verge.yaml` 得到 CVR 侧开关，两者冲突时以 `verge.yaml` 为准**（实测 `config.yaml` 写着 `external-controller: 127.0.0.1:9097`，但 `enable_external_controller: false`，9097 并未监听）。解析一律降级为 `null`，不抛异常。

**Files:**
- Create: `qoder-vpn-proxy/server/discovery.js`
- Create: `qoder-vpn-proxy/test/fixtures/cvr-config.yaml`
- Create: `qoder-vpn-proxy/test/fixtures/cvr-verge.yaml`
- Create: `qoder-vpn-proxy/test/fixtures/cvr-profiles.yaml`
- Test: `qoder-vpn-proxy/test/discovery.test.js`

**Interfaces:**
- Consumes: 无（不依赖 transport）
- Produces:
  - `CONFIG_DIR_NAME`、`FALLBACK_PIPE = '\\\\.\\pipe\\verge-mihomo'`、`DEFAULT_SECRET = 'set-your-secret'`
  - `topScalar(text, key) -> string|null`（只认列 0 的 `key:`，缩进的嵌套键不得命中；空值与裸 `null`/`~` 一律 `null`）
  - `intOf(raw) -> number|null`、`boolOf(raw) -> boolean|null`、`nestedBool(text, parent, child) -> boolean|null`
  - `parseRuntimeYaml(text) -> {ports:{mixed,socks,http}, controller:{tcp,pipe}, secret, mode, tunEnabled}`
  - `parseVergeYaml(text) -> {enableExternalController, enableSystemProxy, enableTunMode, mixedPort, socksPort, httpPort, systemProxyBypass}`（键缺失时字段为 `null`，不猜默认值）
  - `mergePorts(runtimePorts, settings) -> {mixed, socks, http}`
  - `mergeController(runtime, settings) -> {pipe, tcp, tcpConfigured, tcpEnabled}`
  - `parseProfilesYaml(text) -> {current, items:[{uid,type,name,file,url,updated}]}`
  - `resolveConfigDir(env?, fsImpl?) -> string|null`、`resolveInstallDir(env?, fsImpl?) -> string|null`
  - `isRunning(exec?) -> Promise<boolean>`
  - `probeTcp({host, port, timeoutMs}) -> Promise<boolean>`
  - `discover({env?, fsImpl?, exec?}?) -> Promise<Runtime>`
  - `Runtime = {installed, running, configDir, configSource, installDir, exePath, corePath, ports, controller, secret, settings, profiles, warnings[], channelHint}`

- [x] **Step 1: 生成 fixture**

```bash
mkdir -p qoder-vpn-proxy/test/fixtures && cd qoder-vpn-proxy/test/fixtures
CVR="$APPDATA/io.github.clash-verge-rev.clash-verge-rev"
cp "$CVR/config.yaml" cvr-config.yaml
cp "$CVR/verge.yaml" cvr-verge.yaml
cp "$CVR/profiles.yaml" cvr-profiles.yaml
sed -i -E 's/token=[0-9a-zA-Z]+/token=TOKEN_PLACEHOLDER/g; s/南山云/测试订阅/g' cvr-profiles.yaml
grep -E -o 'token=[0-9a-f]{16}' *.yaml || echo "fixture 无真实 token"
```

Expected: `fixture 无真实 token`。`verge.yaml` 若含 `remote` 类字段或自定义 UA，保留（那些不是凭据）；若出现任何含 token 的 URL，替换为 `TOKEN_PLACEHOLDER`。

- [x] **Step 2: 写失败的测试**

`test/discovery.test.js`：

```js
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
  assert.equal(p.current, 'Rq14DVii2DNo');
  assert.equal(p.items.length, 8);
  const remote = p.items.filter((i) => i.type === 'remote');
  assert.equal(remote.length, 1);
  assert.equal(remote[0].uid, 'Rq14DVii2DNo');
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
  assert.equal(rt.profiles.current, 'Rq14DVii2DNo');
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
```

- [x] **Step 3: 跑测试确认失败**

Run: `node --test test/discovery.test.js`
Expected: FAIL，`Cannot find module '../server/discovery'`

- [x] **Step 4: 实现**

`server/discovery.js`：

```js
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
const CONFIG_SOURCES = ['config.yaml', 'clash-verge.yaml', 'clash-verge-check.yaml'];

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

// intOf 是端口校验，上限 65535；时间戳等普通整数用它一律变 null
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
  const appdata = env.APPDATA || env.appdata;
  if (appdata) {
    const candidate = path.join(appdata, CONFIG_DIR_NAME);
    if (isDir(fsImpl, candidate)) return candidate;
  }
  const home = env.HOME || env.USERPROFILE || os.homedir();
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
    // configDir 为 null 时也必须留 warning，否则调用方看不出为什么什么都没读到
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
```

- [x] **Step 5: 跑测试确认失败/通过**

Run: `node --test test/discovery.test.js`
Expected: PASS（10 个测试）。

实机跑出来踩了六个坑，都已改进上面的代码，回写在此以免复刻：

1. **`nestedBool` 原来必返回 `null`**：它把缩进的子块直接喂给 `topScalar`，而 `topScalar` 只认列 0
   的键（Task 8 的第一条测试就是这么要求的）。必须按子块第一行的公共缩进顶格后再查；只剥公共
   缩进，更深层的键才不会被 `child` 误命中。
2. **`parseProfilesYaml` 丢了每项的 `uid`**：CVR 写的是 `- uid: Merge`，第一项和破折号同行，
   原来的循环遇到 `^- ` 只开新块就 `continue`，把这一行的键值对扔掉了。
3. **`updated` 用了 `intOf` 恒为 `null`**：`intOf` 是端口校验，带 `<= 65535` 上限；时间戳要用 `numOf`。
4. **裸 `null` 变成字符串 `"null"`**：真机 `verge.yaml` 第 30 行就是 `system_proxy_bypass: null`，
   原 `topScalar` 只处理空串。改成 `scalarOf` 后，未加引号的 `null` / `~` 视为无值，带引号的
   `'null'` 仍是字符串。`parseProfilesYaml` 里那句 `b.name === 'null'` 的特判因此可以删掉。
5. **测试必须与本机装没装 CVR 无关**：`C:\Program Files\Clash Verge` 在这台机器上真实存在，
   所以"未安装"的两条测试改用 `QVP_INSTALL_CANDIDATES`（`path.delimiter` 分隔）显式给定候选；
   同时 `QVP_CONFIG_DIR` 提到 `resolveConfigDir` 的第一位，覆盖 APPDATA 指向真目录时仍能定向。
6. **`configDir` 为 `null` 时原来不记 warning**：调用方只看到"什么都没读到"。补 else 分支，把
   APPDATA 的实际值写进 warning。

- [x] **Step 6: 对真机跑一遍解析（只读，不改任何文件）**

```bash
cd qoder-vpn-proxy && node -e "
const {discover}=require('./server/discovery');
discover().then(r=>console.log(JSON.stringify({installed:r.installed,running:r.running,configSource:r.configSource,ports:r.ports,controller:r.controller,settings:r.settings,current:r.profiles.current,items:r.profiles.items.length,warnings:r.warnings},null,2)))"
```

Expected: `installed:true`、`configSource:"config.yaml"`、`ports.mixed:7897`、`controller.tcp:null`、`controller.pipe:"\\\\.\\pipe\\verge-mihomo"`、`settings.enableSystemProxy:true`、`current:"Rq14DVii2DNo"`、`items:8`、`warnings:[]`。任何不符都先修解析再进下一个任务。

- [x] **Step 7: 提交**

```bash
git add qoder-vpn-proxy/server/discovery.js qoder-vpn-proxy/test/fixtures qoder-vpn-proxy/test/discovery.test.js
git commit -m "feat: discovery 只读发现(CVR 开关优先于 config.yaml 声明)"
```

---

### Task 9: clash-client.js —— mihomo REST 语义层

**Files:**
- Create: `qoder-vpn-proxy/server/clash-client.js`
- Test: `qoder-vpn-proxy/test/clash-client.test.js`
- Modify: `test/fake-mihomo.js`（见 Step 4）

**Interfaces:**
- Consumes: `createTransport` (Task 7)、`ApiError` (Task 3)、`redactText` (Task 3)
- Produces:
  - `class ClashClient`：`constructor(transport)`；`static async connect(runtime, opts) -> ClashClient`；`channelKind`；`close()`
  - `version() -> {version, revision}`
  - `getConfigs() -> {mode, mixedPort, socksPort, port, tunEnabled, externalController}`
  - `setConfigs(patch) -> {}`（PUT `/configs`，期望 204）
  - `getProxies() -> {groups:[{name,type,now,all[],history}], nodes:string[]}`（`groups` 只含 Selector/URLTest/LoadBalance/Fallback；`nodes` 是各组 `all` 的并集去重、剔除 `DIRECT`/`REJECT`/`PASS` 与组名自身）
  - `getProxy(name) -> {name,type,now,all[],udp,xudp,history}`
  - `select(group, target) -> {group, now}`（PUT 后回读确认）
  - `delay(name, {url?, timeoutMs?}) -> number`
  - `closeConnections()`、`reload({proxyProviders?}?)`、`connections() -> {total, uplink, downlink, connections[]}`
  - `DEFAULT_DELAY_URL`、`BUILT_IN`、`GROUP_TYPES`

- [x] **Step 1: 写失败的测试**

`test/clash-client.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startFake } = require('./fake-mihomo');
const { ClashClient } = require('../server/clash-client');
const { createTransport } = require('../server/transport');

let seq = 0;
async function client(over = {}) {
  const fake = await startFake({
    pipeName: `qvp-t9-${(seq += 1)}`, port: 0, secret: 's3cret',
    ...over,
  });
  const tr = await createTransport({ secret: 's3cret', controller: { pipe: fake.pipeName, tcp: null } });
  return { fake, client: new ClashClient(tr) };
}

test('version 与 getConfigs 映射字段名', async () => {
  const { fake, client: c } = await client();
  assert.match((await c.version()).version, /^1\./);
  const cfg = await c.getConfigs();
  assert.equal(cfg.mode, 'rule');
  assert.equal(cfg.mixedPort, 7897);
  assert.equal(cfg.tunEnabled, false);
  assert.equal(c.channelKind, 'pipe');
  c.close(); await fake.close();
});

test('setConfigs 发 PUT 且 fake 状态真变', async () => {
  const { fake, client: c } = await client();
  await c.setConfigs({ mode: 'global' });
  assert.equal(fake.state.mode, 'global');
  assert.ok(fake.hits.includes('PUT /configs'));
  c.close(); await fake.close();
});

test('getProxies 只暴露策略组，输出不含 server/port/password/uuid', async () => {
  const { fake, client: c } = await client();
  const { groups, nodes } = await c.getProxies();
  assert.deepEqual(groups.map((g) => g.name).sort(), ['漏网之鱼', '节点选择'].sort());
  assert.ok(nodes.includes('HK 3 | v4'));
  assert.ok(!nodes.includes('DIRECT'), '内置策略不进 nodes');
  assert.ok(!nodes.includes('节点选择'), '组名不进 nodes');
  assert.equal(new Set(nodes).size, nodes.length, 'nodes 去重');
  assert.doesNotMatch(JSON.stringify(groups), /server|"port"|password|uuid/i);
  c.close(); await fake.close();
});

test('select 切换后回读确认', async () => {
  const { fake, client: c } = await client();
  assert.deepEqual(await c.select('节点选择', 'JP 1 | v3'), { group: '节点选择', now: 'JP 1 | v3' });
  c.close(); await fake.close();
});

test('select 不存在的 target 抛 ApiError 而不是假装成功', async () => {
  const { fake, client: c } = await client();
  await assert.rejects(c.select('节点选择', '不存在的节点'), (e) => e.name === 'ApiError');
  await assert.rejects(c.select('不存在的组', 'HK 3 | v4'), (e) => e.kind === 'channel_unavailable');
  c.close(); await fake.close();
});

test('delay 正常节点回数字，dead-node 抛 timeout', async () => {
  const { fake, client: c } = await client();
  assert.equal(typeof (await c.delay('HK 3 | v4')), 'number');
  await assert.rejects(c.delay('dead-node'), (e) => e.kind === 'timeout');
  c.close(); await fake.close();
});

test('delay 把 url 与 timeout 放进 query', async () => {
  const { fake, client: c } = await client();
  await c.delay('HK 3 | v4', { url: 'https://cp.cloudflare.com/generate_204', timeoutMs: 4321 });
  assert.ok(
    fake.hits.some((h) => /delay\?url=https%3A%2F%2Fcp\.cloudflare\.com%2Fgenerate_204&timeout=4321$/.test(h)),
    fake.hits.join(' | ')
  );
  c.close(); await fake.close();
});

test('reload 记数、closeConnections 走 DELETE', async () => {
  const { fake, client: c } = await client();
  await c.reload({ proxyProviders: true });
  assert.equal(fake.state.reloadCount, 1);
  await c.closeConnections();
  assert.ok(fake.hits.includes('DELETE /connections'));
  assert.deepEqual(await c.connections(), { total: 0, uplink: 0, downlink: 0, connections: [] });
  c.close(); await fake.close();
});

test('401 在客户端层转成 auth_failed', async () => {
  const fake = await startFake({ pipeName: 'qvp-t9-secret-mismatch', port: 0, secret: 'right' });
  const { TcpTransport } = require('../server/transport');
  await fake.setTcpEnabled(true);
  const c = new ClashClient(new TcpTransport({ host: '127.0.0.1', port: fake.port, secret: 'wrong' }));
  await assert.rejects(c.getConfigs(), (e) => e.kind === 'auth_failed');
  c.close(); await fake.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/clash-client.test.js`
Expected: FAIL，`Cannot find module '../server/clash-client'`

- [x] **Step 3: 实现**

`server/clash-client.js`：

```js
'use strict';
const { ApiError } = require('./envelope');
const { redactText } = require('./redact');
const { createTransport } = require('./transport');

const DEFAULT_DELAY_URL = 'https://www.gstatic.com/generate_204';
const BUILT_IN = new Set(['DIRECT', 'REJECT', 'PASS']);
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'LoadBalance', 'Fallback']);

function qs(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}`;
}

class ClashClient {
  constructor(transport) {
    this.transport = transport;
  }

  static async connect(runtime, opts) {
    return new ClashClient(await createTransport(runtime, opts));
  }

  get channelKind() { return this.transport.kind; }

  /** 401 -> auth_failed；其余非 2xx -> 按状态分 timeout / channel_unavailable */
  async request(method, path, { body, timeoutMs, expectEmpty = false } = {}) {
    const res = await this.transport.request(method, path, { body, timeoutMs });
    if (res.status === 401) {
      throw new ApiError('auth_failed', `${method} ${path} 返回 401`, '控制器密钥不匹配，请在 Clash Verge 设置中确认外部控制的密钥');
    }
    const good = res.status >= 200 && res.status < 300;
    if (good) {
      if (expectEmpty || !res.text) return {};
      try { return JSON.parse(res.text); }
      catch { throw new ApiError('malformed_config', `${method} ${path} 返回的不是合法 JSON`, redactText(res.text.slice(0, 160))); }
    }
    const detail = redactText((res.text || '').slice(0, 200));
    throw new ApiError(
      res.status === 503 || res.status === 504 ? 'timeout' : 'channel_unavailable',
      `${method} ${path} -> HTTP ${res.status} ${detail}`,
      res.status === 404 ? '组名 / 节点名 / uid 可能拼错，先用 proxy_nodes 或 proxy_subscriptions 核对' : ''
    );
  }

  async version() {
    const j = await this.request('GET', '/version');
    return { version: j.version || (j.meta && j.meta.version) || null, revision: j.revision || null };
  }

  async getConfigs() {
    const j = await this.request('GET', '/configs');
    return {
      mode: j.mode ?? null,
      mixedPort: j['mixed-port'] ?? null,
      socksPort: j['socks-port'] ?? null,
      port: j.port ?? null,
      tunEnabled: Boolean(j.tun && j.tun.enable),
      externalController: j['external-controller'] || '',
    };
  }

  async setConfigs(patch) {
    const body = {};
    if (patch.mode !== undefined) body.mode = patch.mode;
    if (patch.tun !== undefined) body.tun = { enable: Boolean(patch.tun) };
    if (patch.port !== undefined) body.port = patch.port;
    if (patch.mixedPort !== undefined) body['mixed-port'] = patch.mixedPort;
    if (patch.proxies !== undefined) body.proxies = patch.proxies;
    if (patch['external-controller'] !== undefined) body['external-controller'] = patch['external-controller'];
    await this.request('PUT', '/configs', { body, expectEmpty: true });
    return body;
  }

  async getProxies() {
    const j = await this.request('GET', '/proxies');
    const all = j.proxies || {};
    const groups = Object.values(all)
      .filter((p) => p && GROUP_TYPES.has(p.type))
      .map((p) => ({ name: p.name, type: p.type, now: p.now ?? null, all: p.all || [], history: p.history || [] }));
    const groupNames = new Set(groups.map((g) => g.name));
    const seen = new Set();
    const nodes = [];
    for (const g of groups) {
      for (const n of g.all) {
        if (BUILT_IN.has(n) || groupNames.has(n) || seen.has(n)) continue;
        seen.add(n);
        nodes.push(n);
      }
    }
    return { groups, nodes };
  }

  async getProxy(name) {
    const j = await this.request('GET', `/proxies/${encodeURIComponent(name)}`);
    return {
      name: j.name ?? name, type: j.type ?? null, now: j.now ?? null, all: j.all || [],
      udp: Boolean(j.udp), xudp: Boolean(j.xudp), history: j.history || [],
    };
  }

  async select(group, target) {
    await this.request('PUT', `/proxies/${encodeURIComponent(group)}`, { body: { name: target }, expectEmpty: true });
    const after = await this.getProxy(group);
    if (after.now !== target) {
      throw new ApiError('channel_unavailable', `切换 ${group} -> ${target} 之后回读为 ${after.now}`, 'mihomo 可能拒绝了该目标（节点不在组内或正在重建连接）');
    }
    return { group, now: after.now };
  }

  /** 测速失败是节点问题不是通道问题，一律归 timeout，让 proxy_test 能把坏节点标出来 */
  async delay(name, { url = DEFAULT_DELAY_URL, timeoutMs = 5000 } = {}) {
    const path = `/proxies/${encodeURIComponent(name)}/delay${qs({ url, timeout: timeoutMs })}`;
    const res = await this.transport.request('GET', path, { timeoutMs: timeoutMs + 2000 });
    if (res.status === 401) throw new ApiError('auth_failed', `测速 ${name} 返回 401`, '检查 secret');
    if (res.status !== 200) {
      throw new ApiError('timeout', redactText(`测速 ${name} 失败: HTTP ${res.status} ${(res.text || '').slice(0, 120)}`), '该节点不可达或超时，可跳过它换下一个');
    }
    let j;
    try { j = JSON.parse(res.text || '{}'); } catch { throw new ApiError('timeout', `测速 ${name} 返回不可解析内容`, ''); }
    return Number(j.delay);
  }

  async closeConnections() {
    await this.request('DELETE', '/connections', { expectEmpty: true });
    return { closed: true };
  }

  async reload({ proxyProviders = false } = {}) {
    await this.request('POST', `/configs/reload${qs({ 'proxy-providers': proxyProviders ? 'true' : '' })}`, { expectEmpty: true });
    return { reloaded: true };
  }

  async connections() {
    const j = await this.request('GET', '/connections');
    const list = j.connections || [];
    return {
      total: j.total ?? list.length,
      uplink: j.uplink ?? null,
      downlink: j.downlink ?? null,
      connections: list.map((c) => ({
        id: c.id,
        host: (c.metadata && (c.metadata.host || c.metadata.destinationIP)) || '',
        chains: c.chains || [],
        upload: c.upload,
        download: c.download,
      })),
    };
  }

  close() { this.transport.close(); }
}

module.exports = { ClashClient, DEFAULT_DELAY_URL, BUILT_IN: [...BUILT_IN], GROUP_TYPES: [...GROUP_TYPES] };
```

- [x] **Step 4: 给 fake 补 reload / connections 路由并支持 `name` 写法**

mihomo 文档化的切换 body 字段是 `{"name": "..."}`（`target` 是旧别名）。把 `test/fake-mihomo.js` 的 `makeHandlers` 里 PUT `/proxies/{g}` 分支换成下面版本，并在 404 兜底之前插入三条路由：

```js
    if (/^\/proxies\//.test(p) && method === 'PUT') {
      const g = p.split('/')[2];
      const spec = body ? JSON.parse(body) : {};
      const t = spec.name || spec.target;
      if (!g || !state.proxies[g]) return { status: 404, json: { message: 'proxy group not found' } };
      if (!state.proxies[g].all.includes(t)) return { status: 503, json: { message: 'bad target' } };
      state.proxies[g].now = t;
      return { status: 204 };
    }
    if (p === '/configs/reload' && method === 'POST') { state.reloadCount += 1; return { status: 204 }; }
    if (p === '/connections' && method === 'DELETE') { state.connections = []; return { status: 204 }; }
    if (p === '/connections' && method === 'GET') {
      return { status: 200, json: { total: 0, uplink: 0, downlink: 0, connections: state.connections } };
    }
```

并把 `state` 初始化里加上 `connections: []` 与 `reloadCount: 0`。

Run: `node --test test/fake-mihomo.test.js test/clash-client.test.js`
Expected: 两个文件都 PASS（fake 3 个 + client 9 个）。Task 6 那条用 `{target}` 的旧测试仍应通过 —— 这就是同时保留 `spec.name || spec.target` 的原因。

- [x] **Step 5: 全量测试与提交**

```bash
node --test
git add qoder-vpn-proxy/server/clash-client.js qoder-vpn-proxy/test
git commit -m "feat: clash-client mihomo REST 语义层(切换后回读确认/坏节点归 timeout)"
```

---

### Task 10: cvr-config.js —— 备份、压制系统代理、启停 CVR

这是唯一会写用户 CVR 配置、唯一会启动/结束进程的一层，因此**所有可变操作都以"备份成功"为前置条件**。`backupDir` 由调用方注入（Task 12 的 `store.js` 是唯一计算数据目录的地方，本层不自己猜路径，避免两处真相）。

压制系统代理时必须连 `enable_proxy_guard` 一起置 false：proxy guard 会周期性把系统代理重新写回来，只压 `enable_system_proxy` 会在几分钟内失效。实测本机 `enable_proxy_guard: false`，但代码不能假设。

**Files:**
- Create: `qoder-vpn-proxy/server/cvr-config.js`
- Test: `qoder-vpn-proxy/test/cvr-config.test.js`

**Interfaces:**
- Consumes: `discover`/`probeTcp` (Task 8)、`createTransport` (Task 7)、`ApiError` (Task 3)
- Produces:
  - `patchScalar(text, key, value) -> {text, changed, before, after}`（纯函数；保留原行尾风格，键缺失时在末尾追加）
  - `class CvrConfig`：
    - `constructor({configDir, exePath, backupDir, spawn?, execFile?, fsImpl?, discover?, waitForChannel?})`
    - `async backup(names = ['verge.yaml', 'profiles.yaml']) -> [{name, backupPath, ts}]`（缺失的文件跳过并记 `skipped`，不报错）
    - `listBackups() -> [{name, backupPath, ts}]`
    - `async suppressSystemProxy() -> {changed: [{key, before, after}]}`（写 `enable_system_proxy: false` + `enable_proxy_guard: false`）
    - `async setExternalController(bool) -> {changed}`（**spec §3.3 明确要求它不单列为工具**，只由 `proxy_core_start(enableExternalControl: true)` 在用户二次确认后调用；除此之外任何调用方都必须先取得用户许可）
    - `async start({scope = 'session', timeoutMs = 25000, enableExternalControl = false}) -> {scope, systemProxySuppressed, externalControlEnabled, channel, ports, waitedMs}`
    - `async stop({restore = true, exitTimeoutMs = 4000, pollMs = 250}) -> {killed, restored, restoredList, stillRunning, systemProxyEnabled, warnings}`（**先等进程真退出再还原**，见下面缺陷 8；`systemProxyEnabled` 是还原后对注册表的只读复查）
    - `async runningImages(images = STOP_IMAGES) -> [镜像名]` / `async waitForExit(images, {timeoutMs, pollMs}) -> [还没退的镜像名]`（用 `tasklist /FI "IMAGENAME eq …" /NH`，按镜像名子串判活）
    - `async systemProxyEnabled() -> true|false|null`（`reg query HKCU\…\Internet Settings /v ProxyEnable`，**只读**；读不到回 `null`）
    - `async restore(names?) -> {restored: [{name, backupPath}]}`
    - `async restoreFrom(list) -> {restored}`（按显式备份记录还原，`start()` 失败回滚走这条；`restore()` 是它的薄封装）
    - `modifiedSinceBackup(names?) -> {modified: [{name, backupTs}]}`（**同步**方法；逐字节比对当前文件与最近一次备份。spec §3.5 要求 `proxy_status` 显示"当前配置是否被插件改过"，而"存在备份"在还原之后仍为真，所以不能拿 `listBackups().length` 顶替）
  - 常量 `SUPPRESS_KEYS = ['enable_system_proxy', 'enable_proxy_guard']`

- [x] **Step 1: 写失败的测试**

`test/cvr-config.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../server/cvr-config');

const VERGE = [
  '# Verge Config',
  'enable_tun_mode: false',
  'enable_auto_launch: false',
  'enable_system_proxy: true',
  'enable_proxy_guard: true',
  'system_proxy_bypass: null',
  'verge_mixed_port: 7897',
  'enable_external_controller: false',
  '',
].join('\n');

const EXE = 'clash-verge.exe';

function mkSandbox(t) {
  const dir = path.join(__dirname, `sandbox-task10-${t}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'config', 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'verge.yaml'), VERGE);
  fs.writeFileSync(path.join(dir, 'config', 'profiles.yaml'), '# Profiles\n\ncurrent: A\nitems:\n- uid: A\n  type: remote\n');
  // start() 会先确认 exe 存在再 spawn，所以沙箱必须给它一个存在的可执行文件路径
  fs.writeFileSync(path.join(dir, EXE), 'placeholder');
  return dir;
}
const exe = (dir) => path.join(dir, EXE);
const stdioOf = (o) => [].concat(o.stdio).join(',');

test('patchScalar 只改目标行，其余字节不动', () => {
  const r = C.patchScalar(VERGE, 'enable_system_proxy', false);
  assert.equal(r.changed, true);
  assert.equal(r.before, 'true');
  assert.equal(r.after, 'false');
  const a = VERGE.split('\n'), b = r.text.split('\n');
  assert.equal(a.length, b.length);
  assert.deepEqual(a.map((l, i) => (l === b[i] ? null : i)).filter(Boolean), [3], '只有第 4 行变了');
});

test('patchScalar 保留 CRLF 行尾', () => {
  const crlf = VERGE.replace(/\n/g, '\r\n');
  const r = C.patchScalar(crlf, 'enable_proxy_guard', false);
  assert.ok(r.text.includes('\r\n'), '仍是 CRLF');
  assert.ok(!r.text.includes('\n\r'), '没有产生怪异行尾');
  assert.equal(C.patchScalar(r.text, 'enable_proxy_guard', false).changed, false, '幂等');
});

test('patchScalar 键缺失时追加且不破坏已有内容', () => {
  const r = C.patchScalar('a: 1\n', 'enable_system_proxy', false);
  assert.match(r.text, /^a: 1\nenable_system_proxy: false\n$/);
  assert.equal(r.before, null);
});

test('列 0 之外的同名键不误伤（如 app_theme 与 theme 之类前缀）', () => {
  const text = 'my_enable_system_proxy: true\nenable_system_proxy: true\n';
  const r = C.patchScalar(text, 'enable_system_proxy', false);
  assert.match(r.text, /my_enable_system_proxy: true/);
  assert.match(r.text, /^enable_system_proxy: false$/m);
});

test('backup 后 suppress 再 restore：逐字节一致', async () => {
  const dir = mkSandbox('restore');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
  });
  const before = fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8');
  const profBefore = fs.readFileSync(path.join(dir, 'config', 'profiles.yaml'), 'utf8');
  const made = await cvr.backup();
  assert.deepEqual(made.map((m) => m.name).sort(), ['profiles.yaml', 'verge.yaml']);
  const { changed } = await cvr.suppressSystemProxy();
  assert.deepEqual(changed.map((c) => c.key).sort(), ['enable_proxy_guard', 'enable_system_proxy']);
  assert.notEqual(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), before);
  const restored = await cvr.restore();
  assert.equal(restored.restored.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), before, 'verge.yaml 逐字节还原');
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'profiles.yaml'), 'utf8'), profBefore);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('备份失败则不写入（spec §4：不进半改状态）', async () => {
  const dir = mkSandbox('backupfail');
  const boomFs = { ...fs, copyFileSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } };
  const cvr = new C.CvrConfig({ configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'), exePath: exe(dir), fsImpl: boomFs });
  await assert.rejects(cvr.suppressSystemProxy(), (e) => e.kind === 'config_write_failed');
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), VERGE, '原文件未被动过');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start 走 session scope：先备份再压制，等通道就绪', async () => {
  const dir = mkSandbox('start');
  const calls = [];
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
    spawn: (cmd, args, opts) => { calls.push(['spawn', cmd, opts.detached, stdioOf(opts)]); return { unref() { calls.push(['unref']); } }; },
    waitForChannel: async () => ({ kind: 'pipe', ports: { mixed: 7897 } }),
  });
  const r = await cvr.start({ scope: 'session' });
  assert.equal(r.scope, 'session');
  assert.equal(r.systemProxySuppressed, true);
  assert.equal(r.channel.kind, 'pipe');
  assert.deepEqual(calls[0], ['spawn', exe(dir), true, 'ignore']);
  assert.ok(calls.includes('unref') || calls.some((c) => c[0] === 'unref'), '分离进程必须 unref，否则插件退出会卡在子进程上');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: false$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start 走 global scope 时不碰系统代理', async () => {
  const dir = mkSandbox('global');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  const r = await cvr.start({ scope: 'global' });
  assert.equal(r.systemProxySuppressed, false);
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enableExternalControl=true 时必须在 spawn 之前改 verge.yaml', async () => {
  const dir = mkSandbox('extctl');
  const seq = [];
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
    spawn: () => { seq.push('spawn'); return { unref() {} }; },
    waitForChannel: async () => { seq.push('wait'); return { kind: 'tcp', ports: { mixed: 7897 } }; },
  });
  const r = await cvr.start({ scope: 'session', enableExternalControl: true });
  assert.equal(r.externalControlEnabled, true);
  assert.deepEqual(seq, ['spawn', 'wait'], '改配置发生在 spawn 之前，所以 seq 里只剩这两步');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_external_controller: true$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('默认不传 enableExternalControl 时绝不碰该键（未确认就不改）', async () => {
  const dir = mkSandbox('extctl-off');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  const r = await cvr.start({ scope: 'session' });
  assert.equal(r.externalControlEnabled, false);
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_external_controller: false$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scope=global + enableExternalControl 超时也要回滚（只看 suppressed 会漏这条路径）', async () => {
  const dir = mkSandbox('extctl-rollback');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => { throw new C.ApiError('channel_unavailable', '不可达'); },
  });
  await assert.rejects(cvr.start({ scope: 'global', enableExternalControl: true }));
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_external_controller: false$/m, '回滚了外部控制开关');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m, 'global 本来就没压');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start 超时未就绪 -> core_not_running，且已写入的压制项被还原', async () => {
  const dir = mkSandbox('timeout');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => { throw new C.ApiError('channel_unavailable', '不可达'); },
  });
  await assert.rejects(cvr.start({ scope: 'session' }), (e) => e.kind === 'channel_unavailable' || e.kind === 'core_not_running');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m, '回滚了压制');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exePath 不存在时立刻 not_installed，而不是白等 25 秒超时', async () => {
  const dir = mkSandbox('noexe');
  let spawned = 0;
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: path.join(dir, 'missing.exe'), fsImpl: fs,
    spawn: () => { spawned += 1; return { unref() {} }; },
    waitForChannel: async () => ({ kind: 'pipe', ports: {} }),
  });
  await assert.rejects(cvr.start({ scope: 'session' }), (e) => e.kind === 'not_installed');
  assert.equal(spawned, 0, '没确认过可执行文件就不该 spawn');
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m, 'not_installed 同样要回滚压制');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session + enableExternalControl 双双失败时，两个键都回到调用前的值', async () => {
  const dir = mkSandbox('both-rollback');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs, spawn: () => ({ unref() {} }),
    waitForChannel: async () => { throw new C.ApiError('channel_unavailable', '不可达'); },
  });
  await assert.rejects(cvr.start({ scope: 'session', enableExternalControl: true }));
  const text = fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8');
  assert.match(text, /^enable_system_proxy: true$/m, '压制已撤销');
  assert.match(text, /^enable_external_controller: false$/m, '外部控制开关也回滚');
  assert.equal(text, VERGE, '两个键都改过时，还原必须回到 start 入口时的整份内容');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('modifiedSinceBackup：改过报脏，还原后即便备份仍在也不报脏', async () => {
  const dir = mkSandbox('modified');
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
  });
  assert.deepEqual(cvr.modifiedSinceBackup().modified, [], '没备份过 -> 无从判断，报干净');
  await cvr.backup();
  assert.deepEqual(cvr.modifiedSinceBackup().modified, [], '刚备份、内容一致 -> 干净');
  await cvr.suppressSystemProxy();
  const dirty = cvr.modifiedSinceBackup().modified;
  assert.deepEqual(dirty.map((m) => m.name), ['verge.yaml'], '压制后应报 verge.yaml 被改过');
  await cvr.restore();
  assert.deepEqual(cvr.modifiedSinceBackup().modified, [], '还原后回到干净，而不是因备份存在而永远报脏');
  assert.ok(cvr.listBackups().length > 0, '备份文件没被删，只是不再算作"当前改过"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stop：taskkill 两个镜像，restore=true 时还原备份', async () => {
  const dir = mkSandbox('stop');
  const cmds = [];
  const cvr = new C.CvrConfig({
    configDir: path.join(dir, 'config'), backupDir: path.join(dir, 'backups'),
    exePath: exe(dir), fsImpl: fs,
    execFile: (cmd, args) => { cmds.push(`${cmd} ${args.join(' ')}`); return Promise.resolve({ stdout: '' }); },
  });
  await cvr.backup(['verge.yaml']);
  await cvr.suppressSystemProxy();
  const r = await cvr.stop({ restore: true });
  assert.ok(cmds.some((c) => /tasklist|taskkill/.test(c)));
  assert.equal(r.restored, true);
  assert.match(fs.readFileSync(path.join(dir, 'config', 'verge.yaml'), 'utf8'), /^enable_system_proxy: true$/m);
  const r2 = await cvr.stop({ restore: false });
  assert.equal(r2.restored, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/cvr-config.test.js`
Expected: FAIL，`Cannot find module '../server/cvr-config'`

- [x] **Step 3: 实现**

`server/cvr-config.js`：

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn: childSpawn, execFile: childExecFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ApiError } = require('./envelope');
const { discover: defaultDiscover, FALLBACK_PIPE } = require('./discovery');
const { createTransport } = require('./transport');

const execFileAsync = promisify(childExecFile);
const SUPPRESS_KEYS = ['enable_system_proxy', 'enable_proxy_guard'];
const DEFAULT_BACKUP_NAMES = ['verge.yaml', 'profiles.yaml'];
// stop() 只回滚会话级压制；profiles.yaml 属持久用户数据，还原它要用 proxy_restore_config
const SESSION_RESTORE_NAMES = ['verge.yaml'];
const STOP_IMAGES = ['clash-verge.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe'];
const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 只替换列 0 的 `key: value`。正则按 `^key:` 锚定，所以 `my_enable_system_proxy:`
 * 这类同后缀的键不会被误改。保留原行尾风格；键缺失时在末尾追加。
 */
function patchScalar(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^${escapeRe(key)}:([ \\t]*)(.*)$`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx === -1) {
    const body = text === '' || text.endsWith('\n') ? text : text + eol;
    return { text: `${body}${key}: ${value}${eol}`, changed: true, before: null, after: String(value) };
  }
  const before = re.exec(lines[idx])[2].trim();
  if (before === String(value)) return { text, changed: false, before, after: String(value) };
  lines[idx] = `${key}: ${value}`;
  return { text: lines.join(eol), changed: true, before, after: String(value) };
}

async function defaultWaitForChannel({ timeoutMs, pollMs = 700, discoverImpl = defaultDiscover } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    const runtime = await discoverImpl();
    const candidate = {
      ...runtime,
      controller: { pipe: runtime.controller.pipe || FALLBACK_PIPE, tcp: runtime.controller.tcp },
    };
    try {
      const tr = await createTransport(candidate, { timeoutMs: 1500 });
      const kind = tr.kind;
      tr.close();
      return { kind, ports: runtime.ports };
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new ApiError(
    'core_not_running',
    `Clash Verge 在 ${timeoutMs}ms 内未就绪${lastErr ? `（${lastErr.message}）` : ''}`,
    '若 GUI 已打开但控制器不通，需要在 GUI 中开启外部控制，或检查是否被安全软件拦截'
  );
}

class CvrConfig {
  constructor({
    configDir, backupDir, exePath,
    fsImpl = fs,
    spawn = childSpawn,
    execFile = execFileAsync,
    discover = defaultDiscover,
    waitForChannel,
  } = {}) {
    if (!configDir) throw new ApiError('not_installed', '未找到 Clash Verge 配置目录', '先运行 proxy_detect 确认安装位置');
    if (!backupDir) throw new ApiError('config_write_failed', '调用 cvr-config 必须提供 backupDir（由 store 层给出）', '');
    this.configDir = configDir;
    this.backupDir = backupDir;
    this.exePath = exePath;
    this.fs = fsImpl;
    this.spawn = spawn;
    this.execFile = execFile;
    this.backupSeq = 0;
    this.waitForChannel = waitForChannel
      || ((opts) => defaultWaitForChannel({ ...opts, discoverImpl: discover }));
  }

  file(name) { return path.join(this.configDir, name); }

  stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  }

  async backup(names = DEFAULT_BACKUP_NAMES) {
    // 毫秒不够：start() 里 patchVerge 会再次 backup，同毫秒会写到同一个文件名，
    // 把入口备份覆盖成中途状态，回滚就等于没回滚。序号补在时间戳末尾。
    const ts = `${this.stamp()}-${String(this.backupSeq += 1).padStart(3, '0')}`;
    try { this.fs.mkdirSync(this.backupDir, { recursive: true }); }
    catch (e) { throw new ApiError('config_write_failed', `无法创建备份目录 ${this.backupDir}: ${e.code || e.message}`, '磁盘或权限问题，插件不会在未备份的情况下改动配置'); }

    const made = [];
    for (const name of names) {
      const src = this.file(name);
      if (!this.fs.existsSync(src)) { made.push({ name, skipped: true, ts }); continue; }
      const dest = path.join(this.backupDir, `${name}.${ts}.bak`);
      try {
        this.fs.copyFileSync(src, dest);
        if (!this.fs.existsSync(dest) || this.fs.readFileSync(dest, 'utf8') !== this.fs.readFileSync(src, 'utf8')) {
          throw new ApiError('config_write_failed', `备份 ${name} 落盘后校验不一致`, '中止写入，配置未发生改动');
        }
        made.push({ name, backupPath: dest, ts, skipped: false });
      } catch (e) {
        throw e instanceof ApiError ? e : new ApiError('config_write_failed', `备份 ${name} 失败: ${e.code || e.message}`, '中止写入，配置未发生改动');
      }
    }
    return made;
  }

  listBackups() {
    if (!this.fs.existsSync(this.backupDir)) return [];
    return this.fs.readdirSync(this.backupDir)
      // readdirSync 给的是裸文件名，所以这里必须从行首匹配 `verge.yaml.<ts>.bak`
      .filter((f) => /^(?:verge|profiles|config)\.yaml\.[\d-]+\.bak$/.test(f))
      .map((f) => {
        const m = /^(.*)\.([\d-]+)\.bak$/.exec(f);
        return { name: m[1], ts: m[2], backupPath: path.join(this.backupDir, f) };
      })
      .sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  latestBackupFor(name) {
    return this.listBackups().find((b) => b.name === name) || null;
  }

  writeText(name, text, backups) {
    try {
      this.fs.writeFileSync(this.file(name), text, 'utf8');
      return true;
    } catch (e) {
      // 写入失败时尽力回滚到刚做的备份，绝不留下半改状态
      for (const b of backups) {
        if (b.name !== name || b.skipped) continue;
        try { this.fs.copyFileSync(b.backupPath, this.file(name)); } catch { /* 回滚失败只能原样抛出 */ }
      }
      throw new ApiError('config_write_failed', `写入 ${name} 失败: ${e.code || e.message}`, '已尝试回滚到本次备份，请核对 proxy_restore_config 列出的备份时间');
    }
  }

  async patchVerge(patches) {
    const name = 'verge.yaml';
    const src = this.file(name);
    if (!this.fs.existsSync(src)) throw new ApiError('not_installed', `${src} 不存在`, '配置目录不完整');
    const backups = await this.backup([name]);
    let text = this.fs.readFileSync(src, 'utf8');
    const changed = [];
    for (const [key, value] of Object.entries(patches)) {
      const r = patchScalar(text, key, value);
      if (r.changed) changed.push({ key, before: r.before, after: r.after });
      text = r.text;
    }
    if (changed.length) this.writeText(name, text, backups);
    return { changed, backups };
  }

  async suppressSystemProxy() {
    const { changed } = await this.patchVerge(Object.fromEntries(SUPPRESS_KEYS.map((k) => [k, false])));
    return { changed };
  }

  async setExternalController(enabled) {
    const { changed } = await this.patchVerge({ enable_external_controller: Boolean(enabled) });
    return { changed };
  }

  async start({ scope = 'session', timeoutMs = 25000, enableExternalControl = false } = {}) {
    if (scope !== 'session' && scope !== 'global') {
      throw new ApiError('config_write_failed', `未知 scope: ${scope}`, '只支持 "session" 或 "global"');
    }
    // 先确认再动手：exe 不存在时如果等到 waitForChannel 超时才报，用户要白等 25 秒
    if (!this.exePath || !this.fs.existsSync(this.exePath)) {
      throw new ApiError('not_installed', `找不到可执行文件 ${this.exePath}`, '用 proxy_detect 确认安装目录，或设置 QVP_INSTALL_DIR');
    }
    const backups = await this.backup(DEFAULT_BACKUP_NAMES);
    let suppressed = false;
    let externalControl = false;
    try {
      if (scope === 'session') {
        await this.suppressSystemProxy();
        suppressed = true;
      }
      // 必须在 spawn 之前改：CVR 只在启动时读 verge.yaml，进程起来之后再改就无效了
      if (enableExternalControl) {
        const r = await this.setExternalController(true);
        externalControl = r.changed.length > 0;
      }
      const child = this.spawn(this.exePath, [], { detached: true, stdio: 'ignore', windowsHide: true });
      if (child && typeof child.unref === 'function') child.unref();

      const waited = Date.now();
      const channel = await this.waitForChannel({ timeoutMs });
      return {
        scope,
        systemProxySuppressed: suppressed,
        externalControlEnabled: externalControl,
        channel,
        ports: channel.ports,
        waitedMs: Date.now() - waited,
        backups,
      };
    } catch (err) {
      // 启动失败必须还原：用户看到 core_not_running 时机器状态应与调用前一致。
      // 条件是"动过任何一个键"，只看 suppressed 会漏掉 scope=global + enableExternalControl 这条路径。
      // 还原用入口那一批备份，不用"最近一次备份"：中途每次 patchVerge 都又备了一份，
      // 最近那份已经带着压制后的值，拿它还原等于没还原（session + enableExternalControl 组合下尤其明显）。
      if (suppressed || externalControl) await this.restoreFrom(backups).catch(() => {});
      throw err.kind === 'channel_unavailable' ? new ApiError('core_not_running', err.message, 'CVR 已启动但控制器不可达；可能需要在 GUI 开启外部控制') : err;
    }
  }

  async taskkill(image) {
    try { await this.execFile('taskkill', ['/IM', image, '/F'], { windowsHide: true, timeout: 8000, maxBuffer: 1 << 20 }); return true; }
    catch { return false; }
  }

  /**
   * tasklist 的"没有匹配任务"提示是本地语言 + 本地码页（这台机器是 GBK），会读成乱码；
   * 而表头行一定含镜像名本身，所以只按镜像名子串判活，天然绕开码页问题。
   */
  async runningImages(images = STOP_IMAGES) {
    const alive = [];
    for (const image of images) {
      try {
        const { stdout } = await this.execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 1 << 20 });
        if (String(stdout || '').includes(image)) alive.push(image);
      } catch { /* 探测失败当作没在跑：stop 不能被自己的检查卡住 */ }
    }
    return alive;
  }

  async waitForExit(images = STOP_IMAGES, { timeoutMs = 4000, pollMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let pending = await this.runningImages(images);
    while (pending.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      pending = await this.runningImages(pending);
    }
    return pending;
  }

  /** 只读复查系统代理开关。插件按设计绝不写注册表，读不到就返回 null。 */
  async systemProxyEnabled() {
    try {
      const { stdout } = await this.execFile('reg', ['query', INTERNET_SETTINGS_KEY, '/v', 'ProxyEnable'], { windowsHide: true, timeout: 5000, maxBuffer: 1 << 20 });
      const m = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout || ''));
      return m ? Number.parseInt(m[1], 16) !== 0 : null;
    } catch { return null; }
  }

  async stop({ restore = true, exitTimeoutMs = 4000, pollMs = 250 } = {}) {
    const killed = [];
    for (const image of STOP_IMAGES) {
      if (await this.taskkill(image)) killed.push(image);
    }
    // 必须等进程真的没了再还原：verge.yaml 里 enable_system_proxy 本来就是 true，
    // CVR 还在拆除时读到还原后的配置会把系统代理重新打开，而核心已经停了 ——
    // 浏览器于是全部"连接被拒绝"。真机上就是这么踩到的（缺陷 8）。
    const stillRunning = await this.waitForExit(STOP_IMAGES, { timeoutMs: exitTimeoutMs, pollMs });
    const warnings = [];
    if (stillRunning.length) {
      warnings.push(`taskkill 后等了 ${exitTimeoutMs}ms，${stillRunning.join(', ')} 仍在运行：配置可能被 CVR 再次回写，稍后用 proxy_status 复查`);
    }
    if (!restore) return { killed, restored: false, stillRunning, warnings };
    // 只回滚会话级改动（系统代理压制 / 外部控制开关）。profiles.yaml 里的订阅切换与增删
    // 是用户主动的持久意图，撤销它得靠 proxy_restore_config，不能藏在 stop 的副作用里。
    const r = await this.restore(SESSION_RESTORE_NAMES);
    const systemProxyEnabled = await this.systemProxyEnabled();
    if (systemProxyEnabled === true) {
      warnings.push(
        '核心已停止但系统代理仍开启（ProxyEnable=1），浏览器会出现"连接被拒绝"。'
        + `插件按设计不写注册表，需要时请自行执行：reg add "${INTERNET_SETTINGS_KEY}" /v ProxyEnable /t REG_DWORD /d 0 /f`
      );
    }
    return { killed, restored: r.restored.length > 0, restoredList: r.restored, stillRunning, systemProxyEnabled, warnings };
  }

  async restoreFrom(list) {
    const restored = [];
    for (const b of list || []) {
      if (!b || b.skipped || !b.backupPath) continue;
      try { this.fs.copyFileSync(b.backupPath, this.file(b.name)); restored.push({ name: b.name, backupPath: b.backupPath, ts: b.ts }); }
      catch (e) { throw new ApiError('config_write_failed', `还原 ${b.name} 失败: ${e.code || e.message}`, `备份文件 ${b.backupPath} 可能被占用`); }
    }
    return { restored };
  }

  async restore(names = DEFAULT_BACKUP_NAMES) {
    return this.restoreFrom(names.map((name) => this.latestBackupFor(name)).filter(Boolean));
  }

  modifiedSinceBackup(names = DEFAULT_BACKUP_NAMES) {
    const modified = [];
    for (const name of names) {
      const b = this.latestBackupFor(name);
      if (!b) continue;
      let cur, old;
      try { cur = this.fs.existsSync(this.file(name)) ? this.fs.readFileSync(this.file(name), 'utf8') : null; } catch { cur = null; }
      try { old = this.fs.readFileSync(b.backupPath, 'utf8'); } catch { continue; }
      // 只在"当前内容 != 备份内容"时报告改过：还原之后备份仍在，但已不该报脏
      if (cur !== null && cur !== old) modified.push({ name, backupTs: b.ts });
    }
    return { modified };
  }
}

module.exports = { CvrConfig, patchScalar, SUPPRESS_KEYS, DEFAULT_BACKUP_NAMES, SESSION_RESTORE_NAMES, STOP_IMAGES, ApiError, defaultWaitForChannel };

```

- [x] **Step 4: 对齐点与实做时踩到的坑**

`module.exports` 里导出 `ApiError` 只是为了测试构造 `channel_unavailable`；测试文件的 `new C.ApiError(...)` 因此可用。若 `waitForChannel` 抛的是 `ApiError`，`start()` 会把它转成 `core_not_running` —— 测试断言允许两者之一，保持这个宽松度（真实语义是"CVR 起来了但连不上"，两种分类都算可接受，hint 已写清）。

计划原稿在这一层有五个会导致"回滚其实没发生"的缺陷，都改了，逐条记下：

1. **构造参数名与测试/接口对不上**：原实现写的是 `spawnImpl / execFileImpl / discoverImpl`，而本任务
   的测试和上面的 Interfaces 用的都是 `spawn / execFile / discover`。照原稿写下去，注入不会生效，
   `start` / `stop` 那几条测试会去调**真的 `child_process.spawn`**（在这台机器上就是去启动 Clash Verge）。
   现在按测试/接口命名为准。
2. **`listBackups` 的过滤正则多了一个前导点**：备份文件名是 `verge.yaml.<ts>.bak`，`readdirSync` 给的
   是裸文件名，`\.(?:verge|...)` 永远匹配不上，于是 `listBackups()` 恒为空 —— `restore()` 什么都不还原、
   `modifiedSinceBackup()` 永远报干净、`start()` 失败后的自动回滚静默失败。这一条最危险，因为对外
   承诺的"失败自动还原"会变成假的。改成 `^(?:verge|profiles|config)\.yaml\.[\d-]+\.bak$`。
3. **备份时间戳只到毫秒，同一次 `start()` 会自己覆盖自己**：`start()` 先 backup，`patchVerge()` 每次写入
   前又 backup；同一毫秒内三次调用算出同一个 `ts`，写进同一个文件名。第二次写下去的内容是"压制后"
   的，入口那份 pristine 备份就没了。备份名末尾加实例序号（`-001` 补零，保证字符串排序仍等于时间序）。
4. **回滚要还原到"进入 `start()` 之前"，不是"最近一次备份"**：session + `enableExternalControl` 同时改两个
   键时，最近一次备份带着压制后的值，拿它还原等于只回滚了一半。新增 `restoreFrom(list)` 按显式备份
   路径还原，`start()` 的 catch 用它回滚 `backups`（入口那一批）；`restore(names)` 改为 `restoreFrom` 的
   薄封装，别再让两条路径各自实现一遍拷贝。
5. **`exePath` 存在性检查必须放在任何写入之前**：原稿在改完 verge.yaml、spawn 之前才检查，于是
   "没装 CVR"要先把用户配置改脏再抛 `not_installed`。提到 `start()` 第一行，测试里也断言了
   "not_installed 时文件未动、spawn 未被调用"。副作用：沙箱必须真的存在那个 exe 占位文件
   （`mkSandbox` 里写 `clash-verge.exe`），否则 `start` 系列测试全部在检查处就退出。

另有三处小的对不齐：

- `suppressSystemProxy()` 的返回值是 `{ changed }`（Interfaces 就这么写的），原测试直接
  `changed.map(...)` 会 `TypeError`；改成解构。
- 测试桩里 `opts.stdio.join(',')`：实现用的是 `stdio: 'ignore'`（字符串没有 `.join`）。桩里改用
  `[].concat(opts.stdio).join(',')`，两种写法都吃得下。
- 原测试有一行 `fs.chmodSync(configDir, 0o444)`：Windows 上它对"让 copyFile 失败"没有可靠作用，
  真正制造失败的是注入的 `boomFs`，删掉以免留下一个看似有效其实无效的守卫。

`patchScalar` 的"键缺失则追加"分支原来用一个 `.filter()` 去掉重复空行，条件恒不成立；换成按
`text.endsWith('\n')` 决定是否需要补行尾，行为一致但读得下去。

Run: `node --test test/cvr-config.test.js`
Expected: PASS（16 个测试）。

- [x] **Step 5: 全量测试与提交**

```bash
node --test
git add qoder-vpn-proxy/server/cvr-config.js qoder-vpn-proxy/test/cvr-config.test.js
git commit -m "feat: cvr-config 备份/压制系统代理/启停 CVR(失败即回滚，不留半改)"
```

---

### Task 11: profilesYaml.js —— profiles.yaml 的外科式编辑

**为什么不用 YAML 库**：全量 parse+stringify 会丢掉 CVR 自己的格式习惯（`name: null` 的裸 null、`selected:` 的紧凑列表、字段顺序），而这些文件是 CVR 拥有的，插件必须只动该动的那几个字节。**round-trip 恒等是这一层的验收定义**，测试里必须断言。

**Files:**
- Create: `qoder-vpn-proxy/server/profilesYaml.js`
- Test: `qoder-vpn-proxy/test/profilesYaml.test.js`

**Interfaces:**
- Consumes: `ApiError` (Task 3)、fixture `test/fixtures/cvr-profiles.yaml` (Task 8)
- Produces:
  - `parse(text) -> {headLines, blocks:[{uid, lines}], tailLines, eol, hasItems, finalNewline}`（`finalNewline` 是"文件以换行结尾"的标记，内容行里不留尾随空行）
  - `render(model) -> string`
  - `readField(lines, key) -> string|null`、`readNested(lines, parent, key) -> string|null`（`null` 与裸空串都读成 `null`）
  - `getItem(text, uid) -> {uid, type, name, file, url, updated, selected?}|null`
  - `listItems(text) -> [{uid, type, name, file, url, updated, extra, option}]`
  - `setCurrent(text, uid) -> string`
  - `setField(text, uid, key, value) -> string`（key ∈ 单层标量字段；缺失则在块尾追加）
  - `setNested(text, uid, parent, key, value) -> string`（父键缺失时创建）
  - `setSelected(text, uid, {name, now}) -> string`
  - `appendItem(text, item) -> string`（`item = {uid, type, name, file, url, extra?, option?, selected?, updated}`）
  - `removeItem(text, uid) -> string`
  - `yamlScalar(value) -> string`（`null -> null`；需要时加双引号）
  - 全部改不动的 uid 一律抛 `ApiError('subscription_not_found')`；uid 重复抛 `ApiError('malformed_config')`

- [x] **Step 1: 写失败的测试**

`test/profilesYaml.test.js`：

```js
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
  const remote = items.find((i) => i.uid === 'Rq14DVii2DNo');
  assert.equal(remote.type, 'remote');
  assert.equal(remote.name, '测试订阅');
  assert.equal(remote.file, 'Rq14DVii2DNo.yaml');
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
  let out = P.setField(RAW, 'Rq14DVii2DNo', 'url', 'https://example.test/new?token=T2');
  out = P.setField(out, 'Rq14DVii2DNo', 'name', '新机场');
  assert.equal(P.getItem(out, 'Rq14DVii2DNo').url, 'https://example.test/new?token=T2');
  assert.equal(P.getItem(out, 'Rq14DVii2DNo').name, '新机场');
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
  let out = P.setNested(RAW, 'Rq14DVii2DNo', 'extra', 'download', '999');
  out = P.setNested(out, 'Rq14DVii2DNo', 'option', 'allow_auto_update', 'false');
  assert.equal(P.listItems(out).find((i) => i.uid === 'Rq14DVii2DNo').extra.download, '999');
  assert.equal(P.listItems(out).find((i) => i.uid === 'Rq14DVii2DNo').option.allow_auto_update, 'false');
  assert.equal(P.render(P.parse(out)), out);
});

test('setNested 父键缺失时创建', () => {
  const out = P.setNested(RAW, 'Merge', 'extra', 'total', '0');
  assert.match(out, /^  extra:\n    total: 0$/m);
  assert.equal(P.listItems(out).find((i) => i.uid === 'Merge').extra.total, '0');
});

test('setSelected 整体替换 selected 列表', () => {
  const out = P.setSelected(RAW, 'Rq14DVii2DNo', { name: '测试订阅', now: 'HK 3 | v4' });
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
  const out = P.removeItem(RAW, 'Rq14DVii2DNo');
  const items = P.listItems(out);
  assert.equal(items.length, 7);
  assert.ok(!items.some((i) => i.uid === 'Rq14DVii2DNo'));
  assert.equal(items.find((i) => i.uid === 'ga95A5AxsmDZ').type, 'groups', '最后一块的其他项完好');
  assert.ok(out.endsWith('\n'), '删掉末块也要保留文件末尾换行，CVR 自己的写法就是这样');
  assert.throws(() => P.removeItem(RAW, 'NOPE'), (e) => e.kind === 'subscription_not_found');
});

test('uid 重复时报 malformed_config 而不是静默改第一个', () => {
  const dup = RAW.replace('uid: ga95A5AxsmDZ', 'uid: Rq14DVii2DNo');
  assert.throws(() => P.setField(dup, 'Rq14DVii2DNo', 'name', 'X'), (e) => e.kind === 'malformed_config');
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
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/profilesYaml.test.js`
Expected: FAIL，`Cannot find module '../server/profilesYaml'`

- [x] **Step 3: 实现**

`server/profilesYaml.js`：

```js
'use strict';
const { ApiError } = require('./envelope');

/**
 * profiles.yaml 归 CVR 所有，插件只动该动的字节，所以这里不用 YAML 库做全量
 * parse+stringify（那会丢掉 CVR 的格式习惯）。唯一的不变量是 render(parse(x)) === x。
 */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** CVR 把每项的第一个字段写在破折号同一行，其余字段缩进两空格 */
function fieldRe(key) {
  return new RegExp(`^(?:  |- )${esc(key)}:[ \\t]*(.*)$`);
}

function needsQuote(s) {
  if (s === '') return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true; // 行首指示符
  if (/:(\s|$)/.test(s)) return true; // 冒号后跟空格才是键值分隔，URL 里的 :// 不算
  if (/\s#/.test(s)) return true;
  if (/["\\\t]/.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  // 纯数字/true/false 一律裸写：readNested 交回来的是字符串，读改写时给它们加引号
  // 会让 CVR 在 u64/bool 字段上反序列化失败，而 CVR 自己写的就是裸值。
  return false;
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (!needsQuote(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function stripQuotes(v) {
  const t = String(v).trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  return t;
}

function readValue(raw) {
  if (raw === null || raw === undefined) return null;
  const v = stripQuotes(raw);
  return v === 'null' || v === '' ? null : v;
}

function parse(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // 文件末尾的换行在 split 后表现为最后一个空串元素。把它单独记成 finalNewline，
  // 块内就只剩内容行，不必再猜"这个空行属于哪个块"。
  const finalNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop();

  const start = lines.findIndex((l) => /^items:[ \t]*$/.test(l));
  if (start === -1) {
    return { headLines: lines, blocks: [], tailLines: [], eol, hasItems: false, finalNewline };
  }

  const headLines = lines.slice(0, start + 1);
  const blocks = [];
  const tailLines = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^- \S/.test(line)) { cur = { lines: [line] }; blocks.push(cur); continue; }
    if (cur && (line === '' || /^[ \t]+\S/.test(line))) { cur.lines.push(line); continue; }
    cur = null;
    tailLines.push(line);
  }
  return {
    headLines,
    blocks: blocks.map((b) => {
      const m = fieldRe('uid').exec(b.lines[0]);
      return { uid: m ? stripQuotes(m[1]) : null, lines: b.lines };
    }),
    tailLines,
    eol,
    hasItems: true,
    finalNewline,
  };
}

function render(model) {
  const lines = [...model.headLines];
  if (model.hasItems) {
    for (const b of model.blocks) lines.push(...b.lines);
    lines.push(...model.tailLines);
  } else {
    lines.push(...model.tailLines);
  }
  return lines.join(model.eol) + (model.finalNewline === false ? '' : model.eol);
}

function findBlock(model, uid, { required = true } = {}) {
  const hits = model.blocks.filter((b) => b.uid === uid);
  if (hits.length > 1) {
    throw new ApiError('malformed_config', `profiles.yaml 中 uid ${uid} 出现 ${hits.length} 次`, 'CVR 注册表异常，需手工确认后重试');
  }
  if (!hits.length) {
    if (required) throw new ApiError('subscription_not_found', `profiles.yaml 中没有 uid ${uid}`, '用 proxy_subscriptions 查看现有订阅');
    return null;
  }
  return hits[0];
}

function readField(lines, key) {
  const re = fieldRe(key);
  const hit = lines.find((l) => re.test(l));
  return hit === undefined ? null : readValue(re.exec(hit)[1]);
}

function readNested(lines, parent, key) {
  const pIdx = lines.findIndex((l) => new RegExp(`^  ${esc(parent)}:[ \\t]*$`).test(l));
  if (pIdx === -1) return null;
  const { end } = childRange(lines, pIdx);
  const re = new RegExp(`^    ${esc(key)}:[ \\t]*(.*)$`);
  for (let i = pIdx + 1; i < end; i += 1) {
    if (re.test(lines[i])) return readValue(re.exec(lines[i])[1]);
  }
  return null;
}

/** 父键行 [start, end) 覆盖的子行区间；缩进 4 空格或 2 空格短横线的行属于它 */
function childRange(lines, start) {
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l === '' || /^[ \t]{4,}\S/.test(l) || /^  - \S/.test(l)) { end += 1; continue; }
    break;
  }
  while (end - 1 > start && lines[end - 1] === '') end -= 1;
  return { start, end };
}

function itemOf(lines) {
  return {
    uid: readField(lines, 'uid'),
    type: readField(lines, 'type'),
    name: readField(lines, 'name'),
    file: readField(lines, 'file'),
    url: readField(lines, 'url'),
    updated: readField(lines, 'updated'),
    selected: (() => {
      const name = readSelectedName(lines);
      return name === null ? undefined : { name, now: readField(lines, 'now') };
    })(),
    extra: ['upload', 'download', 'total', 'expire'].reduce((a, k) => ({ ...a, [k]: readNested(lines, 'extra', k) }), {}),
    option: ['update_interval', 'allow_auto_update', 'merge', 'script', 'rules', 'proxies', 'groups']
      .reduce((a, k) => ({ ...a, [k]: readNested(lines, 'option', k) }), {}),
  };
}

function readSelectedName(lines) {
  const pIdx = lines.findIndex((l) => /^  selected:[ \t]*$/.test(l));
  if (pIdx === -1) return null;
  const { end } = childRange(lines, pIdx);
  const re = /^  - name:[ \t]*(.*)$/;
  for (let i = pIdx + 1; i < end; i += 1) if (re.test(lines[i])) return readValue(re.exec(lines[i])[1]);
  return null;
}

function setCurrent(text, uid) {
  const model = parse(text);
  findBlock(model, uid);
  return render({
    ...model,
    headLines: model.headLines.map((l) => (/^current:[ \t]*(.*)$/.test(l) ? `current: ${uid}` : l)),
  });
}

function setField(text, uid, key, value) {
  const model = parse(text);
  const block = findBlock(model, uid);
  const re = fieldRe(key);
  const next = [...block.lines];
  const idx = next.findIndex((l) => re.test(l));
  const dashForm = `- ${key}: ${yamlScalar(value)}`;
  const line = `  ${key}: ${yamlScalar(value)}`;
  if (idx === -1) next.push(key === 'uid' ? dashForm : line);
  else next[idx] = next[idx].startsWith('- ') ? dashForm : line;
  return replaceBlock(model, block, next);
}

function setNested(text, uid, parent, key, value) {
  const model = parse(text);
  const block = findBlock(model, uid);
  const lines = [...block.lines];
  const pIdx = lines.findIndex((l) => new RegExp(`^  ${esc(parent)}:[ \\t]*$`).test(l));
  const childLine = `    ${key}: ${yamlScalar(value)}`;
  if (pIdx === -1) {
    lines.push(`  ${parent}:`, childLine);
  } else {
    const { end } = childRange(lines, pIdx);
    const re = new RegExp(`^    ${esc(key)}:[ \\t]*(.*)$`);
    const hit = lines.findIndex((l, i) => i > pIdx && i < end && re.test(l));
    if (hit === -1) lines.splice(end, 0, childLine);
    else lines[hit] = childLine;
  }
  return replaceBlock(model, block, lines);
}

function setSelected(text, uid, { name, now }) {
  const model = parse(text);
  const block = findBlock(model, uid);
  const lines = [...block.lines];
  const replacement = ['  selected:', `  - name: ${yamlScalar(name)}`, `    now: ${yamlScalar(now)}`];
  const pIdx = lines.findIndex((l) => /^  selected:[ \t]*$/.test(l));
  if (pIdx === -1) lines.push(...replacement);
  else {
    const { end } = childRange(lines, pIdx);
    lines.splice(pIdx, end - pIdx, ...replacement);
  }
  return replaceBlock(model, block, lines);
}

function itemToLines(item) {
  const lines = [
    `- uid: ${yamlScalar(item.uid)}`,
    `  type: ${yamlScalar(item.type || 'remote')}`,
    `  name: ${yamlScalar(item.name ?? null)}`,
    `  file: ${yamlScalar(item.file)}`,
  ];
  if (item.url !== undefined && item.url !== null) lines.push(`  url: ${yamlScalar(item.url)}`);
  if (item.selected) {
    lines.push('  selected:', `  - name: ${yamlScalar(item.selected.name)}`, `    now: ${yamlScalar(item.selected.now)}`);
  }
  if (item.extra) {
    lines.push('  extra:');
    for (const [k, v] of Object.entries(item.extra)) lines.push(`    ${k}: ${yamlScalar(v)}`);
  }
  lines.push(`  updated: ${yamlScalar(item.updated)}`);
  if (item.option) {
    lines.push('  option:');
    for (const [k, v] of Object.entries(item.option)) lines.push(`    ${k}: ${yamlScalar(v)}`);
  }
  return lines;
}

function appendItem(text, item) {
  const model = parse(text);
  if (!model.hasItems) {
    throw new ApiError('malformed_config', 'profiles.yaml 中没有 items: 段，无法追加', '该文件形态异常，先用 proxy_restore_config 还原备份');
  }
  if (findBlock(model, item.uid, { required: false })) {
    throw new ApiError('malformed_config', `uid ${item.uid} 已存在`, '重新生成 uid 后再试');
  }
  const blocks = [...model.blocks.map((b) => ({ ...b })), { uid: item.uid, lines: itemToLines(item) }];
  return render({ ...model, blocks });
}

function removeItem(text, uid) {
  const model = parse(text);
  const block = findBlock(model, uid);
  const blocks = model.blocks.filter((b) => b !== block).map((b) => ({ ...b }));
  return render({ ...model, blocks });
}

function getItem(text, uid) {
  const model = parse(text);
  const block = findBlock(model, uid, { required: false });
  return block ? itemOf(block.lines) : null;
}

function listItems(text) {
  return parse(text).blocks.map((b) => itemOf(b.lines));
}

function replaceBlock(model, block, lines) {
  return render({ ...model, blocks: model.blocks.map((b) => (b === block ? { ...b, lines } : b)) });
}

module.exports = {
  parse, render, readField, readNested, yamlScalar, setCurrent, setField, setNested,
  setSelected, appendItem, removeItem, getItem, listItems, itemToLines,
};
```

- [x] **Step 4: 用"round-trip 恒等"驱动实现收敛（这一步不是可选的）**

空行归属是这一层最容易出错的地方。最终模型只有一条不变量：**`render(parse(x)) === x`**。为此实现把"文件以换行结尾"从内容里剥出来单独记账，而不是让空行在块之间找主人 ——

> `parse` 先 `pop()` 掉 `split(/\r?\n/)` 产生的末空串元素，存成 `model.finalNewline`；`render` 末尾再补回 `eol`。块内因此只剩内容行。块与块之间不插空行：真实 fixture 的 8 项就是紧挨着写的，追加项也必须紧挨着。

Step 3 的代码即最终形态（早期草稿里 `appendItem`/`removeItem` 各带一段"裁剪尾随空行"的循环，已随该模型删除）。落地时踩到、并被测试钉住的规则：

1. **`finalNewline` 标记**：删掉末块时若不记这个标记，输出会丢掉文件末行的换行；CVR 下次整文件写盘就会出现无谓的大 diff。`removeItem` 测试里的 `assert.ok(out.endsWith('\n'))` 钉的是这一点。
2. **字段有两种书写形态**：CVR 把每项的第一个键写在短横线上（`- uid: Merge`），其余键缩进两空格。`fieldRe(key)` 只认 `^  key:` 与 `^- key:` 两种，因此 `readField(lines, 'name')` 不会误命中 `selected:` 子项的 `  - name: 测试订阅`；写入时按原形态（短横线/两空格）回填。
3. **裸值优先**：`yamlScalar` 不给纯数字串与 `true`/`false` 加引号。`readNested` 交回的是字符串，读改写若写成 `updated: "1"`、`allow_auto_update: "true"`，CVR 的 serde 在 u64/bool 字段上会反序列化失败；需要写数字的调用方直接传 number。
4. **只有行首指示符才算指示符**：`now: TW 2 | v4` 保持裸写（CVR 自己就这么写），竖线在行中不是 YAML 指示符。加引号的条件限定为：空串、行首指示符、`: ` 或结尾冒号、` #`、含引号/反斜杠/制表符、首尾空格。URL 里的 `://` 因此不会被误引号。
5. **`itemOf` 也读 `selected`**：Task 12 换节点后要写回 `selected`，先读后写的往返需要它；父键缺失时 `setNested` 追加 `  parent:` + 4 空格子行，`setSelected` 用 `childRange` 整段替换，不会吞掉紧随其后的 `extra:`。

Run: `node --test test/profilesYaml.test.js`

Expected: PASS（12 个测试）。任一条 round-trip 断言失败时，先跑这段定位差异（覆盖 CRLF、无末行换行、链式编辑、删到只剩一项），不要改测试来迁就实现：

```bash
node -e "
const P=require('./server/profilesYaml');const fs=require('fs');
const raw=fs.readFileSync('test/fixtures/cvr-profiles.yaml','utf8');
const cases=[['identity',()=>raw],['setCurrent',()=>P.setCurrent(raw,'Merge')],
 ['append',()=>P.appendItem(raw,{uid:'Z1',type:'remote',name:'x',file:'Z1.yaml',url:'https://x.test/1?token=t',updated:1,option:{allow_auto_update:true}})],
 ['remove-last',()=>P.removeItem(raw,'Rq14DVii2DNo')],['remove-first',()=>P.removeItem(raw,'Merge')],
 ['chained',()=>{let t=P.appendItem(raw,{uid:'Z2',type:'remote',name:'n',file:'Z2.yaml',url:'https://z.test/2',updated:2});t=P.setField(t,'Z2','name','第二家');t=P.setNested(t,'Z2','option','update_interval',1440);t=P.setSelected(t,'Z2',{name:'第二家',now:'TW 2 | v4'});return P.setCurrent(t,'Z2');}],
 ['remove-all-but-one',()=>{let t=raw;for(const u of ['Merge','Script','m9QGfYnAgICa','sFD8EBpJ7JcY','rBAyEk3K4FWA','pcPEvR05flkq','Rq14DVii2DNo'])t=P.removeItem(t,u);return t;}]];
for (const [n,f] of cases) { const out=f(); console.log(n.padEnd(20), P.render(P.parse(out))===out ? 'IDENTITY-OK' : 'IDENTITY-BROKEN', '| blocks', P.parse(out).blocks.length, '| endsNL', out.endsWith('\n')); }
const crlf=raw.replace(/\n/g,'\r\n'); console.log('crlf', P.render(P.parse(crlf))===crlf ? 'IDENTITY-OK' : 'IDENTITY-BROKEN');
const bare=raw.replace(/\n+$/,''); console.log('no-trailing-nl', P.render(P.parse(bare))===bare ? 'IDENTITY-OK' : 'IDENTITY-BROKEN');
"
```

- [x] **Step 5: 全量测试与提交**

```bash
node --test
git add qoder-vpn-proxy/server/profilesYaml.js qoder-vpn-proxy/test/profilesYaml.test.js
git commit -m "feat: profilesYaml 外科式编辑(round-trip 恒等为主验收)"
```

---

### Task 12: store.js + subscriptions.js —— 数据目录与订阅仓库

订阅清单是 `profiles.yaml` 的**可编辑上层视图**：`url`/`name`/流量数据以 `profiles.yaml` 为准（CVR 拥有它），`remark`/`addedAt`/`source` 这类 CVR 没有的字段存插件自己的 `subscriptions.json`。两边合并，冲突时文件赢 —— 这天然实现了 spec §4 的"以 `profiles.yaml` 为准重新导入"。

**Files:**
- Create: `qoder-vpn-proxy/server/store.js`
- Create: `qoder-vpn-proxy/server/subscriptions.js`
- Test: `qoder-vpn-proxy/test/store.test.js`
- Test: `qoder-vpn-proxy/test/subscriptions.test.js`

**Interfaces:**
- Consumes: `profilesYaml.*` (Task 11)、`fetchSubscription` (Task 5)、`ClashClient.reload`/`getProxies` (Task 9)、`ApiError` (Task 3)、`redactUrl` (Task 3)。备份只走本层的 `inlineBackup()` + `store.stamp()`，与 `CvrConfig` 的备份同名不同路（见 Step 6）。
- Produces:
  - `store.dataDir(env?) -> string`（`QODER_VPN_PROXY_DATA` 覆盖，默认 `path.join(os.homedir(), '.qoder', 'vpn-proxy')`）
  - `store.dirs(env?) -> {root, backups, trash, logs}`
  - `store.ensure(dirs) -> dirs`
  - `store.readJson(file, fallback)`、`store.writeJsonAtomic(file, value)`
  - `store.moveToTrash(dirs, absPath) -> trashPath`
  - `store.listTrash(dirs) -> [name]`、`store.listBackupsIn(dir) -> [name]`、`store.latestBackupIn(dir, name) -> string|null`
  - `store.restoreFromTrash(dirs, name, dest)`、`store.stamp() -> string`（`yyyyMMddHHmmssSSS-NNN`，与 `CvrConfig` 备份同名规则）
  - `class SubscriptionRepo({configDir, dirs, client?, fetchImpl?, now?, fsImpl?})`
    - `items() -> [...]`、`current() -> uid|null`、`registryText() -> string`（每次现读，不缓存）
    - `async list() -> Entry[]`
    - `async add({url, name?, remark?, activate?, autoUpdate?, updateInterval?}) -> Entry`
    - `async edit(uid, {url?, name?, remark?, autoUpdate?, updateInterval?}) -> Entry`
    - `async update(uid, {fetchImpl?}) -> Entry`（重抓并写回 profile 内容文件 + `updated` + `extra`）
    - `async updateAll({fetchImpl?}) -> {results:[{uid, ok, ...}]}`
    - `async activate(uid) -> {current, groups}`
    - `async remove(uid, {force?}) -> {removed, trashed, undo}`
    - `Entry = {uid, name, url(redacted), urlPathOnly, file, type, active, nodes, userInfo, updated, autoUpdate, updateInterval, remark, addedAt, source}`
  - 写 `profiles.yaml` 一律：`backup → 写 → 立即重读校验 → 不一致则从备份回滚并抛 profile_registry_desync`

- [x] **Step 1: 写 store 的失败测试**

`test/store.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../server/store');

const tmp = (n) => path.join(os.tmpdir(), `qvp-store-${n}-${process.pid}`);

test('dataDir 默认在 ~/.qoder/vpn-proxy，可用环境变量覆盖', () => {
  assert.equal(S.dataDir({ HOME: '/home/u' }), path.join(os.homedir(), '.qoder', 'vpn-proxy'));
  assert.equal(S.dataDir({ QODER_VPN_PROXY_DATA: '/custom/dir' }), '/custom/dir');
});

test('dirs 给出四个子目录', () => {
  const dir = tmp('dirs');
  const d = S.dirs({ QODER_VPN_PROXY_DATA: dir });
  assert.deepEqual(Object.keys(d).sort(), ['backups', 'logs', 'root', 'trash']);
  assert.equal(d.root, dir);
  assert.equal(d.backups, path.join(dir, 'backups'));
});

test('ensure 造出四个子目录且可重复调用', () => {
  const dir = tmp('ensure');
  fs.rmSync(dir, { recursive: true, force: true });
  const d = S.dirs({ QODER_VPN_PROXY_DATA: dir });
  S.ensure(d); S.ensure(d);
  for (const k of ['root', 'backups', 'trash', 'logs']) assert.ok(fs.existsSync(d[k]), k);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonAtomic 覆盖旧值且不留 .tmp', () => {
  const dir = tmp('json');
  const d = S.ensure(S.dirs({ QODER_VPN_PROXY_DATA: dir }));
  const f = path.join(d.root, 'subscriptions.json');
  S.writeJsonAtomic(f, { a: 1 });
  S.writeJsonAtomic(f, { a: 2, b: 3 });
  assert.deepEqual(S.readJson(f, null), { a: 2, b: 3 });
  assert.deepEqual(fs.readdirSync(d.root).filter((x) => x.includes('.tmp')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson 对损坏文件回 fallback 而不是抛', () => {
  const dir = tmp('broken');
  const d = S.ensure(S.dirs({ QODER_VPN_PROXY_DATA: dir }));
  const f = path.join(d.root, 'x.json');
  fs.writeFileSync(f, '{不是 json');
  assert.equal(S.readJson(f, null), null);
  assert.deepEqual(S.readJson(f, []), []);
  assert.equal(S.readJson(path.join(d.root, 'missing.json'), '兜底'), '兜底');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('moveToTrash 可撤销：移走再还原内容一致', () => {
  const dir = tmp('trash');
  const d = S.ensure(S.dirs({ QODER_VPN_PROXY_DATA: dir }));
  const src = path.join(d.root, 'victim.yaml');
  fs.writeFileSync(src, '原内容\n');
  const moved = S.moveToTrash(d, src);
  assert.ok(!fs.existsSync(src));
  assert.ok(moved.startsWith(d.trash));
  assert.deepEqual(S.listTrash(d).length, 1);
  const back = path.join(d.root, 'restored.yaml');
  S.restoreFromTrash(d, path.basename(moved), back);
  assert.equal(fs.readFileSync(back, 'utf8'), '原内容\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('moveToTrash 对不存在的文件抛 config_write_failed', () => {
  const dir = tmp('trash2');
  const d = S.ensure(S.dirs({ QODER_VPN_PROXY_DATA: dir }));
  assert.throws(() => S.moveToTrash(d, path.join(d.root, 'nope.yaml')), (e) => e.kind === 'config_write_failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stamp 连续调用不撞名（同毫秒内两次备份不能写到同一个文件）', () => {
  const seen = new Set(Array.from({ length: 200 }, () => S.stamp()));
  assert.equal(seen.size, 200);
});
```

- [x] **Step 2: 实现 store.js**

`server/store.js`：

```js
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

/** 备份目录里的文件名，按修改时间升序（老的在前）。名字里混着两种 stamp 格式，字典序会挑到过期那份 */
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
```

- [x] **Step 3: 跑 store 测试**

Run: `node --test test/store.test.js`
Expected: PASS（6 个测试）。

- [x] **Step 4: 写 subscriptions 的失败测试**

`test/subscriptions.test.js`（关键：全程对着沙箱目录跑，`fetchImpl` 注入固定结果，不打真实网络）：

```js
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
  assert.equal(items[0].uid, 'Rq14DVii2DNo');
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
  await assert.rejects(repo.add({ url: FIXTURE_URL }), (e) => e.kind === 'subscription_duplicate' && /Rq14DVii2DNo/.test(e.hint + e.message));
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
  fs.writeFileSync(path.join(configDir, 'profiles', 'Rq14DVii2DNo.yaml'), '# 原订阅内容\nproxies: []\n');
  const before = fs.readFileSync(path.join(configDir, 'profiles', 'Rq14DVii2DNo.yaml'), 'utf8');
  const e = await repo.edit('Rq14DVii2DNo', { url: 'https://panel.example.invalid/NEWPATH?token=NEW' });
  assert.match(e.url, /token=<redacted>$/);
  assert.ok(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8').includes('token=NEW'));
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles', 'Rq14DVii2DNo.yaml'), 'utf8'), before, 'edit url 不动内容文件；只有 update 才重写');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('edit 只改备注时不碰 profiles.yaml', async () => {
  const { dir, configDir, repo } = sandbox('edit-remark');
  const before = fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8');
  const e = await repo.edit('Rq14DVii2DNo', { remark: '主力' });
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
  const e = await repo.update('Rq14DVii2DNo');
  const body = fs.readFileSync(path.join(configDir, 'profiles', 'Rq14DVii2DNo.yaml'), 'utf8');
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
  fs.writeFileSync(path.join(configDir, 'profiles', 'Rq14DVii2DNo.yaml'), '# 旧内容\n');
  await assert.rejects(
    repo.update('Rq14DVii2DNo', { fetchImpl: async () => { const e = new Error('boom'); e.kind = 'subscription_format_unexpected'; throw e; } }),
    (e) => e.kind === 'subscription_format_unexpected'
  );
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8'), profilesBefore);
  assert.equal(fs.readFileSync(path.join(configDir, 'profiles', 'Rq14DVii2DNo.yaml'), 'utf8'), '# 旧内容\n');
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
  await assert.rejects(repo.remove('Rq14DVii2DNo'), (e) => e.kind === 'subscription_active_protected');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove force 后文件进 .trash 且可还原', async () => {
  const { dir, configDir, dirs, repo } = sandbox('trash');
  fs.writeFileSync(path.join(configDir, 'profiles', 'Rq14DVii2DNo.yaml'), '# 可撤销\n');
  const r = await repo.remove('Rq14DVii2DNo', { force: true });
  assert.equal(r.trashed.length, 2, 'profile 内容文件 + profiles.yaml 备份都在回收/备份体系里');
  assert.ok(!fs.existsSync(path.join(configDir, 'profiles', 'Rq14DVii2DNo.yaml')));
  const raw = fs.readFileSync(path.join(configDir, 'profiles.yaml'), 'utf8');
  assert.ok(!raw.includes('uid: Rq14DVii2DNo'));
  assert.equal((await repo.list()).length, 0);
  const trashed = store.listTrash(dirs);
  assert.ok(trashed.some((t) => t.endsWith('Rq14DVii2DNo.yaml')));
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
```

- [x] **Step 5: 实现 subscriptions.js**

`server/subscriptions.js`：

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const P = require('./profilesYaml');
const { ApiError } = require('./envelope');
const { redactUrl } = require('./redact');
const defaultFetch = require('./subscription').fetchSubscription;

const UID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const REGISTRY = 'profiles.yaml';

function newUid(len = 12) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += UID_ALPHABET[bytes[i] % UID_ALPHABET.length];
  return out;
}

const isUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim());

class SubscriptionRepo {
  constructor({
    configDir, dirs, client = null, fetchImpl = defaultFetch,
    now = () => Math.floor(Date.now() / 1000), fsImpl = fs,
  } = {}) {
    if (!configDir || !dirs) throw new ApiError('config_write_failed', 'SubscriptionRepo 需要 configDir 与 dirs', '');
    this.configDir = configDir;
    this.dirs = dirs;
    this.client = client;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.fs = fsImpl;
    this.registryPath = path.join(configDir, REGISTRY);
    this.profilesDir = path.join(configDir, 'profiles');
    this.metaPath = path.join(dirs.root, 'subscriptions.json');
  }

  registryText() {
    if (!this.fs.existsSync(this.registryPath)) {
      throw new ApiError('not_installed', `找不到 ${this.registryPath}`, 'Clash Verge 配置目录不完整');
    }
    return this.fs.readFileSync(this.registryPath, 'utf8');
  }

  items() { return P.listItems(this.registryText()); }

  current() {
    const m = /^current:[ \t]*(.*)$/m.exec(this.registryText());
    return m ? m[1].trim() : null;
  }

  meta() { return store.readJson(this.metaPath, {}) || {}; }

  saveMeta(m) { store.writeJsonAtomic(this.metaPath, m); }

  toEntry(item, currentUid, metaById) {
    const meta = metaById[item.uid] || {};
    return {
      uid: item.uid,
      name: item.name || meta.name || item.uid,
      url: item.url ? redactUrl(item.url) : null,
      urlPathOnly: item.url ? item.url.replace(/[?#].*$/, '') : null,
      file: item.file,
      type: item.type,
      active: item.uid === currentUid,
      nodes: meta.nodes ?? null,
      userInfo: meta.userInfo ?? null,
      updated: item.updated ? Number(item.updated) : null,
      autoUpdate: meta.autoUpdate ?? (item.option && item.option.allow_auto_update ? item.option.allow_auto_update === 'true' : undefined),
      updateInterval: meta.updateInterval ?? (item.option && item.option.update_interval ? Number(item.option.update_interval) : undefined),
      remark: meta.remark ?? '',
      addedAt: meta.addedAt ?? null,
      source: meta.source || 'cvr',
    };
  }

  async list() {
    const currentUid = this.current();
    const metaById = this.meta();
    return this.items()
      .filter((i) => i.type === 'remote' || (metaById[i.uid] && metaById[i.uid].managed))
      .map((i) => this.toEntry(i, currentUid, metaById));
  }

  remoteByUrl(url) { return this.items().find((i) => i.url && i.url === url) || null; }

  mustFind(uid) {
    const items = this.items();
    const item = items.find((i) => i.uid === uid);
    if (item) return item;
    // hint 用 uid(名字) 而不是 uid(脱敏 url)：用户认的是名字
    const known = items.filter((i) => i.type === 'remote').map((i) => `${i.uid}(${i.name || redactUrl(i.url || '')})`).join(' / ');
    throw new ApiError('subscription_not_found', `清单里没有 uid ${uid}`, `现有订阅：${known || '（空）'}`);
  }

  inlineBackup(name) {
    const src = path.join(this.configDir, name);
    if (!this.fs.existsSync(src)) return null;
    this.fs.mkdirSync(this.dirs.backups, { recursive: true });
    const dest = path.join(this.dirs.backups, `${name}.${store.stamp()}.bak`);
    this.fs.copyFileSync(src, dest);
    return dest;
  }

  /** 备份 -> 写 -> 立即重读校验 -> 不一致回滚。CVR 运行时会把内存态回写这个文件 */
  writeRegistry(nextText, { expect } = {}) {
    const backupPath = this.inlineBackup(REGISTRY);
    const backups = backupPath ? [{ name: REGISTRY, backupPath, ts: store.stamp() }] : [];
    const rollback = () => {
      for (const b of backups) {
        try { this.fs.copyFileSync(b.backupPath, this.registryPath); } catch { /* 回滚失败也照样报 desync */ }
      }
    };
    this.fs.writeFileSync(this.registryPath, nextText, 'utf8');
    const reread = this.fs.readFileSync(this.registryPath, 'utf8');
    if (reread !== nextText) {
      rollback();
      throw new ApiError(
        'profile_registry_desync',
        `写入 ${REGISTRY} 后重读不一致，已回滚`,
        'Clash Verge 在运行时会把内存里的订阅状态回写该文件。请让 CVR 处于停止状态后重试（proxy_core_stop），或在 GUI 里改动'
      );
    }
    if (expect) {
      for (const [uid, url] of Object.entries(expect)) {
        const it = P.getItem(reread, uid);
        if (!it || (url !== undefined && it.url !== url)) {
          rollback();
          throw new ApiError('profile_registry_desync', `重读 profiles.yaml 时 uid ${uid} 与预期不符，已回滚`, '写入被外部状态覆盖；建议在 CVR 停止时操作');
        }
      }
    }
    return backups;
  }

  writeProfileFile(uid, yamlText) {
    this.fs.mkdirSync(this.profilesDir, { recursive: true });
    const file = path.join(this.profilesDir, `${uid}.yaml`);
    this.fs.writeFileSync(file, yamlText, 'utf8');
    return file;
  }

  async add({ url, name, remark = '', activate = false, autoUpdate = true, updateInterval = 1440 }) {
    if (!isUrl(url)) throw new ApiError('subscription_url_invalid', '订阅地址必须是完整的 http(s) 链接', '示例：https://机场域名/路径?token=xxx');
    const clean = String(url).trim();
    const dup = this.remoteByUrl(clean);
    if (dup) throw new ApiError('subscription_duplicate', `该链接已存在（uid ${dup.uid}）`, '如要刷新内容用 proxy_subscription_update，如要换地址用 proxy_subscription_edit');

    // 先抓再写：抓不到就一个字节都不动
    const fetched = await this.fetchImpl(clean);
    const uid = newUid();
    const entryName = name || fetched.name || uid;
    const text = this.registryText();
    const item = {
      uid, type: 'remote', name: entryName, file: `${uid}.yaml`, url: clean,
      selected: { name: entryName, now: '' },
      extra: {
        upload: fetched.userInfo ? fetched.userInfo.upload : 0,
        download: fetched.userInfo ? fetched.userInfo.download : 0,
        total: fetched.userInfo ? fetched.userInfo.total : 0,
        expire: fetched.userInfo ? fetched.userInfo.expire || 0 : 0,
      },
      updated: this.now(),
      option: { update_interval: updateInterval, allow_auto_update: Boolean(autoUpdate) },
    };
    if (fetched.yaml) this.writeProfileFile(uid, fetched.yaml);
    else this.writeProfileFile(uid, '# base64 订阅：节点串由 CVR 抓取时展开\n# added-by: qoder-vpn-proxy\n');

    let next = P.appendItem(text, item);
    if (activate) next = P.setCurrent(next, uid);
    this.writeRegistry(next, { expect: { [uid]: clean } });

    const meta = this.meta();
    meta[uid] = {
      uid, name: entryName, remark, source: 'plugin', managed: true,
      addedAt: new Date().toISOString(), lastUpdated: new Date().toISOString(),
      autoUpdate, updateInterval, nodes: fetched.nodes, userInfo: fetched.userInfo,
    };
    this.saveMeta(meta);
    if (activate && this.client) await this.client.reload({ proxyProviders: false }).catch(() => {});
    return this.toEntry(this.mustFind(uid), this.current(), meta);
  }

  async edit(uid, { url, name, remark, autoUpdate, updateInterval } = {}) {
    this.mustFind(uid);
    const text = this.registryText();
    let next = text;
    let fetched = null;

    if (url !== undefined) {
      if (!isUrl(url)) throw new ApiError('subscription_url_invalid', '订阅地址必须是完整的 http(s) 链接', '示例：https://机场域名/路径?token=xxx');
      const clean = String(url).trim();
      const dup = this.remoteByUrl(clean);
      if (dup && dup.uid !== uid) throw new ApiError('subscription_duplicate', `该链接已被 ${dup.uid} 使用`, '若要复用请先删除原订阅');
      fetched = await this.fetchImpl(clean); // 换链接先确认抓得到，否则不改任何文件
      next = P.setField(next, uid, 'url', clean);
    }
    if (name !== undefined) next = P.setField(next, uid, 'name', name);
    if (updateInterval !== undefined) next = P.setNested(next, uid, 'option', 'update_interval', Number(updateInterval));
    if (autoUpdate !== undefined) next = P.setNested(next, uid, 'option', 'allow_auto_update', Boolean(autoUpdate));
    if (next !== text) this.writeRegistry(next, { expect: url !== undefined ? { [uid]: String(url).trim() } : undefined });

    const prev = this.meta()[uid];
    const meta = this.meta();
    meta[uid] = {
      ...(prev || { uid, source: 'cvr', addedAt: new Date().toISOString() }),
      managed: true,
      name: name ?? prev?.name,
      remark: remark ?? prev?.remark ?? '',
      autoUpdate: autoUpdate ?? prev?.autoUpdate,
      updateInterval: updateInterval ?? prev?.updateInterval,
      editedAt: new Date().toISOString(),
    };
    if (fetched) { meta[uid].nodes = fetched.nodes; meta[uid].userInfo = fetched.userInfo; }
    this.saveMeta(meta);
    return this.toEntry(this.mustFind(uid), this.current(), meta);
  }

  async update(uid, { fetchImpl } = {}) {
    const item = this.mustFind(uid);
    if (!item.url) throw new ApiError('subscription_url_invalid', `订阅 ${uid} 没有 url 字段，无法更新`, '这是本地覆盖型 profile，不需要更新');
    const fetched = await (fetchImpl || this.fetchImpl)(item.url); // 抓取失败时后面的写入一行都不执行

    const text = this.registryText();
    const meta = this.meta();
    const ui = fetched.userInfo || {};
    let next = P.setNested(text, uid, 'extra', 'upload', ui.upload ?? 0);
    next = P.setNested(next, uid, 'extra', 'download', ui.download ?? 0);
    next = P.setNested(next, uid, 'extra', 'total', ui.total ?? 0);
    next = P.setNested(next, uid, 'extra', 'expire', ui.expire ?? 0);
    next = P.setField(next, uid, 'updated', this.now());
    // 只有 CVR 里本来就没名字时才用机场名补齐；用户改过的名字不能被每次更新冲掉
    if (fetched.name && item.name === null && !(meta[uid] && meta[uid].name)) next = P.setField(next, uid, 'name', fetched.name);
    this.writeRegistry(next, { expect: { [uid]: item.url } });
    if (fetched.yaml) this.writeProfileFile(uid, fetched.yaml);

    meta[uid] = {
      ...(meta[uid] || { uid, source: 'cvr' }),
      managed: true,
      name: (meta[uid] && meta[uid].name) ?? (item.name === null ? fetched.name : undefined),
      lastUpdated: new Date().toISOString(),
      nodes: fetched.nodes,
      userInfo: fetched.userInfo,
      format: fetched.format,
    };
    this.saveMeta(meta);
    if (this.client && uid === this.current()) await this.client.reload({}).catch(() => {});
    return this.toEntry(this.mustFind(uid), this.current(), meta);
  }

  async updateAll({ fetchImpl } = {}) {
    const entries = await this.list();
    const results = [];
    for (const e of entries) {
      if (e.autoUpdate === false) { results.push({ uid: e.uid, ok: false, kind: 'skipped', message: 'autoUpdate 已关闭' }); continue; }
      try {
        const r = await this.update(e.uid, { fetchImpl });
        results.push({ uid: e.uid, ok: true, nodes: r.nodes, userInfo: r.userInfo });
      } catch (err) {
        results.push({ uid: e.uid, ok: false, kind: err.kind || 'channel_unavailable', message: err.message });
      }
    }
    return { results };
  }

  async activate(uid) {
    this.mustFind(uid);
    const next = P.setCurrent(this.registryText(), uid);
    this.writeRegistry(next);
    if (this.client) await this.client.reload({ proxyProviders: false });
    const groups = this.client ? (await this.client.getProxies()).groups : [];
    const after = this.current();
    if (after !== uid) throw new ApiError('profile_registry_desync', `切换 current 后回读为 ${after}`, 'CVR 可能正在回写该文件');
    return { current: after, groups };
  }

  async remove(uid, { force = false } = {}) {
    const item = this.mustFind(uid);
    if (uid === this.current() && !force) {
      throw new ApiError('subscription_active_protected', `${uid} 是当前激活订阅，删除会让 mihomo 没有配置可用`, '先 activate 到别的订阅，或确认后再传 force: true');
    }
    const backups = this.writeRegistry(P.removeItem(this.registryText(), uid));
    const trashed = backups.map((b) => path.basename(b.backupPath));
    const contentFile = path.join(this.profilesDir, item.file || `${uid}.yaml`);
    if (this.fs.existsSync(contentFile)) trashed.push(path.basename(store.moveToTrash(this.dirs, contentFile)));
    const meta = this.meta();
    delete meta[uid];
    this.saveMeta(meta);
    if (this.client) await this.client.reload({}).catch(() => {});
    return { removed: uid, trashed, undo: `注册表备份在 ${this.dirs.backups}，内容文件在 ${this.dirs.trash}；放回 ${this.profilesDir} 并重新 add 即可撤销` };
  }
}

module.exports = { SubscriptionRepo, newUid, UID_ALPHABET, REGISTRY };
```

- [x] **Step 6: 备份路径收敛（不留 TODO）与本轮落地的判断**

Step 5 草稿里 `this.cvr.backupSync([REGISTRY])` 这个同步备份方法在 Task 10 的 `CvrConfig` 上并不存在，按预定选择第二种：
订阅层自己用 `inlineBackup()`，只有一条备份代码路径，与 `verge.yaml` 的备份共用 `store.stamp()` 命名
（`profiles.yaml.<stamp>.bak`），因此 `proxy_restore_config` 的 `^(?:verge|profiles|config)\.yaml\.[\d-]+\.bak$` 两边都能命中。
`SubscriptionRepo` 因此不再接受 `cvr` 参数——它只用 `dirs.backups`。

另外几处与草稿不同、且已被测试钉住的判断：

1. **`store.stamp()` 带序号后缀**（`…毫秒-00N`）：同毫秒内的两次备份若同名，后一次会盖掉前一次，回滚拿到的就不是改动前的内容。Task 10 踩过同一个坑，这里复用同一个修法；并新增 `listBackupsIn(dir)` / `latestBackupIn(dir, name)` 供 `remove` 与还原工具共用。
2. **删掉 `readProfiles()`**：它返回的 `{current: listItems(text), raw}` 没有调用方，`items()` / `current()` 已覆盖需求，留着只会误导后来人。
3. **`mustFind` 的 hint 用 `uid(名字)`** 而不是 `uid(脱敏 url)`：用户认的是订阅名。`edit 不存在的 uid` 那条测试断言 hint 含 `测试订阅`。
4. **`update` 不冲掉用户改过的订阅名**：只有 `profiles.yaml` 里本来就没有 name、且插件 meta 也没记过名字时，才用机场返回的名字补齐。订阅要支持自定义改名，每次刷新都覆名与这条需求冲突。
5. **`remove` 的 `trashed` 返回两项**：注册表备份名 + 进 `.trash` 的内容文件名，删除后的提示要能对上号。
6. **只改 `remark` 的 `edit` 不写 `profiles.yaml`**：备注是插件自己的字段，落在 `subscriptions.json`；CVR 拥有的文件一个字节都不动。
7. **测试里的订阅地址用 fixture 的占位 host**（`panel.example.invalid/SUBPATH?token=TOKEN_PLACEHOLDER`）：草稿写的是真实链接，那样测试文件本身就成了凭据的副本。
8. **先抓再写**：`add` / `edit url` 都在抓取成功后才动文件；抓取失败时注册表、内容文件、备份一个都不产生（`add 抓取失败时一个文件都不写` 钉这一点）。

Run: `node --test test/subscriptions.test.js`
Expected: PASS（18 个测试；`test/store.test.js` 另 8 个）。

- [x] **Step 7: 全量测试与提交**

```bash
node --test
git add qoder-vpn-proxy/server/store.js qoder-vpn-proxy/server/subscriptions.js qoder-vpn-proxy/test
git commit -m "feat: store 数据目录与订阅仓库(CRUD/写后校验/desync 回滚)"
```

---

### Task 13: toolconfig.js —— npmrc 与 git 全局配置的持久生效层

这是 spec §3.4 的 **A 路径**，也是整个插件里唯一"不依赖 agent 听话"就能让 `npm`/`git` 走代理的一层。

**为什么用标记块而不是解析用户配置**：`~/.npmrc` 与 git 全局配置是用户资产。用 `# >>> qoder-vpn-proxy >>>` 包住的托管块只增删自己的行，用户手写的第一行、注释、其他 registry 配置一律逐字节保留；revert 就是删掉这个块，不需要理解 npmrc 语义。

**为什么 git 用 `--get-regexp` 而不是 `--get`**：`http.https://github.com/.proxy` 这种 key 含 `/` 与 `:`，`--get` 需要精确转义，且我们要一次看清所有 `http.*` 项做审计（spec §8 明确要求 `status` 可作审计依据）。

**Files:**
- Create: `qoder-vpn-proxy/server/toolconfig.js`
- Test: `qoder-vpn-proxy/test/toolconfig.test.js`

**Interfaces:**
- Consumes: `GIT_PROXY_HOSTS` (Task 4)、`ApiError` (Task 3)、`store.dirs`/`store.stamp` (Task 12)
- Produces:
  - `MARK_BEGIN`、`MARK_END`
  - `buildNpmrcBlock(text, {proxyUrl, noproxy}) -> {text, hadBlock, replaced}`（纯函数）
  - `stripNpmrcBlock(text) -> {text, hadBlock}`（纯函数）
  - `gitProxyKeys(hosts) -> string[]`（`http.https://<host>/.proxy`）
  - `class ToolConfig({npmrcPath, gitRunner, backupDir, fsImpl?, env?})`
    - `async apply({proxyUrl, targets = ['npm','git'], hosts?, noproxy?}) -> {npm:{action,created,file,backupPath,before,after,lines[]}, git:{applied[]}}`
    - `async revert({targets = ['npm','git'], hosts?}) -> {npm, git}`
    - `async status({hosts?}) -> {npmrc:{path, exists, managed, proxyLines[]}, git:{managed:[{key,value,expected}], mismatch:boolean}, verdict:'managed'|'partial'|'clean'|'foreign'}`
  - 约定：`apply` 幂等（重复 apply 只更新块内容）；`revert` 对干净状态返回 `{action:'noop'}` 而不报错。

- [x] **Step 1: 写失败的测试**

`test/toolconfig.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TC = require('../server/toolconfig');

const USER_NPMRC = 'registry=https://registry.npmmirror.com\n//registry.npmjs.org/:_authToken=abc\nfund=false\n';

function mkGit(initial = {}) {
  const store = { ...initial };
  const log = [];
  return {
    log,
    store,
    runner: async (args) => {
      log.push(args.join(' '));
      if (args[0] === 'config' && args[1] === '--global' && args[2] === '--get-regexp') {
        const re = new RegExp(args[3].replace(/^\^/, ''));
        const lines = Object.entries(store).filter(([k]) => re.test(k)).map(([k, v]) => `${k} ${v}`);
        return { code: lines.length ? 0 : 1, stdout: lines.join('\n'), stderr: '' };
      }
      if (args[2] === '--unset') { delete store[args[3]]; return { code: 0, stdout: '', stderr: '' }; }
      // 写入形态是 `config --global <key> <value>`：key 在 2 不在 3
      store[args[2]] = args[3];
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function mk(t, content = USER_NPMRC) {
  const dir = path.join(os.tmpdir(), `qvp-tc-${t}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  const npmrc = path.join(dir, '.npmrc');
  fs.writeFileSync(npmrc, content);
  const git = mkGit();
  const tc = new TC.ToolConfig({ npmrcPath: npmrc, gitRunner: git.runner, backupDir: path.join(dir, 'backups'), fsImpl: fs });
  return { dir, npmrc, git, tc };
}

test('buildNpmrcBlock 生成托管块且不动用户行', () => {
  const r = TC.buildNpmrcBlock(USER_NPMRC, { proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost,127.0.0.1' });
  assert.equal(r.hadBlock, false);
  assert.ok(r.text.startsWith(USER_NPMRC), '用户内容原样在开头');
  assert.ok(r.text.includes(TC.MARK_BEGIN) && r.text.includes(TC.MARK_END));
  assert.match(r.text, /^https-proxy=http:\/\/127\.0\.0\.1:7897$/m);
  assert.match(r.text, /^noproxy=localhost,127\.0\.0\.1$/m);
});

test('buildNpmrcBlock 幂等：重复 apply 只保留一个块', () => {
  const once = TC.buildNpmrcBlock(USER_NPMRC, { proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  const twice = TC.buildNpmrcBlock(once.text, { proxyUrl: 'http://127.0.0.1:7890', noproxy: 'localhost' });
  assert.equal(twice.hadBlock, true);
  assert.equal((twice.text.match(/>>> qoder-vpn-proxy/g) || []).length, 1);
  assert.ok(!twice.text.includes('7897'), '旧端口被替换');
  assert.equal((twice.text.match(/^registry=/gm) || []).length, 1, '用户行没被复制');
});

test('stripNpmrcBlock 精确还原原文件', () => {
  const applied = TC.buildNpmrcBlock(USER_NPMRC, { proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  const back = TC.stripNpmrcBlock(applied.text);
  assert.equal(back.hadBlock, true);
  assert.equal(back.text, USER_NPMRC, '逐字节还原');
  assert.equal(TC.stripNpmrcBlock(USER_NPMRC).hadBlock, false, '没有块时不动');
});

test('gitProxyKeys 只生成域名前缀项，绝不生成 http.proxy', () => {
  const keys = TC.gitProxyKeys(['github.com', 'api.github.com']);
  assert.deepEqual(keys, ['http.https://github.com/.proxy', 'http.https://api.github.com/.proxy']);
  assert.ok(!keys.some((k) => k === 'http.proxy' || k === 'https.proxy'), '禁止全局 http.proxy');
});

test('apply 写 npmrc 与 git，并留下备份', async () => {
  const { dir, npmrc, git, tc } = mk('apply');
  const r = await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  assert.equal(r.npm.action, 'written');
  assert.equal(r.npm.before, USER_NPMRC);
  assert.match(fs.readFileSync(npmrc, 'utf8'), /proxy=http:\/\/127\.0\.0\.1:7897/);
  assert.equal(r.git.applied.length, TC.gitProxyKeys().length);
  assert.ok(git.log.every((l) => /config --global http\.https:\/\//.test(l)), git.log.join(' | '));
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.includes('.npmrc')), 'npmrc 有备份');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('apply 两次不产生重复块，git 值被更新', async () => {
  const { dir, npmrc, git, tc } = mk('idempotent');
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7890', noproxy: 'localhost' });
  const text = fs.readFileSync(npmrc, 'utf8');
  assert.equal((text.match(/>>> qoder-vpn-proxy/g) || []).length, 1);
  assert.ok(!text.includes('7897'));
  assert.equal(Object.values(git.store).filter((v) => v === 'http://127.0.0.1:7890').length, TC.gitProxyKeys().length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('apply 拒绝非 127.0.0.1 的 proxyUrl，且不留痕', async () => {
  const { dir, npmrc, git, tc } = mk('badproxy');
  await assert.rejects(tc.apply({ proxyUrl: 'http://10.0.0.9:7897' }), (e) => e.kind === 'malformed_config');
  await assert.rejects(tc.apply({ proxyUrl: 'socks5://127.0.0.1:7898' }), (e) => e.kind === 'malformed_config');
  assert.equal(fs.readFileSync(npmrc, 'utf8'), USER_NPMRC);
  assert.deepEqual(git.log, [], '校验在动 git 之前');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('revert 只删托管块，用户手写的 proxy 行逐字节保留', async () => {
  const { dir, npmrc, tc } = mk('keep-foreign', 'proxy=http://10.0.0.1:3128\nfund=false\n');
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', targets: ['npm'], noproxy: 'localhost' });
  await tc.revert({ targets: ['npm'] });
  assert.equal(fs.readFileSync(npmrc, 'utf8'), 'proxy=http://10.0.0.1:3128\nfund=false\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('revert 之后 git 的 http.* 全空、npmrc 回到原文', async () => {
  const { dir, npmrc, git, tc } = mk('revert');
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  await tc.revert({});
  assert.deepEqual(Object.keys(git.store), [], 'git 全局 http.* 清空（对应验收 6）');
  assert.equal(fs.readFileSync(npmrc, 'utf8'), USER_NPMRC);
  const again = await tc.revert({});
  assert.equal(again.npm.action, 'noop');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status 三种状态可区分：clean / managed / foreign', async () => {
  const clean = mk('clean');
  assert.equal((await clean.tc.status({})).verdict, 'clean');

  const managed = mk('managed');
  await managed.tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  const s = await managed.tc.status({});
  assert.equal(s.verdict, 'managed');
  assert.equal(s.npmrc.managed, true);
  assert.ok(s.git.managed.every((m) => m.value === m.expected && m.expected === 'http://127.0.0.1:7897'));
  assert.equal(s.git.mismatch, false);

  const foreign = mk('foreign', 'proxy=http://10.0.0.1:3128\n');
  const fs2 = await foreign.tc.status({});
  assert.equal(fs2.verdict, 'foreign', '用户自己写过 proxy 但不是我们的块');
  assert.ok(fs2.npmrc.proxyLines.some((l) => l.includes('10.0.0.1')));
  for (const x of [clean, managed, foreign]) fs.rmSync(x.dir, { recursive: true, force: true });
});

test('status 能发现 git 值与期望端口不一致（partial）', async () => {
  const { dir, tc, git } = mk('partial');
  await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' });
  for (const k of TC.gitProxyKeys()) git.store[k] = 'http://127.0.0.1:8888';
  const s = await tc.status({ expectedProxyUrl: 'http://127.0.0.1:7897' });
  assert.equal(s.git.mismatch, true);
  assert.equal(s.verdict, 'partial');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('git 步骤失败时 npmrc 回滚，不留半改', async () => {
  const dir = path.join(os.tmpdir(), `qvp-tc-gitfail-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  const npmrc = path.join(dir, '.npmrc');
  fs.writeFileSync(npmrc, USER_NPMRC);
  const tc = new TC.ToolConfig({
    npmrcPath: npmrc,
    gitRunner: async () => ({ code: 128, stdout: '', stderr: 'unable to read ~/.gitconfig' }),
    backupDir: path.join(dir, 'backups'),
    fsImpl: fs,
  });
  await assert.rejects(tc.apply({ proxyUrl: 'http://127.0.0.1:7897', noproxy: 'localhost' }), (e) => e.kind === 'config_write_failed');
  assert.equal(fs.readFileSync(npmrc, 'utf8'), USER_NPMRC, 'npm 半边不能单独留下托管块');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npmrc 不存在时 apply 会创建，revert 后留空文件而不是删掉用户目录里的项', async () => {
  const dir = path.join(os.tmpdir(), `qvp-tc-missing-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const npmrc = path.join(dir, '.npmrc');
  const tc = new TC.ToolConfig({ npmrcPath: npmrc, gitRunner: mkGit().runner, backupDir: path.join(dir, 'b'), fsImpl: fs });
  const r = await tc.apply({ proxyUrl: 'http://127.0.0.1:7897', targets: ['npm'], noproxy: 'localhost' });
  assert.equal(r.npm.created, true);
  assert.ok(fs.existsSync(npmrc));
  const back = await tc.revert({ targets: ['npm'] });
  assert.equal(back.npm.action, 'removed-created', '插件创建的文件由插件自己收掉');
  assert.ok(!fs.existsSync(npmrc));
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/toolconfig.test.js`
Expected: FAIL，`Cannot find module '../server/toolconfig'`

- [x] **Step 3: 实现**

`server/toolconfig.js`：

```js
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
```

- [x] **Step 4: 判定表与本轮落地的判断（不留 TODO）**

Step 3 草稿的 `verdict` 那段有重复分支（`range || managed.some(...)` 两个分支都返回 `partial`），按 spec 验收 6 的语义收敛成
`managed / partial / foreign / clean` 四档 —— 已并入 Step 3 的最终代码。

本轮另外几处必须记住的事：

1. **计划里 `mkGit` 假 runner 的写入分支下标错了**：`store[args[3]] = args[4]`。真实 argv 是
   `git config --global <key> <value>`，key 在 index 2、value 在 index 3；写错后 git.store 里出现的键是代理 URL 本身、值是
   `undefined`，于是"两次 apply 更新 git 值""revert 后 http.* 全空""status=managed"三条测试一起红。
   **教训**：fake 的 argv 解析必须对着真实命令行形状核一遍，它红了未必是实现错了。Task 15/17 再写 git 假 runner 时直接抄这里修好的版本。
2. **`.npmrc` 备份名改用 `store.stamp()`**（原来是 `Date.now()`）：与 `CvrConfig`/`SubscriptionRepo` 同一套时间戳，
   `store.listBackupsIn()` 的 `\.[\d-]+\.bak$` 才能一次扫全；同毫秒撞名的问题也顺带解决（stamp 自带序号）。
3. **apply 的两步要么都改要么都不改**：npmrc 写完、git 失败时把 npmrc 回滚到本次备份（若文件是本次创建的则删掉）。
   只留 npmrc 半边会让用户以为代理已全量生效。测试 `git 步骤失败时 npmrc 回滚，不留半改` 钉这一点。
4. **proxyUrl 校验前置于任何写入与子进程**：只接受 `http(s)://127.0.0.1:<port>`。这条配置会永久留在
   `~/.npmrc` 与 git 全局配置里，指向外部机器的地址必须是显式决定，不能由一次参数打错触发。
   校验失败时备份目录必须仍是空的（`apply 拒绝非 127.0.0.1 的 proxyUrl，且不留痕`）。
5. **revert 逐字节还原**：`stripNpmrcBlock` 只删标记块，用户手写的 `proxy=` 行、注释、其他 registry 原样保留；
   文件若是我们创建的（内容只剩托管块）就整文件删掉，不留空文件。
6. **构造函数去掉 `npmUserConfigPath`**（草稿里有名无实，没有调用方），`apply` 的返回也不再有 `git.dryRun`。

Run: `node --test test/toolconfig.test.js`
Expected: PASS（13 个测试）。`status 三种状态` 那条如果 `foreign` 判成 `clean`，说明 `proxyLines` 正则漏了没有托管块的裸 `proxy=` 行。

- [x] **Step 5: 全量测试与提交**

```bash
node --test
git add qoder-vpn-proxy/server/toolconfig.js qoder-vpn-proxy/test/toolconfig.test.js
git commit -m "feat: toolconfig npmrc 托管块与 git 域名代理的 apply/revert/status"
```

---

### Task 14: diagnose.js —— 直连 vs 经代理 对比探测

这是 spec §6 验收 1 的举证工具。必须走 `curl` 子进程：Node 的 `fetch` 在本机受 `NODE_OPTIONS`/代理环境变量干扰，而我们要的是"这条命令在这个环境下真实会怎样"。**直连那一轮必须显式 `--noproxy '*'`**，否则会话里已经存在的 `HTTPS_PROXY` 会让"直连"结果失真 —— 这条是本任务最容易出的假阳性，测试里要断言。

**Files:**
- Create: `qoder-vpn-proxy/server/diagnose.js`
- Test: `qoder-vpn-proxy/test/diagnose.test.js`

**Interfaces:**
- Consumes: `redactUrl`/`redactText` (Task 3)。本模块**不** require transport/discovery —— `portAlive` 由调用方传入（Task 15 的 `proxy_diagnose` 用 Task 8 的 `probeTcp` 得出）。探测模块因此完全不碰 CVR，测试也无需替身；副作用只有 `curl` 子进程。
- Produces:
  - `DEFAULT_TARGETS = [{label, url, expectDirect}]`（5 条：github、raw.githubusercontent、npm registry、pypi、qoder.com；`expectDirect` 表示"预期直连就该通，若不通说明网络异常"）
  - `parseCurlOut(stdout) -> {status, connectMs, totalMs, remoteIp}`
  - `curlArgs({url, proxy, timeoutMs}) -> string[]`（纯函数，测试的主战场）
  - `probe({url, proxy, curlRunner, timeoutMs}) -> Promise<{ok, status, connectMs, totalMs, remoteIp, error}>`
  - `rowConclusion(row) -> string`、`summarize(rows) -> {verdict, advice[]}`（纯函数）
  - `runDiagnose({proxyUrl, targets = DEFAULT_TARGETS, curlRunner, timeoutMs = 8000, portAlive = true}) -> Promise<{proxyUrl, proxyPortAlive, rows, verdict, advice, note}>`
  - 行形状：`{label, url, expectDirect, direct: probeResult, proxied: probeResult|'skipped', conclusion}`
  - `WRITE_OUT`（curl `-w` 模板，导出只为让"4 元组顺序"这件事有唯一出处）

- [x] **Step 1: 写失败的测试**

`test/diagnose.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/diagnose');

const PX = 'http://127.0.0.1:7897';

test('curlArgs 直连轮必须显式 --noproxy *，否则结果不可信', () => {
  const direct = D.curlArgs({ url: 'https://github.com', proxy: null, timeoutMs: 8000 });
  assert.ok(direct.includes('--noproxy'), JSON.stringify(direct));
  assert.equal(direct[direct.indexOf('--noproxy') + 1], '*');
  assert.ok(!direct.includes('--proxy'));
  assert.ok(direct.includes('--connect-timeout'), '必须有 connect-timeout，否则死主机要等到 max-time 才失败');
});

test('curlArgs 经代理轮用 --proxy 而不是环境变量', () => {
  const via = D.curlArgs({ url: 'https://github.com', proxy: PX, timeoutMs: 8000 });
  assert.equal(via[via.indexOf('--proxy') + 1], PX);
  assert.ok(!via.includes('--noproxy'));
  assert.match(via.join(' '), /--max-time 8/);
  assert.ok(via.includes('-o'), '丢弃响应体');
  assert.ok(via.includes('-sS'));
});

test('parseCurlOut 解 4 元组', () => {
  assert.deepEqual(
    D.parseCurlOut('200 0.081 1.234 20.205.243.166'),
    { status: 200, connectMs: 81, totalMs: 1234, remoteIp: '20.205.243.166' }
  );
  assert.deepEqual(D.parseCurlOut('000 0.000 8.001 0.0.0.0'), { status: 0, connectMs: 0, totalMs: 8001, remoteIp: '0.0.0.0' });
  assert.equal(D.parseCurlOut('乱码').status, null);
});

const runner = (table) => async (args) => {
  const url = args[args.length - 1];
  const proxied = args.includes('--proxy');
  const hit = table[`${proxied ? 'proxy' : 'direct'}:${url}`];
  if (!hit) return { code: 7, stdout: '000 0.000 8.001 0.0.0.0', stderr: `curl: (7) failed for ${url}` };
  return { code: hit.code ?? 0, stdout: hit.out, stderr: hit.err || '' };
};

test('summarize：github 直连超时、经代理 200 -> 判定需要代理', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [
      { label: 'GitHub', url: 'https://github.com', expectDirect: false },
      { label: 'Qoder', url: 'https://qoder.com', expectDirect: true },
    ],
    curlRunner: runner({
      'direct:https://github.com': { code: 28, out: '000 0.000 8.001 0.0.0.0', err: 'Connection timed out' },
      'proxy:https://github.com': { out: '200 0.090 0.880 20.205.243.166' },
      'direct:https://qoder.com': { out: '200 0.300 0.520 1.2.3.4' },
      'proxy:https://qoder.com': { out: '200 1.800 3.720 5.6.7.8' },
    }),
    timeoutMs: 8000,
  });
  const gh = rows.rows.find((r) => r.label === 'GitHub');
  assert.equal(gh.direct.ok, false);
  assert.equal(gh.proxied.ok, true);
  assert.match(gh.conclusion, /需要代理/);
  assert.ok(rows.advice.some((a) => /--proxy|proxy_toolconfig|HTTP_PROXY/.test(a)));

  const qd = rows.rows.find((r) => r.label === 'Qoder');
  assert.equal(qd.direct.ok, true);
  assert.match(qd.conclusion, /直连更快/, 'Qoder 自己不该走代理');
  assert.ok(rows.advice.some((a) => /不要设置全局 HTTPS_PROXY|Qoder 直连/.test(a)));
});

test('summarize：代理也不通 -> 指向 proxy_test / core_start', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [{ label: 'GitHub', url: 'https://github.com', expectDirect: false }],
    curlRunner: runner({
      'direct:https://github.com': { code: 28, out: '000 0.000 8.001 0.0.0.0' },
      'proxy:https://github.com': { code: 7, out: '000 0.000 8.001 0.0.0.0', err: 'Connection refused' },
    }),
    timeoutMs: 8000,
  });
  assert.match(rows.verdict, /代理本身不通/);
  assert.ok(rows.advice.some((a) => /proxy_test|proxy_core_start/.test(a)));
});

test('代理端口未监听时跳过经代理轮，不产生误导性的"代理不通"', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    portAlive: false,
    targets: [{ label: 'GitHub', url: 'https://github.com', expectDirect: false }],
    curlRunner: runner({ 'direct:https://github.com': { code: 28, out: '000 0.000 8.001 0.0.0.0' } }),
    timeoutMs: 8000,
  });
  assert.equal(rows.rows[0].proxied, 'skipped');
  assert.match(rows.verdict, /代理未运行/);
});

test('输出里没有任何 token 或凭据', async () => {
  const U = 'https://sub.example.test/PATH?token=SECRET123';
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [{ label: '订阅站', url: U, expectDirect: true }],
    curlRunner: runner({ [`direct:${U}`]: { out: '200 0.2 2.1 1.1.1.1' }, [`proxy:${U}`]: { out: '200 0.2 2.1 1.1.1.1' } }),
    timeoutMs: 8000,
  });
  assert.doesNotMatch(JSON.stringify(rows), /SECRET123/);
  assert.match(rows.rows[0].url, /token=<redacted>/);
});

test('curl 不在 PATH 时报"无法执行"而不是假装超时', async () => {
  const r = await D.probe({
    url: 'https://github.com', proxy: null, timeoutMs: 8000,
    curlRunner: async () => { const e = new Error('spawn curl ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.error, /curl 无法执行/);
});

test('DEFAULT_TARGETS 只列公开站点，不做附带外发', () => {
  // 白名单比"排除订阅域名"更硬：任何一次把订阅地址塞进探测目标的改动都会被这里拦住，
  // 而负向 grep 只认识写死的那一个域名。
  const ALLOW = /^(?:github\.com|raw\.githubusercontent\.com|registry\.npmjs\.org|pypi\.org|qoder\.com)$/;
  for (const t of D.DEFAULT_TARGETS) {
    assert.match(t.url, /^https:\/\//, t.url);
    assert.doesNotMatch(t.url, /[?&]token=/, t.url);
    assert.ok(ALLOW.test(new URL(t.url).hostname), t.url);
  }
  assert.ok(D.DEFAULT_TARGETS.some((t) => /github\.com/.test(t.url)));
  assert.equal(D.DEFAULT_TARGETS.length, 5);
});

```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/diagnose.test.js`
Expected: FAIL，`Cannot find module '../server/diagnose'`

- [x] **Step 3: 实现**

`server/diagnose.js`：

```js
'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { redactUrl, redactText } = require('./redact');

const execFileAsync = promisify(execFile);

const DEFAULT_TARGETS = [
  { label: 'GitHub 站点', url: 'https://github.com', expectDirect: false },
  { label: 'GitHub raw', url: 'https://raw.githubusercontent.com/sindresorhus/got/main/readme.md', expectDirect: false },
  { label: 'npm registry', url: 'https://registry.npmjs.org/react', expectDirect: true },
  { label: 'PyPI', url: 'https://pypi.org/simple/requests/', expectDirect: true },
  { label: 'Qoder', url: 'https://qoder.com', expectDirect: true },
];

const WRITE_OUT = '%{http_code} %{time_connect} %{time_total} %{remote_ip}';

function curlArgs({ url, proxy, timeoutMs = 8000 }) {
  const args = [
    '-sS', '-L', '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--connect-timeout', String(Math.max(2, Math.ceil(timeoutMs / 1000 / 2))),
    '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '-w', WRITE_OUT,
  ];
  // 直连轮必须屏蔽环境变量里的代理，否则"直连"结论不可信
  if (proxy) args.splice(args.indexOf('-w'), 0, '--proxy', proxy);
  else args.splice(args.indexOf('-w'), 0, '--noproxy', '*');
  args.push(url);
  return args;
}

function parseCurlOut(stdout) {
  const m = /^(\d{3})\s+([\d.]+)\s+([\d.]+)\s+(\S+)$/.exec(String(stdout || '').trim());
  if (!m) return { status: null, connectMs: null, totalMs: null, remoteIp: null };
  return {
    status: Number(m[1]) === 0 ? 0 : Number(m[1]),
    connectMs: Math.round(Number(m[2]) * 1000),
    totalMs: Math.round(Number(m[3]) * 1000),
    remoteIp: m[4],
  };
}

async function probe({ url, proxy, curlRunner, timeoutMs }) {
  const args = curlArgs({ url, proxy, timeoutMs });
  let r;
  try { r = await curlRunner(args); }
  catch (e) { return { ok: false, ...parseCurlOut(''), error: redactText(`curl 无法执行: ${e.code || e.message}`) }; }
  const parsed = parseCurlOut(r.stdout);
  const ok = r.code === 0 && parsed.status >= 200 && parsed.status < 400;
  return {
    ok,
    ...parsed,
    error: ok ? null : redactText(parsed.status === null
      ? `curl exit ${r.code}: ${(r.stderr || '').slice(0, 140)}`
      : `HTTP ${parsed.status}${r.code ? ` (curl exit ${r.code})` : ''}`),
  };
}

function rowConclusion(row) {
  const { direct, proxied } = row;
  if (proxied === 'skipped') {
    if (!direct.ok) return row.expectDirect ? '直连失败且代理未运行' : '直连失败（该域名通常需要代理），但代理未运行';
    return '直连正常，代理未运行';
  }
  if (!direct.ok && proxied.ok) return '需要代理：直连不通，经代理正常';
  if (direct.ok && proxied.ok) {
    if (proxied.totalMs != null && direct.totalMs != null && proxied.totalMs > direct.totalMs * 1.5) {
      return `直连更快（${direct.totalMs}ms vs 经代理 ${proxied.totalMs}ms），此项不该走代理`;
    }
    return '两种路径都通';
  }
  if (direct.ok && !proxied.ok) return '经代理反而失败：该节点或规则可能有问题';
  return '直连与代理均失败';
}

function summarize(rows) {
  const advice = [];
  const needsProxy = rows.filter((r) => /需要代理/.test(r.conclusion));
  const allProxiedDead = rows.length > 0 && rows.every((r) => r.proxied !== 'skipped' && !r.proxied.ok);
  const skippedAll = rows.length > 0 && rows.every((r) => r.proxied === 'skipped');
  const fasterDirect = rows.filter((r) => /直连更快/.test(r.conclusion));

  let verdict;
  if (skippedAll) verdict = '代理未运行，只完成直连探测';
  else if (allProxiedDead) verdict = '代理本身不通';
  else if (needsProxy.length) verdict = `代理对 ${needsProxy.length} 项目前是必需的`;
  else verdict = '直连全部正常，代理可选';

  if (skippedAll) advice.push('先 proxy_core_start（scope 默认 session，不会影响其他应用），再重跑 proxy_diagnose');
  if (allProxiedDead) advice.push('代理端口在监听但出不了网：先 proxy_test 看节点延迟，再 proxy_select 换组内其他节点');
  if (needsProxy.length) {
    advice.push(`需要代理的目标：${needsProxy.map((r) => r.label).join('、')}`);
    advice.push('单次命令：内联 HTTP_PROXY/HTTPS_PROXY 前缀（proxy_env target=shell 给出）；长期：proxy_toolconfig action=apply');
  }
  if (fasterDirect.length) {
    advice.push(`${fasterDirect.map((r) => r.label).join('、')} 直连更快，不要设置全局 HTTPS_PROXY，否则 Qoder 自身请求会被拖慢并可能断连`);
  }
  if (rows.some((r) => r.expectDirect && r.proxied !== 'skipped' && !r.proxied.ok && r.direct.ok)) {
    advice.push('有预期可直连的目标经代理后失败，说明出口 IP 被对方站拒绝（常见于 pypi/npm 的国内镜像策略）');
  }
  return { verdict, advice };
}

async function runDiagnose({
  proxyUrl,
  targets = DEFAULT_TARGETS,
  curlRunner,
  timeoutMs = 8000,
  portAlive = true,
}) {
  const runner = curlRunner || (async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync('curl', args, { windowsHide: true, timeout: timeoutMs + 4000, maxBuffer: 1 << 20 });
      return { code: 0, stdout, stderr };
    } catch (e) {
      return { code: typeof e.code === 'number' ? e.code : 7, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
  });

  const rows = [];
  for (const t of targets) {
    const safeUrl = redactUrl(t.url);
    const direct = await probe({ url: t.url, proxy: null, curlRunner: runner, timeoutMs });
    const proxied = portAlive ? await probe({ url: t.url, proxy: proxyUrl, curlRunner: runner, timeoutMs }) : 'skipped';
    const row = { label: t.label, url: safeUrl, expectDirect: Boolean(t.expectDirect), direct, proxied };
    row.conclusion = rowConclusion(row);
    rows.push(row);
  }
  const { verdict, advice } = summarize(rows);
  return {
    proxyUrl: proxyUrl || null,
    proxyPortAlive: portAlive,
    rows,
    verdict,
    advice,
    note: 'curl 的 --noproxy/--proxy 决定了每一轮是否真的绕过环境变量；本表两列均在同一时刻各跑一次，网络抖动可能让单行结论不稳，重要结论请重复一次',
  };
}

module.exports = { DEFAULT_TARGETS, WRITE_OUT, curlArgs, parseCurlOut, probe, rowConclusion, summarize, runDiagnose };

```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test test/diagnose.test.js`
Expected: PASS（9 个测试）。落地时对草稿测试做了两处改动，都不是美化：

1. `DEFAULT_TARGETS` 的守卫从"负向 grep 订阅域名"换成**公开域名白名单**（`ALLOW.test(new URL(t.url).hostname)`）。负向 grep 只认识写死的那一个域名，将来把任何别的地址（包括订阅地址的另一个形态）塞进探测目标都拦不住；白名单是"默认拒绝"，顺带把 token 查询参数也禁了。
2. 那条"输出里没有任何 token"的测试改用 `sub.example.test`。测试文件本身就是会被提交进仓库的源码，把真实订阅域名和路径抄进去，等于让测试变成凭据的一份副本 —— Task 12 的测试已经因为同样的理由用过 `panel.example.invalid`。
3. 补了 `curl 不在 PATH` 这条：`probe` 在 runner 抛异常时返回 `error: 'curl 无法执行: …'`，与"超时"是两种不同的故障，Windows 上 `curl.exe` 自 1803 起自带，但用户机器可能被精简过。

`curlArgs` 里 `--proxy` 插在 `-w` 之前只是可读性，断言只看 `includes`；若你调整顺序，别改动 `--noproxy` 与 `--proxy` 互斥这条。

- [x] **Step 5: 真机跑一次直连基线（只读，不启动 CVR）**

```bash
cd qoder-vpn-proxy && node -e "
const {runDiagnose}=require('./server/diagnose');
runDiagnose({proxyUrl:'http://127.0.0.1:7897', portAlive:false}).then(r=>{
  console.log('verdict:', r.verdict);
  for (const x of r.rows) console.log(x.label.padEnd(14), x.direct.ok?'直连OK':'直连FAIL', x.direct.status, x.direct.totalMs+'ms', x.conclusion);
  console.log(r.advice.map(a=>'· '+a).join('\n'));
})"
```

Expected: 与 spec §2 基线一致 —— GitHub 两行 FAIL（超时）、npm/PyPI/Qoder 直连 OK、`verdict` 为"代理未运行…"。若 GitHub 直连也 OK 了，说明网络状况已变化，把新基线写回 spec §2 再继续。

**实测结果（已发生，spec §2 已按此更新）**：5 行全部 `直连OK 200`，`verdict` 为"代理未运行，只完成直连探测"。这不是探测在说谎 —— 单独复核过 3 轮 `github.com` 与 `raw.githubusercontent.com`（6/6 全部 200，对端 `20.205.243.166` / `185.199.108.133` 是真实 GitHub/Fastly IP，connect 约 0.09s），同时确认：本轮 `--noproxy '*'`、`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 均未设置、7897/7898/7899/9097 全部未监听、`ipconfig` 只有物理网卡和 vEthernet Default Switch（无 TUN 网卡）。结论是**网络状况确实变了，GitHub 直连会随时段翻转**，spec §2 里同时保留首轮与复测两行，并把"是否需要代理"的职责正式交给 `proxy_diagnose` 的当场输出。

- [x] **Step 6: 全量测试与提交**

```bash
node --test
git add qoder-vpn-proxy/server/diagnose.js qoder-vpn-proxy/test/diagnose.test.js
git commit -m "feat: diagnose 直连与经代理对比探测(含 --noproxy 隔离环境变量)"
```

---

## 阶段 4：MCP 接线

### Task 15: protocol.js + tools.js + index.js —— 17 个工具上线

**一条 `proxy_status` 的例外约定**（spec §4 之外，写在这里避免实现时猜）：`proxy_status` 与 `proxy_detect` 是"报告状态"的工具，即使核心没跑也返回 `ok:true`，把不可达信息放进 `data.core = {reachable:false, kind, message, hint}`。其余 15 个工具在核心不可达时正常返回 `ok:false` + `core_not_running`/`channel_unavailable`。验收 4 的"关闭 CVR 后调用工具返回 core_not_running"针对后者。

**Files:**
- Create: `qoder-vpn-proxy/server/protocol.js`
- Create: `qoder-vpn-proxy/server/tools.js`
- Create: `qoder-vpn-proxy/server/index.js`
- Test: `qoder-vpn-proxy/test/protocol.test.js`
- Test: `qoder-vpn-proxy/test/tools.test.js`
- Test: `qoder-vpn-proxy/test/index.test.js`（Step 7 给出内容：真起一个子进程跑 stdio，是 Step 8 冒烟的常驻版）

**Interfaces:**
- Consumes: 前面全部层
- Produces:
  - `PROTOCOL_VERSION = '2024-11-05'`、`SERVER_INFO = {name:'qoder-vpn-proxy', version:'0.1.0'}`（两个常量与 `INSTRUCTIONS` 都住在 `protocol.js` 里。**没有 `meta.js`** —— 计划草稿为"protocol 与 tools 都要用 SERVER_INFO"设了个常量文件，实际只有 protocol 用，为一个文件再开一层是纯开销；`TOOLS_MIN_COUNT` 一并删掉，工具数量由 `tools.js` 的 `TOOL_NAMES` 与 `test/tools.test.js` 的长度断言守住）
  - `framer() -> {push(chunk: string|Buffer) -> object[]}`（换行分隔 JSON-RPC 帧，容忍跨 chunk 与单 chunk 多帧；草稿里的 `pending` 字段没人读，落地时去掉）
  - `handleMessage(msg, {tools, callTool, log}) -> Promise<{jsonrpc:'2.0', id, result}|{jsonrpc,id,error}|null>`（notification 回 `null`）
  - `buildTools(deps) -> Tool[]`，`Tool = {name, description, inputSchema, handler}`
  - `callTool(name, args, deps) -> Promise<envelope>`（catch 一切异常 → `toEnvelope` → `redactText`）
  - `main() -> void`（index.js：绑定 stdin/stdout，日志只进文件与 stderr；stdin 关闭后收完在途请求再退）
  - `deps` 形状（测试注入用）：`{getRuntime, getClient, getRepo, getCvr, getToolConfig, getDiagnoseDeps, log}`。**只保留被真实消费的键** —— 端口一律从 `getRuntime()` 取，不要再加 `getEnvBlock`/`listBackups`/`now`/`dispose` 这类没人调的注入点。

- [x] **Step 1: 写 protocol 的失败测试**

`test/protocol.test.js`：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { framer, handleMessage, PROTOCOL_VERSION, SERVER_INFO } = require('../server/protocol');

const stubTools = [
  { name: 'proxy_status', description: '状态', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'proxy_env', description: 'env', inputSchema: { type: 'object', properties: { target: { type: 'string', enum: ['shell', 'npm', 'git', 'pip'] } }, additionalProperties: false } },
];
const deps = {
  callTool: async (name, args) => (name === 'proxy_status'
    ? { ok: true, data: { running: true, args } }
    : { ok: false, kind: 'core_not_running', message: '没跑', hint: 'start 它' }),
  tools: stubTools,
  log: () => {},
};

test('framer 处理跨 chunk 拆分与单 chunk 多帧', () => {
  const f = framer();
  assert.deepEqual(f.push('{"jsonrpc":"2.0","id":1,"me'), []);
  const got = f.push('thod":"initialize"}\n{"jsonrpc":"2.0","method":"ping"}\n');
  assert.equal(got.length, 2);
  assert.equal(got[0].id, 1);
  assert.equal(got[1].method, 'ping');
});

test('framer 对坏帧只丢这一帧，不阻塞后续', () => {
  const f = framer();
  const got = f.push('{坏 json}\n{"jsonrpc":"2.0","method":"ping"}\n');
  assert.equal(got.length, 1);
  assert.equal(got[0].method, 'ping');
});

test('initialize 回 protocolVersion / capabilities / serverInfo / instructions', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'qoder', version: 'x' } } }, deps);
  assert.equal(res.id, 7);
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(res.result.serverInfo, SERVER_INFO);
  assert.ok(res.result.capabilities.tools);
  assert.match(res.result.instructions, /代理/);
});

test('notifications/initialized 不回帧', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps), null);
});

test('tools/list 输出 MCP 形状的 tools 数组', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps);
  assert.equal(res.result.tools.length, 2);
  assert.deepEqual(Object.keys(res.result.tools[0]).sort(), ['description', 'inputSchema', 'name']);
});

test('tools/call 把 envelope 序列化进 content[0].text，失败时 isError:true', async () => {
  const okRes = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'proxy_status', arguments: { a: 1 } } }, deps);
  assert.equal(okRes.result.isError, false);
  assert.deepEqual(JSON.parse(okRes.result.content[0].text), { ok: true, data: { running: true, args: { a: 1 } } });

  const badRes = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'proxy_env', arguments: {} } }, deps);
  assert.equal(badRes.result.isError, true);
  assert.equal(JSON.parse(badRes.result.content[0].text).kind, 'core_not_running');
});

test('未知工具 -> JSON-RPC -32602；未知方法 -> -32601', async () => {
  const a = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }, deps);
  assert.equal(a.error.code, -32602);
  assert.match(a.error.message, /nope/);
  const b = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, deps);
  assert.equal(b.error.code, -32601);
});

test('handler 抛异常时回 -32603 而不是让服务端崩', async () => {
  const boom = { tools: stubTools, log: () => {}, callTool: async () => { throw new Error('内部炸了'); } };
  const res = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'proxy_status', arguments: {} } }, boom);
  assert.equal(res.error.code, -32603);
});
```

- [x] **Step 2: 实现 protocol.js**

`server/protocol.js`：

```js
'use strict';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'qoder-vpn-proxy', version: '0.1.0' };

const INSTRUCTIONS = [
  '本插件复用本机 Clash Verge Rev / mihomo 作为代理内核，只做识别、控制与诊断，不自己转发流量。',
  '常用顺序：proxy_status 看现状 -> proxy_core_start 启动（默认 scope=session，不动系统代理）-> proxy_nodes/proxy_test/proxy_select 选节点 -> proxy_diagnose 验证直连与经代理差异。',
  '要让本会话的 npm/git 实际走代理用 proxy_toolconfig(action=apply)；只想单次命令用 proxy_env 拿前缀。',
  '订阅可自主维护：proxy_subscriptions 列清单，add/edit/update/activate/remove 管理，edit 用于机场换地址或轮换 token。',
  '代理端口一律来自返回值，不要凭记忆写 7897。所有 URL 中的 token 已被脱敏，原始 token 只在抓取时使用。',
].join(' ');

function framer() {
  let buf = '';
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const out = [];
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* 坏帧丢弃，继续服务 */ }
      }
      return out;
    },
  };
}

const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleMessage(msg, { tools, callTool, log = () => {} }) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    case 'ping':
      return isNotification ? null : { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
    case 'tools/call': {
      const name = params && params.name;
      if (!tools.some((t) => t.name === name)) return err(id, -32602, `未知工具: ${String(name)}`);
      let envelope;
      try {
        envelope = await callTool(name, (params && params.arguments) || {});
      } catch (e) {
        log(`tools/call ${name} 内部异常: ${e && e.stack ? e.stack : e}`);
        return err(id, -32603, '工具执行内部异常，详情见插件日志');
      }
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], isError: !envelope.ok },
      };
    }
    default:
      if (String(method || '').startsWith('notifications/')) return null;
      return isNotification ? null : err(id, -32601, `方法不支持: ${String(method)}`);
  }
}

module.exports = { PROTOCOL_VERSION, SERVER_INFO, INSTRUCTIONS, framer, handleMessage };
```

草稿在这里还要求建 `server/meta.js`（`SERVER_INFO` + `TOOLS_MIN_COUNT` 两个常量）。**落地时没有这个文件**：`SERVER_INFO` 只有 `protocol.js` 自己用，`TOOLS_MIN_COUNT` 是"至少 17 个"这种含糊断言的来源，换成 `test/tools.test.js` 里对 `TOOL_NAMES.length` 的精确相等更硬。为两个常量单开一个模块、再让两个模块各 `require` 一次，是纯粹的间接层。

- [x] **Step 3: 跑 protocol 测试**

Run: `node --test test/protocol.test.js`
Expected: PASS（8 个测试）。

- [x] **Step 4: 写 tools 的失败测试**

`test/tools.test.js`（前半：用假 deps 覆盖 17 个工具的 schema 与错误分类；后半：全链路对着 fake-mihomo + 沙箱 profiles）：

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildTools, callTool, TOOL_NAMES } = require('../server/tools');
const { ApiError } = require('../server/envelope');
const { startFake } = require('./fake-mihomo');
const { createTransport } = require('../server/transport');
const { ClashClient } = require('../server/clash-client');
const { SubscriptionRepo } = require('../server/subscriptions');
const store = require('../server/store');

const RUNTIME = {
  installed: true, running: true, configDir: '/tmp/cvr', configSource: 'config.yaml',
  installDir: '/tmp/inst', exePath: '/tmp/inst/clash-verge.exe', corePath: '/tmp/inst/verge-mihomo.exe',
  ports: { mixed: 7897, socks: 7898, http: 7899 },
  controller: { pipe: '\\\\.\\pipe\\verge-mihomo', tcp: null, tcpConfigured: '127.0.0.1:9097', tcpEnabled: false },
  secret: 'set-your-secret',
  settings: { enableExternalController: false, enableSystemProxy: false, enableTunMode: false, mixedPort: 7897, socksPort: 7898, httpPort: 7899, systemProxyBypass: null },
  profiles: { current: 'Rq14DVii2DNo', items: [{ uid: 'Rq14DVii2DNo', type: 'remote', name: '测试订阅', file: 'Rq14DVii2DNo.yaml', url: 'https://x.test/s?token=T', updated: 1 }] },
  warnings: [],
  // 与 discovery.js 未安装分支的 channelHint 同源（discovery.test.js 断言它含"安装"）：
  // 假 runtime 塞一个 'hint' 占位，下面"未安装要给安装指引"那条就只是在测占位符。
  channelHint: '未检测到 Clash Verge Rev。请安装到默认目录 C:\\Program Files\\Clash Verge，或设置 QVP_INSTALL_DIR 指向安装目录、QVP_CONFIG_DIR 指向配置目录',
};

// 假件必须和真模块一样拒收非法 url：真 SubscriptionRepo.add 第一行就是 isUrl 校验，
// 假件若来者不拒，"校验失败不能已经调过底层"这条测试就是在测一个不存在的实现。
const httpUrl = (u) => /^https?:\/\/[^/?#\s]+\.[^/?#\s]/i.test(String(u || ''));

function fakeDeps(over = {}) {
  const calls = [];
  const client = {
    channelKind: 'pipe',
    getConfigs: async () => ({ mode: 'rule', mixedPort: 7897, tunEnabled: false, socksPort: 7898, port: 7899, externalController: '' }),
    getProxies: async () => ({ groups: [{ name: '节点选择', type: 'Selector', now: 'HK 3 | v4', all: ['HK 3 | v4', 'JP 1 | v3', 'dead-node'], history: [] }], nodes: ['HK 3 | v4', 'JP 1 | v3', 'dead-node'] }),
    select: async (g, t) => ({ group: g, now: t }),
    setConfigs: async (p) => p,
    // 真 delay 在 HTTP 503 时抛 ApiError('timeout')，假件也必须抛 ApiError，
    // 否则 proxy_test 里的 per-node kind 分类根本没被 exercised（只断言 ok:false 看不出来）。
    delay: async (n) => { if (n === 'dead-node') throw new ApiError('timeout', '测速 dead-node 失败: HTTP 503', '该节点不可达或超时，可跳过它换下一个'); return n.length * 10; },
    reload: async () => ({ reloaded: true }),
    version: async () => ({ version: '1.19.0' }),
    close() {},
  };
  const repo = {
    list: async () => [{ uid: 'Rq14DVii2DNo', name: '测试订阅', url: 'https://x.test/s?token=<redacted>', active: true, type: 'remote', nodes: 40, userInfo: { total: 1, upload: 1, download: 1, expire: null }, updated: 1, remark: '', source: 'cvr' }],
    add: async ({ url }) => {
      if (!httpUrl(url)) throw new ApiError('subscription_url_invalid', '订阅地址必须是完整的 http(s) 链接', '示例：https://机场域名/路径?token=xxx');
      calls.push(['add', url]);
      return { uid: 'AAAAAAAAAAAA', url: 'https://x.test/s?token=<redacted>', name: '新' };
    },
    edit: async (uid, p) => {
      if (p.url !== undefined && !httpUrl(p.url)) throw new ApiError('subscription_url_invalid', '订阅地址必须是完整的 http(s) 链接', '');
      calls.push(['edit', uid, p]);
      return { uid, url: 'https://x.test/s?token=<redacted>' };
    },
    update: async (uid) => ({ uid, nodes: 41 }),
    updateAll: async () => ({ results: [{ uid: 'Rq14DVii2DNo', ok: true }] }),
    activate: async (uid) => ({ current: uid, groups: [] }),
    remove: async () => ({ removed: 'Rq14DVii2DNo', trashed: ['Rq14DVii2DNo.yaml'] }),
  };
  // start 的返回值必须含 backups：真 CvrConfig.start 一定返回它，漏了就会让
  // proxy_core_start 的 r.backups.map 只在测试里炸（Task 13 假 git runner 的同款错误）。
  const cvr = { start: async (o) => { calls.push(['start', o]); return { scope: o.scope, systemProxySuppressed: o.scope === 'session', channel: { kind: 'pipe', ports: RUNTIME.ports }, ports: RUNTIME.ports, waitedMs: 1200, backups: [{ name: 'verge.yaml', ts: '20260930-1', backupPath: '/tmp/b', skipped: false }, { name: 'profiles.yaml', ts: '20260930-1', skipped: true }] }; }, stop: async (o) => ({ killed: ['clash-verge.exe'], restored: o.restore }), listBackups: () => [{ name: 'verge.yaml', ts: '20260930-1', backupPath: '/tmp/b' }], modifiedSinceBackup: () => ({ modified: [] }), restore: async () => ({ restored: [{ name: 'verge.yaml', backupPath: '/tmp/b' }] }), suppressSystemProxy: async () => ({ changed: [] }), setExternalController: async (v) => ({ changed: v ? [{ key: 'enable_external_controller', before: 'false', after: 'true' }] : [] }) };
  const toolConfig = { apply: async (a) => { calls.push(['tc-apply', a]); return { npm: { action: 'written' }, git: { applied: [{ key: 'http.https://github.com/.proxy', value: a.proxyUrl }] } }; }, revert: async () => ({ npm: { action: 'stripped' }, git: { removed: [] } }), status: async () => ({ verdict: 'clean', npmrc: { exists: true, managed: false, proxyLines: [] }, git: { managed: [], mismatch: false, otherHttpKeys: [] } }) };

  const deps = {
    getRuntime: async () => RUNTIME,
    getClient: async () => client,
    getRepo: async () => repo,
    getCvr: async () => cvr,
    getToolConfig: async () => toolConfig,
    getDiagnoseDeps: () => ({ curlRunner: async (args) => (args.includes('--proxy') ? { code: 0, stdout: '200 0.1 0.9 1.1.1.1' } : { code: 28, stdout: '000 0.000 8.001 0.0.0.0', stderr: 'timeout' }) }),
    log: () => {},
    ...over,
  };
  return { deps, calls, client, repo };
}

test('17 个工具全部注册，schema 合规且 description 是中文', () => {
  const { deps } = fakeDeps();
  const tools = buildTools(deps);
  assert.equal(TOOL_NAMES.length, 17, 'spec §3.3 规定 17 个工具');
  assert.equal(tools.length, TOOL_NAMES.length);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} 必须收紧额外参数`);
    assert.match(t.description, /[一-龥]/, `${t.name} 描述要中文`);
    assert.equal(typeof t.handler, 'function');
    assert.doesNotMatch(t.name, /[A-Z]/);
  }
  assert.deepEqual(new Set(tools.map((t) => t.name)).size, tools.length, '工具名不得重复');
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort(), 'TOOL_NAMES 与实际注册必须一一对应');
});

test('每个工具都能跑通一次并返回 ok:true', async () => {
  const { deps } = fakeDeps();
  const tools = buildTools(deps);
  const SAMPLE = {
    proxy_core_start: { scope: 'session' },
    proxy_core_stop: { restore: true },
    proxy_nodes: { group: '节点选择' },
    proxy_select: { group: '节点选择', target: 'HK 3 | v4' },
    proxy_test: { group: '节点选择' },
    proxy_env: { target: 'shell' },
    proxy_toolconfig: { action: 'apply', target: 'npm' },
    proxy_subscription_add: { url: 'https://x.test/new?token=T' },
    proxy_subscription_edit: { uid: 'Rq14DVii2DNo', url: 'https://x.test/rotated?token=T2' },
    proxy_subscription_update: { uid: 'Rq14DVii2DNo' },
    proxy_subscription_activate: { uid: 'Rq14DVii2DNo' },
    proxy_subscription_remove: { uid: 'Rq14DVii2DNo', force: true },
    proxy_diagnose: { targets: ['https://github.com'] },
    proxy_restore_config: { name: 'verge.yaml' },
  };
  for (const t of tools) {
    const env = await callTool(t.name, SAMPLE[t.name] || {}, deps);
    assert.equal(env.ok, true, `${t.name} 应成功，实得 ${JSON.stringify(env)}`);
    assert.ok(env.data !== undefined, `${t.name} 必须有 data`);
  }
});

test('开启外部控制不单列为工具：由 proxy_core_start 的 enableExternalControl 转发，默认 false', async () => {
  const { deps, calls } = fakeDeps();
  const start = buildTools(deps).find((t) => t.name === 'proxy_core_start');
  assert.ok(start.inputSchema.properties.enableExternalControl, 'schema 必须暴露这个开关，否则 channel_unavailable 的 hint 无路可走');
  assert.equal(TOOL_NAMES.includes('proxy_enable_external_control'), false, 'spec §3.3 明确不要第 18 个工具');
  await callTool('proxy_core_start', { scope: 'session' }, deps);
  assert.equal(calls[0][1].enableExternalControl, false, '未经用户确认不得改 enable_external_controller');
  await callTool('proxy_core_start', { scope: 'session', enableExternalControl: true }, deps);
  assert.equal(calls[1][1].enableExternalControl, true);
});

test('参数校验：非法 mode / 缺 url / 非法 action 都被拒且不碰底层', async () => {
  const { deps, calls } = fakeDeps();
  assert.equal((await callTool('proxy_select', { mode: 'turbo' }, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_select', {}, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_subscription_add', { url: '不是链接' }, deps)).kind, 'subscription_url_invalid');
  assert.equal((await callTool('proxy_toolconfig', { action: 'explode' }, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_core_start', { scope: 'planet' }, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_diagnose', { targets: 'https://github.com' }, deps)).kind, 'malformed_config');
  assert.equal((await callTool('proxy_env', { timeoutish: 1 }, deps)).kind, 'malformed_config');
  assert.equal(calls.length, 0, '校验失败不能已经调过底层');
});

test('未知工具名 -> 明确错误而不是静默', async () => {
  const { deps } = fakeDeps();
  const e = await callTool('proxy_nothing', {}, deps);
  assert.equal(e.ok, false);
  assert.match(e.message, /proxy_nothing/);
});

test('核心不可达时按 kind 分类，proxy_status 例外仍回 ok:true', async () => {
  // 真 transport/clash-client 一律抛 ApiError（kind+hint 都在实例上），
  // 用"普通 Error 加 .kind 属性"的假件会让 toEnvelope 走未预期错误分支，hint 变成兜底文案 —— 假件必须在撒谎。
  const { deps } = fakeDeps({
    getClient: async () => { throw new ApiError('channel_unavailable', '连不上', '先 start'); },
  });
  for (const name of ['proxy_nodes', 'proxy_test', 'proxy_select']) {
    const env = await callTool(name, name === 'proxy_select' ? { group: 'a', target: 'b' } : { group: 'a' }, deps);
    assert.equal(env.ok, false, name);
    assert.equal(env.kind, 'channel_unavailable', name);
    assert.equal(env.hint, '先 start', name);
  }
  const status = await callTool('proxy_status', {}, deps);
  assert.equal(status.ok, true);
  assert.equal(status.data.core.reachable, false);
  assert.equal(status.data.core.kind, 'channel_unavailable');
  // 订阅 CRUD 刻意不依赖核心：核心没跑时切订阅仍要能写注册表，repo 自己会跳过 reload
  const act = await callTool('proxy_subscription_activate', { uid: 'Rq14DVii2DNo' }, deps);
  assert.equal(act.ok, true);
});

test('未安装时给 not_installed + 安装指引', async () => {
  const { deps } = fakeDeps({ getRuntime: async () => ({ ...RUNTIME, installed: false, configDir: null, running: false }) });
  const e = await callTool('proxy_nodes', {}, deps);
  assert.equal(e.kind, 'not_installed');
  assert.match(e.hint, /安装|QVP_INSTALL_DIR/);
  for (const name of ['proxy_subscriptions', 'proxy_subscription_add', 'proxy_env', 'proxy_toolconfig', 'proxy_diagnose']) {
    // 每个工具都要给到"参数合法"的程度，否则测到的是参数校验而不是未安装分支
    const args = name === 'proxy_subscription_add' ? { url: 'https://x.test/s?token=T' }
      : name === 'proxy_toolconfig' ? { action: 'status' } : {};
    assert.equal((await callTool(name, args, deps)).kind, 'not_installed', name);
  }
});

test('输出全过脱敏：订阅 token 与节点地址不出现', async () => {
  const { deps } = fakeDeps();
  const list = await callTool('proxy_subscriptions', {}, deps);
  assert.doesNotMatch(JSON.stringify(list), /token=T\b(?!<)/);
  const nodes = await callTool('proxy_nodes', {}, deps);
  assert.doesNotMatch(JSON.stringify(nodes), /server|password|uuid/i);
  const diag = await callTool('proxy_diagnose', { targets: ['https://x.test/s?token=SECRET'] }, deps);
  assert.doesNotMatch(JSON.stringify(diag), /SECRET/);
});

test('全链路：fake-mihomo + 沙箱 profiles 跑 nodes/select/test/status', async () => {
  const fake = await startFake({ pipeName: 'qvp-t15-e2e', port: 0, secret: 'set-your-secret' });
  const dir = path.join(os.tmpdir(), `qvp-t15-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const configDir = path.join(dir, 'cvr');
  fs.mkdirSync(path.join(configDir, 'profiles'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'cvr-profiles.yaml'), path.join(configDir, 'profiles.yaml'));
  fs.writeFileSync(path.join(configDir, 'verge.yaml'), 'enable_system_proxy: true\nenable_proxy_guard: true\nverge_mixed_port: 7897\nenable_external_controller: false\n');
  const dirs = store.ensure(store.dirs({ QODER_VPN_PROXY_DATA: path.join(dir, 'data') }));
  const client = new ClashClient(await createTransport({ secret: 'set-your-secret', controller: { pipe: fake.pipeName, tcp: null } }));
  const repo = new SubscriptionRepo({ configDir, dirs, fetchImpl: async () => ({ format: 'yaml', yaml: 'proxies: []\n', nodes: 2, bytes: 10, name: '沙盒', userInfo: null }) });
  const deps = {
    getRuntime: async () => ({ ...RUNTIME, configDir, ports: { mixed: 7897, socks: 7898, http: 7899 } }),
    getClient: async () => client,
    getRepo: async () => repo,
    getCvr: async () => null,
    getToolConfig: async () => ({ status: async () => ({ verdict: 'clean', npmrc: { exists: false, managed: false, proxyLines: [] }, git: { managed: [], mismatch: false, otherHttpKeys: [] } }), apply: async () => ({}), revert: async () => ({}) }),
    getDiagnoseDeps: () => ({ curlRunner: async () => ({ code: 0, stdout: '200 0.1 0.2 1.1.1.1' }) }),
    log: () => {},
  };
  const nodes = await callTool('proxy_nodes', {}, deps);
  assert.equal(nodes.ok, true);
  assert.ok(nodes.data.groups[0].all.includes('HK 3 | v4'));

  const sel = await callTool('proxy_select', { group: '节点选择', target: 'JP 1 | v3' }, deps);
  assert.equal(sel.data.now, 'JP 1 | v3');
  assert.equal(fake.state.proxies['节点选择'].now, 'JP 1 | v3', '真写到了 fake');

  const tested = await callTool('proxy_test', { group: '节点选择' }, deps);
  const dead = tested.data.results.find((r) => r.name === 'dead-node');
  assert.equal(dead.ok, false);
  assert.equal(dead.kind, 'timeout', '坏节点是节点问题，不能被归成通道问题');
  assert.ok(tested.data.results.find((r) => r.name === 'HK 3 | v4').delay > 0);
  assert.ok(tested.data.best === 'TW 2 | v4' || /^[A-Z]/.test(tested.data.best), 'best 排序后有值');

  const add = await callTool('proxy_subscription_add', { url: 'https://sandbox.test/sub?token=ZZZ', name: '沙盒二' }, deps);
  assert.equal(add.ok, true, JSON.stringify(add));
  const subs = await callTool('proxy_subscriptions', {}, deps);
  assert.equal(subs.data.length, 2);
  assert.ok(!JSON.stringify(subs).includes('ZZZ'), '全链路也不泄露 token');

  const status = await callTool('proxy_status', {}, deps);
  assert.equal(status.data.core.channel, 'pipe');
  assert.equal(status.data.core.mode, 'rule');
  assert.equal(status.data.subscription.current.uid, 'Rq14DVii2DNo');

  client.close();
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [x] **Step 5: 实现 tools.js**

`server/tools.js`：

```js
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
      description: '列出插件对 verge.yaml / profiles.yaml 做过的全部带时间戳备份并还原。npm 与 git 的用户级配置走 ToolConfig 的托管块撤销（name=npm|git），因为它们的备份不在 CVR 配置目录里。中途放弃或想把改动全部撤销时用它；CVR 配置还原后与备份逐字节一致。prune=true 时不还原，只按保留期清理备份目录（profiles.yaml 的备份里带着订阅 token，不能无限堆在磁盘上）。',
      inputSchema: obj({
        name: str(CVR_RESTORE_TARGETS, '只还原指定项：verge.yaml / profiles.yaml 走 CVR 备份；npm / git 走托管块移除。省略则还原两个 CVR 配置文件'),
        listOnly: bool('只列备份不还原'),
        prune: bool('清理备份目录而不是还原它；与 name / listOnly 互斥'),
        keepPerName: numSchema('每个配置文件最多保留几份备份，默认 5；最新的份永远保留'),
        olderThanDays: numSchema('超过这么多天的备份删除，默认 14'),
        dryRun: bool('prune 时只报告将要删什么，不真删'),
      }),
      handler: async (a = {}) => {
        if (a.name !== undefined) assertEnum(a.name, CVR_RESTORE_TARGETS, 'name');
        if (a.prune) {
          if (a.name !== undefined || a.listOnly) throw bad('prune 与还原参数不能同时给', 'prune 只清理备份文件；要还原就别带 prune');
          // 先校验参数再碰磁盘：keepPerName:0 若走到删除，等于把整组备份名册读完才发现命令是错的
          const keepPerName = numOr(a.keepPerName, 5, 'keepPerName');
          const olderThanDays = numOr(a.olderThanDays, 14, 'olderThanDays');
          // 清理不依赖 CVR 在跑，也不依赖 rt.configDir —— 带着 token 的旧备份恰恰是核心停着的时候最该清
          return ok(pruneBackupsIn(deps.backupDir, { keepPerName, olderThanDays, dryRun: !!a.dryRun }));
        }
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
```

- [x] **Step 6: 落地与草稿的差异（不需要再做，记在这里免得下一个人以为代码写错了）**

草稿的 Step 5 里两个订阅 handler 用了一个靠 `arguments[0]` 反向取参的 `arguments0()`，本步骤原本是用来拆掉它的。实际写作时**一次到位、没有引入这个 hack**：`add`/`edit` 都显式列字段转发（见上一步的 handler），`const TOOL_NAMES_FROM = buildTools;` 这行也没写。留着本步骤只记录这个结论，代码上没有待办。

其余差异都是"草稿的假想实现"与"落地实现"的差，逐条：

1. **`requireRepo(deps)` 取代三处 `await deps.getRepo()` 的重复空判**。草稿里每个订阅 handler 都要先 `const repo = await deps.getRepo(); if (!repo) throw …`；未装 CVR 的分支被抄了五遍。收成一个助手，`not_installed` 的提示统一带上 `QVP_CONFIG_DIR` 这条出路。
2. **`rejectExtra(args, schema)`**：草稿对多余参数直接忽略，打错一个 `updateInterval` 的拼写会静默走默认值。落地把未知键变成 `malformed_config`，回信里列出该工具接受的参数名。
3. **数值与数组参数走 `numOr`/`numOpt`/`assertArray`**：草稿把 `timeoutMs`、`updateInterval`、`names` 原样透传到底层，非正数或字符串会让底层抛出与代理无关的栈。现在在边界上判，报错文案是"必须是正数"这种能被下一轮工具调用改正的话。
4. **`proxy_select` 先校验 mode/group+target 再 `requireClient`**：草稿先连核心再校验，参数写错时白等一次管道超时（最坏 3 秒），且回信里分不清"没连上"和"没给 target"。
5. **`proxy_toolconfig` 的 schema 声明 `required: ['action']`**：草稿靠 handler 内部判空，`{}` 会走 `status` 分支 —— 一个读操作成了默认值，`action` 打错字时用户以为看到的是当前状态。
6. **`proxy_core_start` 容忍 `(r.backups || [])`**：`cvr-config.js` 在配置目录里没有目标文件时返回的备份数组可能整个缺失，草稿的 `r.backups.map` 会在成功路径上抛 `TypeError`。
7. **订阅 handler 不再返回 `arguments0` 时代的 `{…原始对象}`**：出边界的字段逐个列出，`redactUrl` 因此在每个含 url 的返回值上都有落点。

`node --test test/tools.test.js`
Expected: PASS（9 个测试；草稿这一行写的是 10，落地后 `grep -c "^test(" test/tools.test.js` 就是 9，以代码为准）。`每个工具都能跑通一次` 那条若某个工具回 `ok:false`，多半是假 deps 少提供了方法（对照错误里的工具名补 `fakeDeps`），不要改断言。

**假 deps 反过来暴露的三条实现问题**（这一类 bug 的通用形态：假件比真模块宽容，测试就在验证一个不存在的实现）：

- `fake.cvr.start` 不返回 `backups` → 触发上面第 6 条。补成 `cvr-config.js` 真实的 `{ok, backups, restarted, warnings}` 形状。
- `fake.getClient` 抛的是随手 `new Error()` 再挂 `.kind`/`.hint` → `toEnvelope` 认不出 `ApiError`，落到兜底分支回 `channel_unavailable` + "未预期的错误"，用户看到的提示是空的。改成抛真的 `new ApiError('channel_unavailable', '连不上', '先 start')`；`delay` 同理改成 `ApiError('timeout', …)`，并补一条 `dead.kind === 'timeout'` 断言 —— 坏节点必须被标成超时，`proxy_test` 才排得出序。
- `RUNTIME.channelHint` 写成占位串 → 未安装场景的回信没有可操作性。换成 `discovery.js` 真实产出的那句（`discovery.test.js` 已断言它含"安装"）。

- [x] **Step 7: 实现 index.js（stdio 入口）**

`server/index.js`：

```js
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
const store = require('./store');

const LOG_FILE = 'mcp.log';
const RUNTIME_TTL_MS = 2000;
const DRAIN_GRACE_MS = 15000;

function makeLogger(dirs) {
  let stream = null;
  try { stream = fs.createWriteStream(path.join(dirs.logs, LOG_FILE), { flags: 'a' }); } catch { stream = null; }
  const log = (line) => {
    const text = `[${new Date().toISOString()}] ${String(line)}`.slice(0, 4000);
    if (stream) stream.write(text + '\n');
    try { process.stderr.write(text + '\n'); } catch { /* stderr 被关时忽略 */ }
  };
  // 日志流是 ref 的：不关掉它，stdin 结束后事件循环永不空转，进程挂住不退
  log.close = () => { if (stream) { stream.end(); stream = null; } };
  return log;
}

function buildDeps(dirs, log) {
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

  return {
    backupDir: dirs.backups,
    getRuntime,
    getClient,
    getRepo,
    getCvr,
    getToolConfig,
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
```

`test/index.test.js`（Step 8 的冒烟手跑一次就没了，这两条把同样的检查留在套件里，并且把数据目录、`APPDATA`、`HOME`、安装候选全塞进临时沙箱 —— 否则子进程会去连本机真实管道，测试结论随用户此刻开没开 Clash Verge 而变）：

```js
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'server', 'index.js');

/**
 * 沙箱：数据目录、APPDATA、HOME、安装候选全部指向空的临时目录。
 * 少了这一层，子进程会去连本机真实管道，测试结论随用户此刻开没开 Clash Verge 而变。
 */
function sandboxEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvp-index-'));
  const empty = path.join(root, 'appdata');
  fs.mkdirSync(path.join(empty, 'Home'), { recursive: true });
  return {
    root,
    env: {
      ...process.env,
      QODER_VPN_PROXY_DATA: path.join(root, 'data'),
      APPDATA: empty,
      appdata: empty,
      HOME: path.join(root, 'appdata', 'Home'),
      USERPROFILE: path.join(root, 'appdata', 'Home'),
      QVP_INSTALL_CANDIDATES: path.join(root, 'no-such-install'),
    },
  };
}

function runServer(frames, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.write(frames.join('\n') + '\n');
    child.stdin.end();
  });
}

const FRAMES = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"proxy_status","arguments":{}}}',
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"proxy_subscriptions","arguments":{}}}',
];

test('stdio 冒烟：stdin 关闭后在途请求仍收尾，stdout 只有合法 JSON 帧', async () => {
  const { env } = sandboxEnv();
  const { code, out, err } = await runServer(FRAMES, env);
  assert.equal(code, 0, `退出码 ${code}，stderr: ${err}`);

  const lines = out.trim().split('\n');
  assert.equal(lines.length, 4, `stdout 应恰好 4 帧，实得 ${lines.length}：${out}`);
  // 响应不按请求顺序回来（proxy_status 比 proxy_subscriptions 多做两轮通道探测），
  // JSON-RPC 以 id 配对，客户端本来就该这么读
  const byId = new Map(lines.map((l) => { const m = JSON.parse(l); return [m.id, m]; }));
  assert.deepEqual([...byId.keys()].sort(), [1, 2, 3, 4]);
  assert.equal(byId.get(1).result.serverInfo.name, 'qoder-vpn-proxy');
  assert.equal(byId.get(2).result.tools.length, 17);

  const status = JSON.parse(byId.get(3).result.content[0].text);
  assert.equal(status.ok, true, 'proxy_status 报告状态，核心没跑也必须 ok');
  assert.equal(status.data.installed, false);
  assert.equal(status.data.core.reachable, false);

  const subs = JSON.parse(byId.get(4).result.content[0].text);
  assert.equal(subs.ok, false);
  assert.equal(subs.kind, 'not_installed');

  assert.match(err, /server 启动/);
});

test('每一行 stdout 都能独立解析，说明日志没有混进协议通道', async () => {
  const { env } = sandboxEnv();
  const { out } = await runServer(FRAMES.slice(0, 3), env);
  for (const line of out.trim().split('\n')) {
    assert.match(line, /^\{.*\}$/);
    JSON.parse(line);
  }
});
```

落地 `index.js` 时这一步暴露了一个真 bug，处理记录在 Step 8。

- [x] **Step 8: 端到端跑一次协议（手工冒烟，不需要 CVR 在跑）**

```bash
cd qoder-vpn-proxy && printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"proxy_status","arguments":{}}}' \
 '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"proxy_subscriptions","arguments":{}}}' \
 | node server/index.js 2>/dev/null | node -e "
let b='';process.stdin.on('data',d=>b+=d).on('end',()=>{
  const lines=b.trim().split('\n');
  const byId=new Map(lines.map(l=>{const m=JSON.parse(l);return [m.id,m];}));
  console.log('帧数', lines.length);
  console.log('serverInfo', JSON.stringify(byId.get(1).result.serverInfo));
  console.log('工具数', byId.get(2).result.tools.length);
  const st=JSON.parse(byId.get(3).result.content[0].text);
  console.log('proxy_status ok=',st.ok,'running=',st.data.running,'installed=',st.data.installed,'core.reachable=',st.data.core.reachable);
  const subs=JSON.parse(byId.get(4).result.content[0].text);
  console.log('subscriptions ok=',subs.ok,'count=',subs.data&&subs.data.length);
  console.log('stdout 全为合法 JSON:', lines.every(l=>{try{JSON.parse(l);return true}catch{return false}}));
})"
```

Expected: `帧数 4`、`工具数 17`、`proxy_status ok= true installed= true`；`running` 取决于用户此刻是否开着 Clash Verge（两种都算通过，因为 `proxy_status` 的例外约定）。**stdout 必须是 4 行合法 JSON、没有任何日志混入** —— 这一步就是验证那一条硬约束。

按 `id` 取帧而不是按 `ms[2]/ms[3]` 的位置取：草稿假定响应按请求顺序回来，实测不成立 —— `proxy_status` 要在 `getRepo()` 之前多跑一轮通道探测，`proxy_subscriptions` 先回。JSON-RPC 以 id 配对，客户端本来就该这么读；服务端不为此加串行队列，因为一条 `proxy_diagnose` 能占住几十秒，排队会让 `proxy_status` 陪着卡住。**代价**：并发调用理论上能交错两次配置写；写路径本身有备份与原子改名，最后写入者胜，不产生半写文件，Task 17 的真机验收按顺序单条调用，不会撞到这个窗口。

**实测（本机真跑，CVR 未运行）**：第一次 `帧数 2` —— 只回了 `initialize` 与 `tools/list`，两条 `tools/call` 消失。原因不是工具报错，是 `main()` 里 `stdin.on('end', () => process.exit(0))`：客户端一旦关 stdin 就立刻退出，把在途请求连响应一起杀掉。真 MCP 客户端不会关 stdin，所以这个 bug 只被冒烟暴露；但关 stdin 与"请求已处理完"没有必然关系，得改。落地改成：`pending` 计数归零后才收尾，且退出前用 `process.stdout.write('', cb)` 等缓冲冲干净（直接 `process.exit` 会把最后一帧截断），同时关掉日志文件流（不然那个 ref 会让事件循环永不空转、进程挂住不退），再加 15 秒强制上限兜住"在途工具自己有更长超时"的情形。

改完后：`帧数 4`、`工具数 17`、`proxy_status ok= true running= false installed= true core.reachable= false`、`subscriptions ok= true count= 1`（`count=1` 是本机 `profiles.yaml` 里那条 `remote` 订阅，与 spec §2 的盘点一致）、`stdout 全为合法 JSON: true`。沙箱版同样检查已经固化成 `test/index.test.js` 的两条，回归不会再靠手跑。

- [x] **Step 9: 全量测试与提交**

```bash
node --test
git add qoder-vpn-proxy/server qoder-vpn-proxy/test
git commit -m "feat: MCP stdio 服务端与 17 个工具接线"
```

Expected: `# tests 144`（Task 14 收尾时 125，本任务净增 19：protocol 8 + tools 9 + index 2），`# fail 0`。提交前跑一次凭据 grep：`grep -rnE "123adsas|BGqmX0c|62ffcf3f|fgzvArRr|南山云" qoder-vpn-proxy/` 必须无输出。

---

### Task 16: 打包成 Qoder 插件并安装

**已核实的插件布局**（读取本机 3 个已装插件得到，不是猜的）：
- 清单在 `.qoder-plugin/plugin.json`（**点目录**，不是根级 `plugin.json`；根级 `plugin.json` 是上游仓库自带的）
- MCP 声明文件名为 **`.mcp.json`**（根级，隐藏名），清单用 `"mcpServers": "./.mcp.json"` 指向它
- 路径变量 `${QODER_PLUGIN_ROOT}` 在 `.mcp.json` 与 `hooks/hooks.json` 里都可用；`${QODER_NODE_RUNTIME}` 指向 Qoder 自带 node
- 注册表 `~/.qoder/plugins/installed_plugins_v2.json` 形如 `{"version":2,"plugins":{"<name>@<source>":[{scope,installPath,version,installedAt,lastUpdated,displayName}]}}`；`~/.qoder/settings.json` 的 `enabledPlugins` 用同样的 `<name>@<source>` 作键
- 现存 source 只有 `qoder-marketplace` 与 `qoderapp-bundler`，**没有本地安装的先例** —— `@local` 这条能否被加载必须靠重启验证

**Files:**
- Create: `qoder-vpn-proxy/.qoder-plugin/plugin.json`
- Create: `qoder-vpn-proxy/.mcp.json`
- Create: `qoder-vpn-proxy/hooks/hooks.json`
- Create: `qoder-vpn-proxy/hooks/run-hook.cmd`
- Create: `qoder-vpn-proxy/hooks/session-start`
- Create: `qoder-vpn-proxy/server/session-start.js`
- Create: `qoder-vpn-proxy/skills/vpn-proxy/SKILL.md`
- Create: `qoder-vpn-proxy/README.md`
- Test: `qoder-vpn-proxy/test/session-start.test.js`（Step 3 给出内容）
- Modify: `~/.qoder/plugins/installed_plugins_v2.json`、`~/.qoder/settings.json`（Step 7，先备份）

**Interfaces:**
- Consumes: `server/index.js`（MCP 入口）、`server/session-start.js`（hook 入口）
- Produces: 一个被 Qoder 加载的插件，工具名前缀实测为 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__*`（不是最初预测的 `mcp__vpn-proxy__*`；名字里带了 source 与插件名两段，给模型看的文案必须照 `mcp_list` 的输出抄）

- [x] **Step 1: 写 `.qoder-plugin/plugin.json`**

```json
{
  "name": "qoder-vpn-proxy",
  "displayName": "VPN 代理助手",
  "version": "0.1.0",
  "description": "Detect and drive the local Clash Verge Rev / mihomo proxy: status, node selection, latency test, subscription CRUD, and per-tool proxy wiring for this session's npm/git/pip toolchain without touching the system proxy.",
  "descriptionZh": "识别并驱动本机 Clash Verge Rev / mihomo 代理：状态探测、节点选择与测速、订阅增删改、按工具写入代理配置。默认只影响 Qoder 会话内的命令行工具，不改系统代理与 TUN。",
  "author": { "name": "Administrator" },
  "license": "MIT",
  "category": "Developer Tools",
  "keywords": ["proxy", "clash-verge", "mihomo", "vpn", "subscription", "network"],
  "tags": ["proxy", "network", "mcp"],
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/hooks.json",
  "skills": "./skills/"
}
```

Run: `node -e "JSON.parse(require('fs').readFileSync('.qoder-plugin/plugin.json','utf8')); console.log('plugin.json 合法')"`

- [x] **Step 2: 写 `.mcp.json`（用 Qoder 自带 runtime，不写死 node 路径）**

```json
{
  "mcpServers": {
    "vpn-proxy": {
      "type": "stdio",
      "command": "${QODER_NODE_RUNTIME}",
      "args": ["${QODER_PLUGIN_ROOT}/server/index.js"],
      "timeout": 60000
    }
  }
}
```

Expected: 17 个工具出现在 `mcp_list` 结果里；实测前缀是 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__`（初稿写的 `mcp__vpn-proxy__` 是猜的，Qoder 会把插件 source 和插件名两段都拼进工具名）。

若 Qoder 不解析 `${QODER_NODE_RUNTIME}`（服务起不来、工具列表为空），把 `command` 改成 `"node"` 再验证一次；本机 Node v22.23.3 在 PATH 上。两种写法的实际生效情况记进 `docs/superpowers/probes/03-plugin-install.md`。

- [x] **Step 3: 写 `server/session-start.js`（探到代理可连才提示）**

```js
'use strict';
const { discover, probeTcp } = require('./discovery');
const { buildProxyEnv, inlinePrefix } = require('./env');

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: additionalContext || '' },
  }));
}

async function main() {
  try {
    const rt = await discover();
    if (!rt.installed || !rt.ports.mixed) return emit('');
    const alive = await probeTcp({ host: '127.0.0.1', port: rt.ports.mixed, timeoutMs: 600 });
    if (!alive) return emit('');
    const env = buildProxyEnv({ mixedPort: rt.ports.mixed, socksPort: rt.ports.socks || undefined });
    const ctx = [
      `本机 Clash Verge 代理端口 127.0.0.1:${rt.ports.mixed} 当前可连通（插件 qoder-vpn-proxy 检测）。`,
      `直连失败时，联网命令请加前缀：${inlinePrefix(env)}`,
      `npm/git 想长期走代理用 mcp__plugin_qoder-vpn-proxy_vpn-proxy__proxy_toolconfig(action=apply)；哪些域名真需要代理用 mcp__plugin_qoder-vpn-proxy_vpn-proxy__proxy_diagnose 判定。`,
      `注意：系统代理未开启，本提示只影响命令行工具；Qoder 自身请求建议保持直连。`,
    ].join(' ');
    return emit(ctx);
  } catch {
    return emit('');
  }
}

main();
```

Run: `node server/session-start.js`
Expected: 打印一个含 `hookSpecificOutput` 的 JSON 对象。CVR 未运行时应打印 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}`（空串 = 不注入；验收 9 靠这条）。

**实测**（本机真跑，CVR 未运行）：`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}`，与预期逐字一致。

这条只测到了"没装/没跑"的一支，而验收 9 依赖的正是"什么时候不该注入"。补 `test/session-start.test.js` 三条，把 hook 当子进程跑（`discover()` 读的是 `process.env`，所以沙箱靠 `QVP_CONFIG_DIR` / `QVP_INSTALL_CANDIDATES` / `APPDATA` / `HOME` 注入，不碰本机真配置）：

```js
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'server', 'session-start.js');
const LAUNCHER = path.join(__dirname, '..', 'hooks', 'run-hook.cmd');

/** 沙箱里造一个"装了 CVR 且 runtime 端口写在 config.yaml"的配置目录 */
function sandbox({ mixedPort }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvp-hook-'));
  const configDir = path.join(root, 'clash-verge');
  const installDir = path.join(root, 'program');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), `mixed-port: ${mixedPort}\nmode: rule\nsecret: set-your-secret\n`);
  fs.writeFileSync(path.join(configDir, 'verge.yaml'), `enable_system_proxy: false\nenable_tun_mode: false\nenable_external_controller: false\n`);
  fs.writeFileSync(path.join(configDir, 'profiles.yaml'), `# 空清单\n`);
  fs.writeFileSync(path.join(installDir, 'clash-verge.exe'), '');
  return {
    root,
    env: {
      ...process.env,
      APPDATA: root,
      appdata: root,
      HOME: path.join(root, 'Home'),
      USERPROFILE: path.join(root, 'Home'),
      QVP_CONFIG_DIR: configDir,
      QVP_INSTALL_CANDIDATES: installDir,
    },
  };
}

function runHook(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end('{}');
  });
}

/** 占住一个真实端口，返回端口号；stop() 释放 */
async function occupy() {
  const server = net.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  return { port, stop: () => new Promise((res) => server.close(res)) };
}

test('hook 契约：stdout 永远是单个带 hookEventName 的 JSON 对象，未安装时 additionalContext 为空串', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvp-hook-bare-'));
  const env = {
    ...process.env,
    APPDATA: root,
    appdata: root,
    HOME: path.join(root, 'Home'),
    USERPROFILE: path.join(root, 'Home'),
    QVP_INSTALL_CANDIDATES: path.join(root, 'no-such-dir'),
  };
  const { code, out } = await runHook(env);
  assert.equal(code, 0);
  const msg = JSON.parse(out);
  assert.equal(Object.keys(msg).join(), 'hookSpecificOutput');
  assert.equal(msg.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(msg.hookSpecificOutput.additionalContext, '', '验收 9：没装 CVR 时不注入任何文本');
});

test('端口可连通才提示，给出内联前缀与工具名而不是凭记忆写端口', async () => {
  const { port, stop } = await occupy();
  try {
    const { env } = sandbox({ mixedPort: port });
    const { out } = await runHook(env);
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.ok(ctx.length > 0, '端口在听，应该给出提示');
    assert.match(ctx, new RegExp(`127\\.0\\.0\\.1:${port}`), '端口来自探测结果');
    assert.match(ctx, /HTTP_PROXY=http:\/\/127\.0\.0\.1:/);
    assert.match(ctx, /mcp__plugin_qoder-vpn-proxy_vpn-proxy__proxy_diagnose/, '工具全名要能直接被模型调用');
    assert.doesNotMatch(ctx, /7897/, '不能出现写死的默认端口');
  } finally {
    await stop();
  }
});

test('装了 CVR 但代理端口没在听时不提示（避免让用户照着前缀撞上拒绝）', async () => {
  const { port, stop } = await occupy();
  await stop();
  const { env } = sandbox({ mixedPort: port });
  const { out } = await runHook(env);
  assert.equal(JSON.parse(out).hookSpecificOutput.additionalContext, '');
});

test('run-hook.cmd 必须纯 ASCII：cmd.exe 按 GBK 码页读批处理，中文注释会让它错行到 exit 255', async () => {
  const buf = fs.readFileSync(LAUNCHER);
  const bad = [];
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] > 0x7f) bad.push({ i, byte: buf[i], line: buf.subarray(0, i).toString('latin1').split('\n').length });
  }
  assert.deepEqual(bad.slice(0, 3), [], `发现 ${bad.length} 个非 ASCII 字节，首个在第 ${bad[0] && bad[0].line} 行`);
});
```

Run: `node --test test/session-start.test.js`
Expected: PASS（初稿 3 个测试；真机出缺陷 6 之后加了第四条"launcher 纯 ASCII"，现在 4 个）。第二条会真的起一个监听端口再让 hook 去探 —— hook 的价值就在"只在能连时说话"，用假返回值测它等于没测。第四条守的是上一条段落里那个把整个 hook 打崩的坑。

- [x] **Step 4: 写 hook 包装（cmd/bash 双语种 + `hooks.json`）**

`hooks/run-hook.cmd`（沿用已验证的 superpowers 双语种写法：首行 `: << 'CMDBLOCK'` 让 bash 把批处理段当 heredoc 吞掉，cmd.exe 则顺序执行到 `exit /b` 就停。**批处理段只能写 ASCII**，理由见下面那段事故记录）：

```bat
: << 'CMDBLOCK'
@echo off
REM Cross-platform polyglot wrapper for hook scripts.
REM On Windows: cmd.exe runs the batch portion, which finds bash and delegates.
REM On Unix: the shell reads this as a script (: is a no-op in bash).
REM
REM KEEP THIS FILE PURE ASCII. cmd.exe reads the batch portion under the OEM
REM codepage (GBK on this machine); multi-byte UTF-8 comments desynchronize its
REM line parser and the hook dies with exit 255 before node ever runs.
REM
REM Usage: run-hook.cmd <script-name> [args...]

if "%~1"=="" (
    echo run-hook.cmd: missing script name >&2
    exit /b 1
)

set "HOOK_DIR=%~dp0"

if exist "C:\Program Files\Git\bin\bash.exe" (
    "C:\Program Files\Git\bin\bash.exe" "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)
if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    "C:\Program Files (x86)\Git\bin\bash.exe" "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)

where bash >nul 2>nul
if %ERRORLEVEL% equ 0 (
    bash "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
    exit /b %ERRORLEVEL%
)

REM No bash found - exit silently rather than error
REM (plugin still works, just without SessionStart context injection)
exit /b 0
CMDBLOCK

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="$1"
shift
exec bash "${SCRIPT_DIR}/${SCRIPT_NAME}" "$@"
```

草稿这一段写的是 `node "%~dp0\..\server\index.js" %* >nul 2>&1` —— **照抄会把 MCP 服务端当 hook 跑**：`index.js` 起来等 stdin、往 stdout 吐 JSON-RPC，hook 却在等一个 `hookSpecificOutput` 对象；`>nul` 还会把它冲掉，表现是"插件装了但开场提示永远不出现"，而且每次会话多挂一个空转的 node 进程，直到 5 秒超时被杀。落地按 superpowers 6.3.0 里已在跑的 wrapper 来：cmd 段只负责**找到 bash**（Git for Windows 标准路径 → PATH 上的 bash），然后调用同目录下与参数同名的 hook 脚本；三条都没命中时 `exit /b 0` 静默放行（没有 bash 的机器上 MCP 工具照常可用，只是没有开场提示）。

**这段 wrapper 的注释最初是中文写的，真机上把整个 hook 弄崩了（缺陷 6）**。cmd.exe 按当前 **OEM 码页**（本机 GBK/936）读批处理文件，UTF-8 中文注释被当成双字节序列切分，行首字节偏移从此错位，后面每一行都从中间开始解析 —— Qoder 日志里表现为 `hook.finished success=false exit_code=255`，stderr 是"文件名、目录名或卷标语法不正确"，`node server/session-start.js` 从未被执行。同一次启动里 superpowers 那份**命令串完全相同**的 launcher 却 exit 0，逐字节对比后唯一差异就是注释语言。把 Qoder 的调用形态抄成一个最小脚本（`bash -c '"<root>\hooks/run-hook.cmd" session-start'`）就能稳定复现，不必依赖真重启。修复后新增一条测试守住它：`test/session-start.test.js` 断言 launcher **零个非 ASCII 字节**。结论写进文件头注释里了 —— 解释性中文要放就放 bash 段或 README，批处理段只能是 ASCII。

另外在仓库根加 `.gitattributes`（`* text eol=lf`）。本机 `core.autocrlf=true`，没有这一行 checkout 出来的 hook 脚本就是 CRLF：`<< 'CMDBLOCK'` 的结束标记带上 `\r` 便匹配不上，整个文件被当 heredoc 吞掉，bash 段一行都不执行 —— 表现只是"开场提示没出现"，没有任何报错可看。已装好的 superpowers 6.3.0 那份 `run-hook.cmd` 实测是纯 LF（0 个 CRLF / 46 个 LF），说明这就是 Qoder 在 Windows 上跑这份 wrapper 的行尾。同理 LF 也是 `test/fixtures/cvr-*.yaml` 与备份一致性校验的前提，那些地方是逐字节比较。

`hooks/session-start`：

```bash
#!/usr/bin/env bash
# 由 run-hook.cmd 调起；真正的判断在 server/session-start.js 里
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${SCRIPT_DIR}/../server/session-start.js" "$@"
```

`hooks/hooks.json`：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${QODER_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "async": false,
            "shell": "bash",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

`timeout: 5` 是刻意的：hook 在每次会话启动时同步执行，一次 TCP 探活最多几百毫秒；超过 5 秒说明机器有问题，不如不注入提示。**不要**把 `enable_external_controller` 之类改动放进 hook。

- [x] **Step 5: 写 `skills/vpn-proxy/SKILL.md`**

必须含以下段落（内容按 spec §3.4 与 §4 的错误表写，禁止空洞）：

```markdown
---
name: vpn-proxy
description: 识别并使用本机 Clash Verge Rev 代理。当直连超时（github.com、raw.githubusercontent.com）、需要装 npm 包或克隆私有仓库、要查看/切换代理节点、更新订阅、或诊断"该不该走代理"时使用。
---

# 本机 VPN 代理

## 什么时候用哪个工具

| 情形 | 动作 |
|---|---|
| 命令直连超时，想确认是不是需要代理 | `proxy_diagnose`（不要凭记忆判断端口） |
| 要让本会话后续 npm/git 命令自动走代理 | `proxy_toolconfig action=apply` |
| 只想给这一条命令加代理 | `proxy_env target=shell` 拿内联前缀 |
| Clash Verge 没在跑 | `proxy_core_start`（默认 scope=session，不改系统代理） |
| 节点慢 | `proxy_test` 排序，再 `proxy_select` 换最快节点 |
| 机场换链接 / 轮换 token | `proxy_subscription_edit` |
| 加第二个机场 | `proxy_subscription_add` + 需要时 `activate` |

## 边界（不要越界）

- **不改系统代理、不开 TUN、不写注册表**。浏览器和游戏不受影响，这是设计前提，不是副作用。
- **不要让 Qoder 自己的请求走代理**。`proxy_diagnose` 若显示 `Qoder 直连更快`，保持 `HTTPS_PROXY` 不设置。
- 会话结束前若用了 `proxy_toolconfig apply`，提醒用户可 `action=revert` 还原；不要静默留着。
- 订阅 URL 含 token。所有输出里 token 已被脱敏，**不要**在回复里复述原始链接。

## 失败怎么读

`kind` 的 13 种取值与对应动作见 `hint` 字段。特别注意：
- `channel_unavailable` → 先 `proxy_core_start`；仍然不行则**先征得用户同意**再调 `proxy_core_start(enableExternalControl: true)`（这是 spec 刻意的设计：开启外部控制不单独成工具，只在用户确认后由启动工具顺带完成）。
- `profile_registry_desync` → Clash Verge 运行中会回写 `profiles.yaml`。先 `proxy_core_stop` 再重试订阅操作。
- `subscription_format_unexpected` → 机场按 UA 分流，或链接已失效；不是插件的 bug。
```

- [x] **Step 6: 写 `README.md`**

至少包含：安装位置与依赖（Clash Verge Rev 已装 + Node ≥ 18）、17 个工具清单表、`scope=session` 与 `scope=global` 的差别、`proxy_toolconfig` 会改哪两个用户级文件如何还原、数据目录 `~/.qoder/vpn-proxy/` 里有什么（`subscriptions.json` / `backups` / `.trash` / `logs/mcp.log`）、如何完全卸载（关插件 + 删数据目录 + `proxy_toolconfig action=revert`）。

落地时补两条草稿没点名但属于设计前提的内容，并核了两处事实：

- 开篇加 **"它不会碰什么"**：不改系统代理、不开 TUN、不写注册表，因此浏览器与游戏不受影响；只连 `127.0.0.1` 与本机命名管道；token 恒为 `<redacted>`，`proxy_nodes` 只回节点名。这条是用户最初提的问题（"会不会影响浏览器和游戏"）的正面回答，藏在 spec 里没人会去翻。
- 卸载最后一步给**可复核的命令**而不是"确认已还原"：`git config --global --get-regexp 'http\..*\.proxy'` 应为空、`~/.npmrc` 里不应再有 `# >>> qoder-vpn-proxy >>>`。
- npmrc 托管块的标记串从 `toolconfig.js` 的 `MARK_BEGIN` / `MARK_END` 抄来（`# >>> qoder-vpn-proxy >>> (由 proxy_toolconfig 维护，请勿手工编辑此块)` / `# <<< qoder-vpn-proxy <<<`），不是凭印象写的 `begin/end`；顺带核实了 revert 在"文件本来就是我们创建的"时会删文件而不留空文件。
- 17 行工具表用脚本对过：`TOOL_NAMES` 里每个名字都在表里出现，`SKILL.md` 引用的 9 个名字都在 `TOOL_NAMES` 里 —— 文档与代码的漂移靠这条检查拦，不靠重读。

Run: `node -e "JSON.parse(require('fs').readFileSync('.qoder-plugin/plugin.json','utf8')); JSON.parse(require('fs').readFileSync('.mcp.json','utf8')); JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8'))"`
Expected: 三个清单都能解析。三个 JSON 里只会有插件自身的名字与路径，不该出现订阅地址或 token。

- [x] **Step 7: 安装注册（先备份两个 JSON，再改）**

**这一步会改动 Qoder 自己的配置，属于全局影响面，动手前向用户确认。**

```bash
Q="$HOME/.qoder"
cp "$Q/plugins/installed_plugins_v2.json" "$Q/plugins/installed_plugins_v2.json.qvp-bak"
cp "$Q/settings.json" "$Q/settings.json.qvp-bak"
mkdir -p "$Q/plugins/cache/local/qoder-vpn-proxy"
rm -rf "$Q/plugins/cache/local/qoder-vpn-proxy/0.1.0"
cp -r qoder-vpn-proxy "$Q/plugins/cache/local/qoder-vpn-proxy/0.1.0"
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const q=path.join(os.homedir(),".qoder");
const regFile=path.join(q,"plugins","installed_plugins_v2.json");
const reg=JSON.parse(fs.readFileSync(regFile,"utf8"));
const key="qoder-vpn-proxy@local";
const now=new Date().toISOString();
reg.plugins[key]=[{scope:"user",installPath:path.join(q,"plugins","cache","local","qoder-vpn-proxy","0.1.0"),version:"0.1.0",installedAt:now,lastUpdated:now,displayName:"VPN 代理助手"}];
fs.writeFileSync(regFile,JSON.stringify(reg,null,2));
const setFile=path.join(q,"settings.json");
const set=JSON.parse(fs.readFileSync(setFile,"utf8"));
set.enabledPlugins[key]=true;
fs.writeFileSync(setFile,JSON.stringify(set,null,2));
console.log("registered",key);
'
node -e "const r=require(process.env.HOME+'/.qoder/plugins/installed_plugins_v2.json');console.log('registry 有 qoder-vpn-proxy@local:',!!r.plugins['qoder-vpn-proxy@local'])"
node -e "const s=require(process.env.USERPROFILE+'/.qoder/settings.json');console.log('enabled:',s.enabledPlugins['qoder-vpn-proxy@local'])"
```

Expected: 三行都打回 true。若 Qoder 重启后拒绝加载（工具列表里没有出现 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__*`），把 registry 条目键换成已验证过的 source 形态再试一次；仍不行则**回退到 Step 8**，不要反复改 Qoder 的配置。

- [ ] **Step 8: 回退路径 —— 只注册 MCP server**

  > **未触发，故意留空**：Step 7 的完整注册已成功（`installed_plugins_v2.json` 与 `settings.json` 两处都写进去了，见 `probes/03-plugin-install.md`），所以这条"只注册 MCP server"的退路没有被启用。前置检查跑过了：`~/.qoder/mcp.json` 确实不存在。若重启后 `@local` 插件加载失败，这条才是第一条要走的退路。

```bash
node -e "const fs=require('fs'),os=require('os');console.log(fs.existsSync(require('path').join(os.homedir(),'.qoder','mcp.json')))"
```

Expected: `false`（本机确认过没有该文件）。这条回退路线**不承诺**能加载 hook 与 skill，只保证 17 个 MCP 工具可用；启用前用 `mcp-config` skill 落文件，别手改 `settings.json` 的 `mcpServers`（那里现有条目全是 `type:"http"`，stdio 形态未被验证）。同时把 Step 7 写的两个键删回去，避免两份注册同时生效。

- [x] **Step 9: 提交插件包**

```bash
git add qoder-vpn-proxy
git commit -m "feat: 插件清单/.mcp.json/SessionStart hook/skill/README 并注册到 Qoder"
```

---

### Task 17: 真实环境端到端与验收

**插件的 hook 与 skill 需要重启 Qoder 才生效，而重启会结束当前会话。本任务分两段：重启前能做的自动化验证，和重启后才能做的验收。**

- [x] **Step 1: 取得用户许可，启动 CVR 做真实链路**

说明清楚：这一步会真实启动 Clash Verge；插件用 `scope=session` 压制系统代理，所以浏览器与游戏不受影响；验证结束会 `proxy_core_stop` 并还原配置。

- [x] **Step 2: 逐工具真实验证（17 个都过一遍）**

```
proxy_status → 记下端口、通道、mode
proxy_detect → 确认 7897 可连、9097 不可连（与 spec §2 一致）
proxy_nodes  → 组名与节点名应与 GUI 一致
proxy_test   → 至少 1 个节点通，dead 节点标 ok:false
proxy_select → 切一个节点，GUI 里肉眼确认同步变了
proxy_status → mode/选中节点应反映切换结果
proxy_env    → 复制 inline 前缀，手动跑 curl 验证
proxy_diagnose → 见 Step 3
proxy_subscriptions → 应列出「南山云」
proxy_subscription_add/update/edit/activate/remove → 见 Step 5
proxy_toolconfig → apply / status / revert 三步，见 Step 4
proxy_core_stop → 见 Step 7
```

Expected: 无一个工具抛非预期异常；返回体全部是 `{ok:...}` 两态。

- [x] **Step 3: 验收 1 —— github 从直连超时变成经代理 200，且系统代理仍关闭**

```bash
cd qoder-vpn-proxy && node -e "
const {runDiagnose}=require('./server/diagnose');
const {discover}=require('./server/discovery');
(async()=>{
 const r=await runDiagnose({proxyUrl:'http://127.0.0.1:'+(await discover()).ports.mixed, portAlive:true});
 for (const x of r.rows) console.log(x.label.padEnd(14), x.direct.ok?'直连OK ':'直连FAIL', '|', x.proxied==='skipped'?'skipped':(x.proxied.ok?'代理OK ':'代理FAIL'), x.direct.totalMs+'/'+(x.proxied==='skipped'?'-':x.proxied.totalMs)+'ms', '::', x.conclusion);
 console.log('verdict:',r.verdict);
})()"
cmd //c "reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings //v ProxyEnable" 2>/dev/null || echo "ProxyEnable 项不存在 = 系统代理关闭"
```

Expected: GitHub 两行 `直连FAIL / 代理OK`；PyPI/npm/Qoder 直连 OK；末行显示系统代理关闭（ProxyEnable 不存在或为 0）。**这是验收 1 + 3 的证据**，把原始输出贴进 `docs/superpowers/verification/2026-09-30-acceptance.md`。

- [x] **Step 4: 验收 2 + 6 —— 不加前缀也让 git/npm 走代理，然后干净还原**

```bash
cd qoder-vpn-proxy && node -e "
(async()=>{
 const {ToolConfig}=require('./server/toolconfig');
 const {discover}=require('./server/discovery');
 const rt=await discover();
 const tc=new ToolConfig({backupDir:require('./server/store').dirs().backups});
 console.log('apply', JSON.stringify(await tc.apply({proxyUrl:'http://127.0.0.1:'+rt.ports.mixed, noproxy:'localhost,127.0.0.1'}),null,1));
 console.log('status', JSON.stringify(await tc.status({expectedProxyUrl:'http://127.0.0.1:'+rt.ports.mixed})));
})()"
# 不带任何前缀，直接跑：
git ls-remote https://github.com/sindresorhus/got HEAD
npm view react dist-tags --registry=https://registry.npmjs.org
```

Expected: `git ls-remote` 与 `npm view` 都成功（此前直连是超时）。然后还原并验证：

```bash
cd qoder-vpn-proxy && node -e "
(async()=>{const {ToolConfig}=require('./server/toolconfig');const tc=new ToolConfig({backupDir:require('./server/store').dirs().backups});
console.log(await tc.revert({}));
console.log(await tc.status({}));})()"
git config --global --get-regexp '^http\.' || echo "git http.* 已清空"
cmd //c "reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings //v ProxyEnable" 2>/dev/null || echo "系统代理仍关闭"
```

Expected: `verdict:'clean'`、`git http.* 已清空`、`~/.npmrc` 与备份逐字节一致。**这是验收 6**。

- [x] **Step 5: 验收 5 —— 订阅自主维护，并把「南山云」换成新链接**

```
proxy_subscription_add {url: 新链接, name: "南山云(新)", remark: "2026-09-30 换地址"}
proxy_subscriptions      → 应看到两条，token 全是 <redacted>
proxy_subscription_update {uid: 新条目}  → 节点数、流量余量刷新
proxy_subscription_activate {uid: 新条目} → GUI 里肉眼确认当前订阅变了、节点列表变了
proxy_nodes               → 组名应与新配置一致
proxy_subscription_edit {uid: 旧 Rq14DVii2DNo, remark: "已停用"}   → 只改备注不动内容
proxy_subscription_remove {uid: 新条目, force: false}  → 应报 subscription_active_protected
proxy_subscription_remove {uid: 旧条目}                 → 成功，profiles.yaml 少一项
```

Expected: 每一步都是 `{ok:true}`；删除后 `~/.qoder/vpn-proxy/.trash/` 里能看到被移走的 profile 文件，手工放回即可撤销。**若出现 `profile_registry_desync`，说明 spec §4 记录的 CVR 内存态回写确实存在** —— 此时改为"先 `proxy_core_stop` 再做订阅操作，最后 `proxy_core_start`"，并把这条结论写回 spec §8 与本计划。

- [x] **Step 6: 验收 7 —— 全程无凭据泄露**

```bash
grep -r -I -E 'token=[0-9a-f]{16,}|62ffcf3f' ~/.qoder/vpn-proxy/ qoder-vpn-proxy/ 2>/dev/null | grep - -v 'profiles.yaml' || echo "插件侧无明文 token"
grep -c -E '62ffcf3f' ~/.qoder/vpn-proxy/logs/mcp.log 2>/dev/null || echo "日志 0 命中"
```

Expected: 插件数据目录、日志、测试 fixture、仓库源码里都查不到真实 token；只有 CVR 自己的 `profiles.yaml` 允许保存原值（那是它的工作文件）。**这是验收 7**；若日志命中，立刻定位是哪一层没走 `redactText` 并补测试。

- [x] **Step 7: 验收 8 —— 配置逐字节还原**

```bash
cd qoder-vpn-proxy && node -e "
(async()=>{const {CvrConfig}=require('./server/cvr-config');const {dirs,ensure}=require('./server/store');
const d=ensure(dirs());const rt=await require('./server/discovery').discover();
const cvr=new CvrConfig({configDir:rt.configDir,backupDir:d.backups,exePath:rt.exePath});
const bs=cvr.listBackups(); console.log(bs.map(b=>b.name+' '+b.ts).join('\n'));
console.log('最近一次备份 vs 当前文件:');
const crypto=require('crypto'),fs=require('fs');
const h=(x)=>crypto.createHash('sha256').update(fs.readFileSync(x)).digest('hex').slice(0,16);
for(const b of bs.slice(0,2)) console.log(b.name, h(b.backupPath)===h(require('path').join(rt.configDir,b.name))?'一致':'不同(将还原)');
})()"
```

然后 `proxy_restore_config`，再跑一次哈希对比。**Expected: 全部"一致" —— 这是验收 8**。

- [x] **Step 8: 收尾（proxy_core_stop + 现场核对）**

```bash
cd qoder-vpn-proxy && node -e "
(async()=>{const {CvrConfig}=require('./server/cvr-config');const {dirs,ensure}=require('./server/store');
const d=ensure(dirs());const rt=await require('./server/discovery').discover();
console.log(await new CvrConfig({configDir:rt.configDir,backupDir:d.backups,exePath:rt.exePath}).stop({restore:true}));})()"
tasklist | grep -i -E 'clash-verge|verge-mihomo' || echo "进程已退出"
netstat -ano -p tcp | grep -E ':(7897|9097)\b' || echo "端口已释放"
cmd //c "reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings //v ProxyEnable" 2>/dev/null || echo "系统代理关闭"
```

Expected: 三项都干净。

- [ ] **Step 9: 请用户重启 Qoder，完成验收 4 与 9**

这一步只能由用户做（重启会中断当前会话）。请用户重启后确认两件事：

1. **验收 4**：新开对话里 17 个工具可见（**实测前缀 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__`**）；在 Clash Verge 关闭的状态下调用 `proxy_nodes` / `proxy_test`，返回 `core_not_running`/`channel_unavailable` + 修复提示而不是崩或超时挂起。**实测结果：达成**，但同时暴露缺陷 5（`installed:false`）与缺陷 7（文案工具名错）。
2. **验收 9**：CVR 未运行时，新会话开头**看不到**任何代理相关的 `additionalContext`（本会话最开头那段 "Workspace search routing" 是别的插件注入的，代理提示应该完全没有）；启动 CVR 后的新会话才应出现"本机代理端口可连通"这段提示。**实测结果：现象符合但当时不构成证据** —— 日志显示 hook 被 Qoder 调用了却 `exit_code=255`（缺陷 6：中文注释崩掉 cmd.exe 批处理解析），`node` 从未执行，所以"没注入"既可能是判断正确也可能是进程根本没跑起来。**最终结果：闭环，且不必第三次重启。** 修复后用 `mcp__builtin__create_chat_session` 拉起全新 Qoder 会话（`startup` 命中 matcher）复验两条分支：核心在跑时（15:15）新会话逐字引用到注入原文、工具名是可调用的全名；核心停掉后（15:16）新会话明确回答"没有"，并逐块排除了静态工具注册表、技能清单、跨会话记忆这三处会混淆判断的来源。

把用户反馈逐字记进验收文档。若 hook 没生效，按 probe 文档 `02-hooks.md` 的结论排查顺序：`hooks.json` 是否被读到 → `run-hook.cmd` 在 bash 下能否跑通 `node server/session-start.js` → 5 秒内是否退出。**再加两条本轮学到的**：先看 `~/.qoder/logs/latest/qodercli.log` 里的 `hook.started` / `hook.finished`（能区分"没调用"和"调用即崩"，`stderr` 也在同一条日志里）；以及 launcher 必须是纯 ASCII。

- [x] **Step 10: 写验收文档并提交**

`docs/superpowers/verification/2026-09-30-acceptance.md`：9 条验收逐条列"证据（原始命令输出）/ 结论 / 遗留问题"。spec §8 的 6 条未验证项必须有明确答案（管道是否可用、PreToolUse 是否支持 updatedInput、CVR 是否覆盖 profiles.yaml、新链接节点集合、Qoder 自身请求是否读系统代理、`@local` source 能否加载）。

```bash
git add docs/superpowers/verification
git commit -m "docs: qoder-vpn-proxy 验收记录与 spec 未验证项结论"
```

---

#### Task 17 落地记录（真机跑完后的差异，plan == code 的"差异"部分）

**跑了什么**：CVR 真实启动 → 17 个工具逐个真调 → 9 条验收取证据 → `proxy_core_stop` 收尾还原。全量测试从 147 涨到 **154**（`node --test --test-force-exit`，`# fail 0`）。完整证据在 `docs/superpowers/verification/2026-09-30-acceptance.md`，管道与端点矩阵在 `docs/superpowers/probes/01-named-pipe.md`，安装过程在 `probes/03-plugin-install.md`。

**Step 3 的 Expected 有一处不成立**：草稿假定 `PUT /configs` 能改 mode。真机 mihomo v1.19.25 对 `PUT /configs` **回 204 却什么都不改**，只有 `PATCH` 生效。已按 TDD 改 `clash-client.js` 用 PATCH，并把 `fake-mihomo.js` 的 PUT 分支改成"回 204 但不改状态"，让 fake 与真机一致（commit `25093e7`）。

**Step 3 还暴露一个解析 bug**：curl 8.17.0 在连接失败时 `%{remote_ip}` 打的是**空串**，`parseCurlOut` 的四段正则整行匹配失败，把 `totalMs` 一起丢了（表现是 `direct.totalMs: null`）。第 4 段改成可选 + `remoteIp: m[4] ?? null`（commit `280cf21`）。

**Step 5 的备用路径没被触发**：计划预设"若 `profile_registry_desync` 就先停核心再改订阅"，实测全程没出现 —— 插件的写后重读校验都过了。但真机给出另一条更硬的事实：**mihomo v1.19.25 没有 `POST /configs/reload`（404）**，所以 `activate` 原本把"注册表已写成功"误报成 `channel_unavailable` 失败。改成 best-effort reload + `{reloaded, needsRestart, note}` 如实上报（commit `0c105ac`），README/SKILL 同步。

**Step 8 的 `proxy_core_stop` 原本会撤销用户刚做的订阅切换**：`stop()` 回滚整个 `DEFAULT_BACKUP_NAMES = ['verge.yaml','profiles.yaml']`，而 `profiles.yaml` 是持久用户数据。收窄到 `SESSION_RESTORE_NAMES = ['verge.yaml']`（同上 commit `0c105ac`），测试断言 `restoredList` 只有 verge.yaml 且 `current` 保住。

**Step 7 的备份排序是错的**：`listBackups`/`latestBackupIn` 按文件名字典序取"最新"，而目录里混着两种时间戳格式（`20260930-123930-488-001` 与 `20260930130959726-001`），字典序会挑到过期那份，`restore` 就退回更老状态。改按 `mtimeMs` 排、名字作 tiebreak（commit `29196d1`），测试用 `utimesSync` 钉 mtime 复现。

**Step 8 的一条命令在 Git Bash 下跑不通**：`cmd //c "reg query … //v ProxyEnable"` 的参数被 MSYS 转换搅坏，`reg.exe` 报"无效语法/无效参数"（GBK 乱码输出），失败会被 `|| echo "系统代理关闭"` 吞成假绿。改用 `execFileSync('reg', ['query', <key>, '/v', <value>])` 的独立探针（scratch `qvp-reg.js`），实测 `ProxyEnable = 0x0`。**下一个人别照抄那条 cmd 命令。**

**Step 2 的一个默认值偏紧（未改，记在这里）**：`proxy_test` 首轮 0/15，因为冷核心第一次拨号超过默认 `timeout: 5000`；同一批节点把 timeout 放到 8000 立刻通过。测速语义敏感，没动默认值 —— 冷启动第一次测速建议显式传 `timeout: 8000`。

**Step 6 顺手补了文档侧的凭据泄露**：spec §2 的事实表原本写了完整的旧/新订阅 URL 路径段，已换成 `<旧订阅路径>` / `<新订阅路径>`。计划里的凭据 grep 命令仍保留 token/路径的 8 字符前缀，因为它们是搜索词本身，换成占位符会让验证命令失去可复现性。

**Step 10 的范围比计划多了一点**：除验收文档外，同时把 spec §8 的 6 条"未验证项"逐条改成实测结论，并新增 `probes/03-plugin-install.md`（`@local` 安装的三处写入、备份路径、以及重启失败时的退路）。

**Step 8 的 `stop()` 时序会把整机弄坏（缺陷 8，验收文档记在验收 3"破防记录"）**：本计划的 `stop()` 是 `taskkill` 循环之后直接 `restore`。真机上 15:16 那次停止之后，`ProxyEnable` 变成 `0x1` 而 7897 已无人监听 —— CVR 还在拆除中就读到了刚还原的 `enable_system_proxy: true`，替插件把系统代理打开了。插件本身一行注册表代码都没有，所以任何"代码里没有写注册表"的静态检查都证明不了设计前提成立。改法（已同步进上面的代码块）：`taskkill` → `waitForExit()` 轮询 `tasklist /FI "IMAGENAME eq <image>" /NH` → 才 `restore(SESSION_RESTORE_NAMES)`；等不到也照样还原（不能把压制留在用户机器上），但回 `stillRunning` + 警告；还原后只读复查 `reg query … /v ProxyEnable`，若仍为 1 就把 `reg add … /d 0 /f` 原文交给用户执行，插件不代写。`test/cvr-config.test.js` 末尾追加 4 条测试（还原必须晚于最后一次轮询且只还原一次 / 杀不掉时有上限且仍还原并上报 / 泄漏必须报出且事件里不得出现 `reg add|delete` / `waitForExit` 吃 GBK Buffer）。红 → 修 → 全量 **165 / 0 fail**；真机 `start→stop` 两轮 `ProxyEnable` 恒 `0x0`。**写这一类代码的规矩**：只要会杀掉一个自己会改配置的外部进程，"杀"与"改回配置"之间必须有一次"它真的没了吗"。

## 依赖顺序（执行时不可打乱）

```
Task 1 ─┐ (结论决定 Task 7 的 ORDER)
Task 2 ─┘ (结论决定 Task 16 的 hook 是否保留)
Task 3 ─┬─ Task 4 ─┐
        ├─ Task 5 ─┤
        └─ Task 6 ─┴─ Task 7 ─┬─ Task 9 ─┐
                    Task 8 ───┘          │
Task 10 (需 7+8) ─┐                       │
Task 11 ──────────┼─ Task 12 ─┬─ Task 13 ─┴─ Task 15 ─ Task 16 ─ Task 17
                  └───────────┘           │
Task 14 (需 4+8) ─────────────────────────┘
```

文字版：`3 → {4,5,6} → 7 → {8,9} → 10 → 11 → 12 → {13,14} → 15 → 16 → 17`。Task 1 与 Task 2 是探针，可与 Task 3–6 并行；Task 1 必须在 Task 7 之前出结论，Task 2 必须在 Task 16 之前出结论。

---

### Task 18（验收后追加）: `backups/` 保留期清理

用户在 Task 17 收尾时提的第一项：**① backups/ 加保留期清理**。触发点是验收 7 自己写下的遗留问题——`profiles.yaml.*.bak` 是未脱敏的原始字节，里面带着订阅 token，而目录没有保留期策略。

**Files:**
- Modify: `qoder-vpn-proxy/server/store.js`（新增 `pruneBackupsIn`）
- Modify: `qoder-vpn-proxy/server/tools.js`（`proxy_restore_config` 加 `prune` 分支）
- Modify: `qoder-vpn-proxy/server/index.js`（deps 暴露 `backupDir`）
- Modify: `qoder-vpn-proxy/README.md`、`qoder-vpn-proxy/skills/vpn-proxy/SKILL.md`
- Test: `qoder-vpn-proxy/test/store.test.js`（+2）、`qoder-vpn-proxy/test/tools.test.js`（+3）

**Interfaces:**
- Produces: `store.pruneBackupsIn(dirPath, { keepPerName = 5, olderThanDays = 14, now, dryRun = false })` → `{ deleted:[{file,reason}], failed:[{file,reason,error}], kept:[name], scanned, dryRun }`
- Consumes: `listBackupsIn(dir)` 的升序语义（mtime）；`proxy_restore_config` 的 `deps.backupDir`

- [x] **Step 1: store 层失败测试**——同名的多份备份按份数与天数各自淘汰，但**每个逻辑文件名永远至少留最新一份**（全删等于让 `proxy_restore_config` 失去还原依据）；`dryRun` 只报告不删，且非 `.bak` 文件（`subscriptions.json`、`notes.md`）绝不进扫描集。
- [x] **Step 2: 实现 `pruneBackupsIn`**，删除失败（Windows 上 CVR 正占着文件）如实进 `failed`，不假装已清理。`node --test --test-force-exit test/store.test.js` → 11/11。
- [x] **Step 3: tools 层失败测试**——`prune` 与 `name`/`listOnly` 互斥报 `malformed_config`；`keepPerName:0` 的错误消息里必须带参数名；**`getCvr()` 返回 null（CVR 未安装/核心没跑）时 prune 仍要成功**，因为带 token 的旧备份恰恰是关着核心时最该清的东西。
- [x] **Step 4: 接线**——`proxy_restore_config` 的 prune 分支放在 `await deps.getCvr()` **之前**，参数校验放在碰磁盘之前；`index.js` 的 deps 加 `backupDir: dirs.backups`。全套 `node --test --test-force-exit` → **159 tests / 0 fail**（Task 17 收尾时 154，本任务净增 5）。

**已知边界（不是 bug，是取舍）**：清理**不会自动触发**。`cvr-config.js` 与 `toolconfig.js` 的备份写入走的是注入的 `this.fs`（测试用内存假件），而 `pruneBackupsIn` 用真 `fs.unlinkSync`；把 prune 塞进备份路径会让那些假件失效。因此保留期由调用方掌握：SKILL.md 明确写了"每次动过配置的流程结束时跑一次 `prune`"，README 的数据目录表也点明了 token 风险。若日后要做自动清理，正确切入口是给 `CvrConfig`/`ToolConfig` 注入 `prune` 函数而不是直接用 `fs`。

