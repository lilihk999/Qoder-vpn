# qoder-vpn-proxy 插件设计

日期：2026-09-30
状态：已与用户确认，待实现
作者：Qoder + 用户协作

## 1. 目标与非目标

### 目标

让用户在 Qoder 会话中能够：

1. **识别**本机 Clash Verge Rev / mihomo 代理的运行状态、可用端口、控制器通道与订阅信息。
2. **使用**代理：让 Qoder 会话内的命令行工具（`npm` / `git` / `pip` / `curl` / WebFetch）经由本地代理出网，解决 github.com、google.com 等直连超时的问题。
3. **管理**代理（Clash Verge Rev 的功能子集）：列出与切换节点、切换 `rule/global/direct` 模式、真实延迟测速、查看剩余流量与到期。
4. **自主管理订阅**：订阅不是一次性导入，而是可持续编辑的清单——支持添加新订阅、修改已有订阅的链接（应对机场换地址或轮换 token）、改名与备注、单条或批量更新、在多份订阅间切换激活、删除（可撤销）。

### 非目标（刻意排除）

- **不重复实现代理内核**。流量转发、路由规则、DNS 分流全部交给 mihomo；插件只做发现、控制与诊断。
- **不设置 Windows 系统代理**。系统代理影响整机所有遵循 WinINET 的应用（浏览器、企业客户端、联机游戏），默认由 Clash Verge 自己的 `enable_system_proxy` 负责，插件只读取并展示其状态。插件通过"启动时压制该开关"实现 Qoder 会话级隔离，而不是去改注册表。
- **不启用 TUN 模式**。TUN 会劫持全机 53 端口与 IP 层流量，影响面远超本插件职责；`proxy_status` 会报告其状态但提供不擅自开启。
- **不直接改注册表、不使用 PowerShell P/Invoke 广播配置变更**。用户环境 PowerShell 处于 ConstrainedLanguage，该路径不可靠。
- 不管理第三方代理应用（v2rayN、sing-box 等），只面向 Clash Verge Rev + mihomo REST 协议。

## 2. 已核实的事实基线（设计依据）

以下均在 2026-09-30 于目标机器实测取得，不是假设：

| 项 | 实测值 | 来源 |
|---|---|---|
| 安装位置 | `C:\Program Files\Clash Verge`，含 `clash-verge.exe`、`verge-mihomo.exe`、`verge-mihomo-alpha.exe` | 目录列举 |
| 配置目录 | `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev` | 目录列举 |
| 端口 | mixed 7897 / socks 7898 / http 7899 | `config.yaml` |
| 控制器 | `external-controller: 127.0.0.1:9097`；命名管道 `\\.\pipe\verge-mihomo` | `config.yaml` |
| 控制器密钥 | `secret: set-your-secret`（默认占位值） | `config.yaml` / `clash-verge.yaml` |
| 外部控制开关 | `enable_external_controller: false` → **9097 当前未绑定** | `verge.yaml` |
| 系统代理开关 | `enable_system_proxy: true` → 启动 CVR 会自动开启全局系统代理 | `verge.yaml` |
| TUN | `enable_tun_mode: false` | `verge.yaml` |
| 运行模式 | `mode: rule`，`dns.enhanced-mode: fake-ip`（198.18.0.1/16） | `clash-verge.yaml` |
| 进程与端口现状 | **无 CVR/mihomo 进程**；7897、9097 均拒绝连接；HKCU 无 ProxyEnable 项（系统代理关闭） | netstat / tasklist / reg / curl |
| 直连基线（首轮，本日早间） | `github.com` 12s 超时；`google.com` 12s 超时；订阅站 2.1s 返回 200 | curl |
| 直连基线（Task 14 落地时复测） | `github.com` 3/3 直连 200（connect 0.09s、total 0.76–0.84s、ip 20.205.243.166）、`raw.githubusercontent.com` 3/3 直连 200（total 0.40s、ip 185.199.108.133）；npm registry / PyPI / qoder.com 亦直连 200。复测时 `--noproxy '*'`、无任何代理环境变量、mihomo 端口 7897/7898/7899/9097 全部未监听、无 TUN 网卡，且对端为真实 GitHub/Fastly IP —— 即这轮"直连"没有被任何隐藏路径污染 | curl + `server/diagnose.js` |
| 订阅 UA 门控 | UA=`clash-verge/v2.3.0` → 完整 YAML 28648B + `subscription-userinfo` + `content-disposition: 示例机场`；UA=普通 curl → 仅 base64 节点串 5764B | 三组 UA 对比实测 |
| 已导入订阅 | profile `TESTUIDd7225`「示例机场」，url 路径 `<旧订阅路径>`，当前选中 `TW 2 \| v4`，用量 upload 359MB / download 53.6GB / total 64.4GB | `profiles.yaml` |
| 用户提供的新订阅 | `https://<订阅站>/<新订阅路径>?token=<同 token>`，userinfo 显示 total=74826208722 | curl 实测 |
| 运行时 | Node v22.23.3、npm 10.9.9 可用；Python 为 Store stub 不可用；PowerShell ConstrainedLanguage | 版本探测 |
| Qoder 插件格式 | `.qoder-plugin/plugin.json` 清单 + `mcp.json` 声明 **stdio 型本地 MCP server**（`{"command":"npx","args":[...]}` 已验证可行） | 读取 playwright / chrome-devtools 已装插件 |
| 会话环境变量注入 | `~/.qoder/session-env/<会话UUID>/sessionstart-hook-N.sh` 机制存在（本会话可见空文件） | 目录列举 |

四个关键推论：

- **直连基线会随时段翻转，所以"要不要代理"必须由工具当场判定，不能写死在插件里**。首轮实测 GitHub 直连超时，同日复测 6/6 直连 200。这把插件的价值从"GitHub 必须走代理"改为"在需要的那一刻给出证据"：`proxy_diagnose` 是判定入口，而不是内置一条永真的"给 github.com 加代理"规则。相应地，任何持久化写入（`proxy_toolconfig`）都应由诊断结果驱动，且在直连已恢复时应能回退。
- **系统代理 ≠ 命令行代理**。`curl`/`git`/`pip`/Node `fetch`/Python `requests` 都不读 WinINET 系统代理，只认环境变量。因此"让 Qoder 走代理"必须由环境变量层完成，无法用系统代理替代。
- **TCP 控制口默认不可用**，所以命名管道是首选通道；TCP 需要显式开启，作为兜底路径。
- 先前确认的"订阅更新为新链接"这一动作，在新模型下不再是特例，而是 `proxy_subscription_edit(uid=TESTUIDd7225, url=新链接)` 的一次调用；也可改为 `proxy_subscription_add` 新增一条再 `proxy_subscription_activate`。插件不把这个选择硬编码进代码，安装时作为一次初始化操作执行，事后仍可回退。

## 3. 架构

### 3.1 目录结构

```
qoder-vpn-proxy/
├── .qoder-plugin/plugin.json      # Qoder 插件清单
├── mcp.json                       # stdio MCP server 声明 (node server/index.js)
├── server/                        # 零第三方依赖，仅用 Node 22 内置模块
│   ├── index.js                   # MCP 服务端：换行分隔 JSON-RPC 2.0 over stdio
│   ├── protocol.js                # JSON-RPC 编解码、initialize/tools/list/tools/call 分派
│   ├── transport.js               # Transport 接口 + PipeTransport + TcpTransport
│   ├── discovery.js               # 定位安装/配置目录、解析端口与 secret、探测通道
│   ├── clash-client.js            # mihomo REST 语义方法
│   ├── subscription.js            # UA 门控订阅抓取、userinfo 解析、格式嗅探（无状态）
│   ├── subscriptions.js           # 订阅仓库：增/改/删/切换 + 与 CVR profiles.yaml 双向同步
│   ├── profilesYaml.js            # profiles.yaml 外科式文本编辑（parse/setUrl/appendItem/removeItem/setCurrent）
│   ├── store.js                   # 插件数据目录读写（subscriptions.json、备份、.trash）
│   ├── env.js                     # 代理环境变量块与 NO_PROXY 计算
│   ├── toolconfig.js              # ~/.npmrc 与 git 全局配置的写入/还原/状态
│   ├── diagnose.js                # 直连 vs 经代理 对比探测
│   ├── cvr-config.js              # verge.yaml 备份/改写/还原、CVR 进程启停
│   ├── redact.js                  # token 与节点凭据脱敏
│   └── tools.js                   # 工具 schema 定义 + 分派表
├── skills/vpn-proxy/SKILL.md      # 教 agent 何时用哪个工具、失败如何解读
├── hooks/
│   ├── hooks.json                 # {"hooks":{"SessionStart":[{matcher,"hooks":[{type:"command",command}]}]}}
│   ├── run-hook.cmd               # cmd/bash 双语种包装器（沿用已验证的 superpowers 写法）
│   └── session-start              # 探到代理可连时输出 additionalContext，否则静默
├── test/
│   ├── fake-mihomo.js             # 桩化 mihomo REST 的本地 TCP+命名管道服务端
│   ├── transport.test.js
│   ├── subscription.test.js
│   ├── subscriptions.test.js
│   ├── env.test.js
│   ├── redact.test.js
│   └── tools.test.js              # 走 fake-mihomo 的全链路
└── README.md
```

### 3.2 分层与接口契约

每层只有一个职责，可独立理解与测试。

**`discovery.js` — 纯只读发现，无任何网络写操作**

```js
discover(): Runtime
// Runtime = {
//   installed: bool, installDir, exePath, corePath,
//   configDir, ports: {mixed, socks, http},
//   controller: {tcp: "127.0.0.1:9097" | null, pipe: "\\\\.\\pipe\\verge-mihomo" | null},
//   secret, settings: {enableExternalController, enableSystemProxy, enableTunMode, mode},
//   profiles: {current, items[]},
//   channelHint            // 不可用时给人类的修复说明
// }
```

解析 YAML 用受限的子集读取（正则按行取 `key: value` 顶层项与已知结构），不引入 YAML 库——依赖配置文件由 CVR 生成的稳定格式。解析失败必须降级为 `null` 字段并在 `channelHint` 里说明，不得抛异常。

**`transport.js` — 通道抽象，调用方不感知管道与 TCP 的差异**

```js
createTransport(runtime): Transport   // 按优先级挑选，返回可用的那个
Transport = {
  kind: "pipe" | "tcp",
  request(method, path, {body, headers, timeoutMs}): {status, headers, text}
  close(): void
}
```

`PipeTransport` 用 `net.createConnection({path})` 连命名管道，手写 HTTP/1.1 请求（`Host: api.clash`、`Connection: close`）并解析响应，含分块传输与多包重组。`TcpTransport` 用 `http.request({host, port, headers:{"Authorization": "Bearer "+secret}})`。

选择顺序：命名管道 → TCP → 都不可用则返回 `{ok:false, kind:"channel_unavailable", hint}`。每个传输有独立超时（默认 8s）与"连接后立即 ECONNREFUSED / ENOENT"的区分处理。

**`clash-client.js` — 语义 API，基于 transport**

方法：`version()`、`getConfigs()`、`setConfigs(patch)`、`getProxies()`、`getProxy(name)`、`select(group,target)`、`delay(group|proxy,{url,timeout})`、`closeConnections()`、`reload(params)`、`connections()`。只做 HTTP 语义映射，不含业务策略。

**`subscriptions.js` — 订阅仓库（用户要求：支持自定义添加与修改）**

插件维护一份自己的订阅清单 `<插件数据目录>/subscriptions.json`，条目形如 `{uid, name, url, remark, source, addedAt, lastUpdated, autoUpdate, updateInterval}`。它是 CVR `profiles.yaml` 的**可编辑上层视图**，不是替代品：

- 首次运行从 `profiles.yaml` 导入所有 `type: remote` 的 profile，让已有订阅（如「示例机场」）直接出现在列表里，无需用户重新录入。
- 增、改、删都在插件清单上操作，随后同步落到 CVR 侧：写 profile 内容文件（`profiles/<uid>.yaml`）、更新 `profiles.yaml` 注册项、必要时 `reload` 让 mihomo 生效。
- 同步写回前对 `profiles.yaml` 做与 `verge.yaml` 同样的时间戳备份，失败即中止，不留半改状态。
- 删除采取隔离（移动到数据目录 `.trash/`）而非硬删，可撤销。
- URL 含 token，读出任何清单时一律 `token=<redacted>`，仅在实际抓取时使用原值。

`env.js` / `diagnose.js` / `cvr-config.js` 各自独立，只依赖上述层。

### 3.3 MCP 工具集（17 个）

所有工具返回 `{ok: true, data}` 或 `{ok: false, kind, message, hint}`。所有输出经 `redact.js` 过滤。

| 工具 | 入参 | 返回要点 |
|---|---|---|
| `proxy_status` | 无 | 进程是否在跑、控制器实际可用通道、mixed 端口、`mode`、当前选中节点、TUN/系统代理状态（只读展示）、当前订阅剩余流量与到期 |
| `proxy_detect` | 无 | 本机监听端口扫描结果 + 配置解析结果，列出所有候选代理端口与协议，标注哪些实际可连通 |
| `proxy_core_start` | `{scope?: "session"\|"global"}`，默认 `"session"` | 启动 CVR；session 模式下先备份并临时置 `enable_system_proxy: false`，等待控制器就绪后返回通道与实际绑定端口 |
| `proxy_core_stop` | `{restore?: bool}`，默认 true | 退出 CVR 并还原配置备份 |
| `proxy_nodes` | `{group?}` | 代理组列表、每组 `all[]`/`now`/`history`，**仅节点名，不含任何服务器地址或密钥** |
| `proxy_select` | `{group, target}` 或 `{mode: "rule"\|"global"\|"direct"}` | 切换结果 + 切换后 `now` 确认 |
| `proxy_test` | `{group?, proxy?, url?, timeout?}` | 逐节点真实 TCP+HTTPS 延迟（`/proxies/{name}/delay`），排序返回，标注超时/失败 |
| `proxy_env` | `{target?: "shell"\|"npm"\|"git"\|"pip"}` | 可直接使用的 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 文本块，含对应工具的专用命令；端口取自 discovery，不硬编码 |
| `proxy_toolconfig` | `{action: "apply"\|"revert"\|"status", target?: "npm"\|"git"}` | 写/还原用户级 `~/.npmrc` 代理与 `git config --global http.<github>.proxy`；apply 前备份原文件，status 回显当前生效项与是否由插件写入 |
| `proxy_subscriptions` | 无 | 列出全部订阅：名称、脱敏 url、是否当前激活、节点数、流量与到期、最后更新时间、来源（`cvr`/`plugin`）、备注 |
| `proxy_subscription_add` | `{url, name?, remark?, activate?: bool, autoUpdate?: bool}` | 带正确 UA 抓取 → 校验返回的是 YAML/base64 而非 HTML → 生成 uid → 写 profile 与注册表 → 可选激活 → 返回该订阅条目 |
| `proxy_subscription_edit` | `{uid, url?, name?, remark?, autoUpdate?, updateInterval?}` | 修改已有订阅的链接（**token 轮换/换订阅地址**用）、显示名或更新策略；改 url 时自动重抓并校验 |
| `proxy_subscription_update` | `{uid?}` 或 `{all?: bool}` | 单条或批量刷新；返回 userinfo 前后差值与节点数变化，抓取失败保留旧配置 |
| `proxy_subscription_activate` | `{uid}` | 切换 `current` → `reload` → 回读实际生效的组与节点确认 |
| `proxy_subscription_remove` | `{uid, force?: bool}` | 删除订阅；删当前激活项需 `force: true`；文件移入 `.trash/` 可撤销 |
| `proxy_diagnose` | `{targets?: string[]}` | **核心验收工具**：对 github/google/npm/pypi/Qoder 等地址，分别做"直连"与"经代理"两轮探测，输出对比表 + 结论 + 建议 |
| `proxy_restore_config` | 无 | 列出配置备份、还原 `verge.yaml` / `profiles.yaml`，用于中途放弃时清理 |

`proxy_enable_external_control` 不单列为工具，作为 `channel_unavailable` 的 `hint` 内容，需要用户显式二次确认才由 `proxy_core_start` 顺带完成。

### 3.4 让 Qoder 实际走代理

**先记一条被推翻的假设（2026-09-30 实测）。** 原设想用 SessionStart hook 往 `~/.qoder/session-env/<会话UUID>/sessionstart-hook-N.sh` 写 `export HTTP_PROXY=...` 来注入环境。读了 superpowers 的 hook 实现后确认这是错的：该 `.sh` 文件由 Qoder 自己创建且为空，superpowers 的 `session-start.cjs` 只做一件事——向 stdout 输出
`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`。
本会话开头收到的那段 "Workspace search routing" 文本正是这条通道的产物，因此 **SessionStart 能确定影响的是"注入给 agent 的提示"，不是 shell 环境**。插件不承诺自动 export 环境变量。

生效路径按可靠性排序：

**A. 工具级持久配置（真正生效，不依赖 agent 听话）**

`proxy_toolconfig`（`action: "apply" | "revert" | "status"`，`target?: "npm" | "git"`）写用户级配置：

- npm：在 `~/.npmrc` 追加 `proxy=` / `https-proxy=`（`registry.npmjs.org` 走代理），写入前先备份原文件。
- git：`git config --global http.https://github.com/.proxy http://127.0.0.1:7897`。**按域名前缀配置**，而不是 `http.proxy` 全局项，这样只影响 GitHub，国内站点与内网仓库不变道。URL 与 `proxy` 之间必须保留尾斜杠（`http.https://github.com/.proxy`）：git 对 `http.<url>.*` 做前缀匹配，少一个斜杠时 `https://github.com` 会连带匹配到 `https://github.com.evil.example` 这类仿冒域名，把代理设置泄漏过去。

这两处都是用户级、可逐条还原、不影响浏览器与游戏，符合 §3.5 的 `scope=session` 语义（作用域是"这套工具链"，不是"整机"）。

**B. SessionStart 提示注入（覆盖 curl/pip/WebFetch 等无常驻配置的场景）**

`hooks/session-start` 仅在探测到本地代理端口实际可连通时输出 `additionalContext`，内容是一段简短指令：可用代理地址、`NO_PROXY` 建议值，以及"需要联网的命令请内联 `HTTP_PROXY=... HTTPS_PROXY=... <cmd>`"。探测不到代理时**不输出任何内容**，避免在 Clash Verge 关闭时给每个会话灌入无用且会引发 `connection refused` 的提示。

**C. 按需取用**

`proxy_env` 依旧提供 `shell`/`npm`/`git`/`pip` 四种 target 的现成片段，agent 可在单次调用中内联使用。

**D. 待验证的更优路径**

`PreToolUse` hook 若支持 `updatedInput` 覆盖 Bash 命令，则可在代理可用时透明地为联网命令补上代理前缀，无需 agent 配合。该能力是否被 Qoder 支持**尚未验证**，列为实现计划第 1 个任务的探针项；验证通过才采用，不通过则停留在 A+B+C。

### 3.5 作用域与安全决策（用户已确认）

- `proxy_core_start` 默认 `scope="session"`：压制 CVR 的系统代理开关，使只有 Qoder 会话内的命令行走代理，浏览器、游戏与其他应用完全不变。
- 允许插件写 `%APPDATA%\...\verge.yaml` 与 `profiles.yaml`，但必须：写入前把原文完整备份到插件数据目录（带时间戳），注册清理钩子在 `proxy_core_stop` / `proxy_restore_config` 还原，且 `proxy_status` 始终显示"当前配置是否被插件改过"。
- 订阅 URL 含 token：仅在实际抓取时使用原值；`subscriptions.json` 存于插件数据目录（不进仓库、不进对话）；**任何工具输出、错误消息与日志一律 `token=<redacted>`**。
- `proxy_nodes` 只返回节点名，绝不返回 `server`/`password`/`uuid`/`sni` 等字段。
- 只连接 `127.0.0.1` 与本机命名管道，不向任何第三方发送用户配置。
- 用户自行添加的订阅地址不做校验性外发（不发往插件自有服务，也不做"帮你测一下"的第三方探测）。

## 4. 错误处理

统一 `kind` 分类，每类带可执行的 `hint`：

| kind | 触发 | hint 内容 |
|---|---|---|
| `not_installed` | 找不到 CVR 安装目录 | 指引安装 |
| `core_not_running` | 无进程且端口不通 | 建议 `proxy_core_start` 并说明 scope 差异 |
| `channel_unavailable` | 管道与 TCP 都连不上 | 分级修复：①先 `proxy_core_start`；②开启 `enable_external_controller`（需确认）；③在 GUI 检查端口 |
| `auth_failed` | 401 | secret 不匹配，提示从 GUI 读取实际密钥 |
| `timeout` | 控制器或节点探测超时 | 区分控制器超时与节点慢 |
| `subscription_format_unexpected` | 返回 HTML 或体积异常小 | 说明 UA 门控或链接失效，附本次实际 content-type |
| `subscription_url_invalid` | url 非 http(s) 或为空 | 拒绝写入，不改任何配置 |
| `subscription_duplicate` | 添加的 url 已存在于清单 | 返回已有 uid 并建议改走 update |
| `subscription_not_found` | uid 不存在 | 附当前清单摘要供纠正 |
| `subscription_active_protected` | 删除当前激活项且未传 `force` | 提示先切换或加 `force: true` |
| `profile_registry_desync` | 插件清单与 `profiles.yaml` 不一致 | 以 `profiles.yaml` 为准重新导入并报告差异 |
| `config_write_failed` | 备份/写配置失败 | 中止，不进入半改状态 |
| `malformed_config` | 解析不出端口/管道 | 降级为 null 字段，不崩 |

原则：任何失败都不留半改状态。写配置采用"备份成功→才写入"的顺序；CVR 启动失败必须把备份还原回去。

写 `profiles.yaml` 有一个额外约束：CVR 在运行时会把订阅状态持有在内存里，并在变更或退出时回写该文件，可能覆盖插件的写入。因此订阅 CRUD 一律遵循"写入 → 立即重读校验 → 不一致则报 `profile_registry_desync` 并回滚到备份"，而不是写完就当成功。若校验发现总是被覆盖，则改为要求 CVR 处于停止状态时写入，并在实现计划里记录这条结论。

## 5. 测试策略

**确定性优先于真实性。** 引入 `test/fake-mihomo.js`：起一个同时监听 TCP 端口与命名管道的假 mihomo，桩化 `/version`、`/configs`（GET/PUT）、`/proxies`、`/proxies/{name}/delay`。全部传输层与工具层测试对着它跑，因此 CI 不依赖真实 CVR 是否在运行。

- `transport.test.js`：管道与 TCP 双通道握手、分块响应、多包重组、超时、ECONNREFUSED、401。
- `subscription.test.js`：喂入两种 UA 的真实响应样本（已脱敏），断言 YAML/base64/HTML 三态嗅探与 userinfo 解析。
- `subscriptions.test.js`：对着临时沙箱目录（复制一份真实形态的 `profiles.yaml` + profile 文件）跑完整 CRUD——添加生成 uid 并注册、改 url 触发重抓、切换激活写回 `current`、删除进 `.trash` 且可还原、重复 url 报 `subscription_duplicate`、清单与 `profiles.yaml` 不一致时以文件为准重新导入。
- `env.test.js`：NO_PROXY 计算、各 target 片段格式、端口来自 discovery 而非硬编码 7897。
- `redact.test.js`：token 与节点凭据在各类输出形态下必须消失，含 `subscriptions.json` 被打印出来的路径。
- `tools.test.js`：16 个工具对着 fake-mihomo 全链路调用，断言 schema 与错误分类。
- 用 `node:test` + `node --test`，无测试框架依赖。

**真实环境端到端（最后一步，手工）**：启动 CVR → 通道握手 → 列节点 → 切节点 → 测速 → 更新订阅 → `proxy_diagnose`。

## 6. 验收标准

1. `proxy_diagnose` 输出中，`github.com` 从"直连超时"变为"经代理 HTTP 200"，且同轮 `proxy_status` 显示 `enable_system_proxy` 仍为关闭（证明未影响整机）。
2. 在 Qoder 会话内 `git clone https://github.com/sindresorhus/got` 与 `npm view react dist-tags` 实际成功。
3. 浏览器等其他应用行为不变（系统代理仍关闭，注册表 ProxyEnable 未被设置）。
4. 17 个工具全部可用且错误分类正确；关闭 CVR 后调用工具返回 `core_not_running` + 修复提示，而非崩溃。
5. 订阅可自主维护：`proxy_subscription_add` 加一条新链接后能立即被 `proxy_subscriptions` 列出、`proxy_subscription_update` 刷新成功、`proxy_subscription_activate` 切过去并让 mihomo 实际生效、`proxy_subscription_remove` 删除后可从 `.trash` 还原；改 url（token 轮换）后旧 profile 不被破坏。
6. `proxy_toolconfig` apply 后，**不需要 agent 主动加前缀**，`npm view react dist-tags` 与 `git ls-remote https://github.com/sindresorhus/got` 直接成功；revert 后 `~/.npmrc` 与 git 全局配置恢复到与备份一致（`git config --global --get-regexp '^http\.' ` 为空）。
7. 全程对话与日志中不出现订阅 token 或节点凭据。
8. `proxy_restore_config` 后 `%APPDATA%` 的 `verge.yaml` 与 `profiles.yaml` 与备份前逐字节一致。
9. Clash Verge 未运行时，SessionStart hook 不产生任何 `additionalContext`（新会话开头看不到代理提示）。

## 7. 实现顺序

0. **命名管道探针**：启动 CVR，实测 `http.request({socketPath})` 能否完成 mihomo REST 握手（决定默认通道）。此步会连带开启系统代理，验证后立即还原并记录现象。
1. **hook 能力探针**：确认 SessionStart 的 `additionalContext` 注入生效，并测 `PreToolUse` 是否支持 `updatedInput` 改写 Bash 命令（决定 §3.4 是否需要 D 路径）。
2. `redact.js` + `env.js` + `subscription.js` 纯函数与单测（可完全离线开发）。
3. `transport.js` + `fake-mihomo.js` + 传输层测试。
4. `discovery.js` + `clash-client.js`。
5. `cvr-config.js`（备份/改写/还原 + 进程启停）。
6. `profilesYaml.js` + `store.js` + `subscriptions.js`（订阅仓库 CRUD 与 profiles.yaml 外科式同步）+ 沙箱测试。
7. `toolconfig.js`（npmrc / git 配置读写与还原）+ 测试。
8. `tools.js` + `protocol.js` + `index.js`，打通 MCP。
9. 插件清单 `plugin.json`（含 `hooks` 字段）/ `mcp.json` / `hooks.json` + `session-start` / `SKILL.md`。
10. 安装注册：拷入 `~/.qoder/plugins/cache/local/qoder-vpn-proxy/0.1.0`，更新 `installed_plugins_v2.json` 与 `settings.json` 的 `enabledPlugins`。
11. 真实 E2E 与 §6 验收，并把「示例机场」的订阅链接按第 2 节说明更新为新地址。

## 8. 未验证项 → 实测结论

真机验收记录在 `docs/superpowers/verification/2026-09-30-acceptance.md`；探针细节在 `docs/superpowers/probes/01-named-pipe.md`、`02-hooks.md`。

- ~~Qoder 桌面端自身的模型请求是否读取 WinINET 系统代理~~ → **仍未端到端证明，但设计上不需要**：`proxy_diagnose` 实测 `Qoder 直连 540ms / 经代理 3622ms`，直连更快，所以插件默认就让 Qoder 走直连；全程 `ProxyEnable=0` 时 WinINET 分支根本不被读。**"要不要让 Qoder 的模型请求走代理"已由用户在收尾时决定：不要**（③）。这不是性能建议而是设计约束，写进 SKILL.md 的"边界"，任何工具都不得把 `HTTPS_PROXY` 指到本机端口去影响 Qoder 自身；端到端验证需要临时打开系统代理（违反本设计前提），因此不做。
- ~~命名管道的 mihomo HTTP 支持程度~~ → **完全够用，默认通道即管道**（mihomo v1.19.25，`enable_external_controller:false`）。`GET /version`、`GET /configs`、`GET /proxies`、`PATCH /configs`、`GET /delay`、`PUT /proxies/{name}` 全部可用；TCP 兜底保留但从未需要。两个副作用级发现：真机上 **`PUT /configs` 回 204 却不改状态**（必须 `PATCH`），且 **没有 `POST /configs/reload`（404）** —— 订阅切换后要靠重启核心才加载新节点。
- ~~`PreToolUse` 是否支持 `updatedInput`~~ → **不支持**。hook stdout 契约只有 `decision`/`reason`/`additionalContext`；二进制里的 `updatedInput` 属 SDK permission-response 通路。按原计划接受"提示 + 工具级持久配置"组合。附带结论：hook 子进程的环境变量随进程消失，**无法**给 Bash 工具注入 `http_proxy`。
- ~~新订阅链接返回的节点集合与旧 profile 是否一致~~ → **一致**：新条目 15 个业务节点，4 个策略组（GLOBAL 20 / 示例机场 17 / 故障转移 15 / 自动选择 15）成员未变；quota 读回 total=74826208722。换链接是纯地址变更，不是套餐变更。
- ~~CVR 运行时对 `profiles.yaml` 的回写是否会覆盖插件写入~~ → **会重写，但没覆盖掉插件的改动**：全程未触发 `profile_registry_desync`，§4 的写后重读校验均通过，"先停核心再改订阅"的备用路径没被需要。旁证：CVR 在停核心前一刻自己重写了 `clash-verge.yaml`（插件从不写该文件）。
- `~/.npmrc` 与 git 全局配置属用户级持久改动 → **已按此执行并闭环**：apply 前留时间戳备份，`status` 回 `verdict:'clean'`，revert 后 `~/.gitconfig` 回到 0 字节、`~/.npmrc` 回到"不存在"（即基线态）。

仍未验证 / 未闭环：

- ~~`@local` 插件 source 能否被 Qoder 加载、17 个工具在重启后是否可见~~ → **已闭环**：重启后 `@local` source 加载成功，`mcp_list` 报 17 个 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__*` 工具。**但同一次实测发现新缺陷**：Qoder 拉起的 MCP 子进程环境里**没有 `APPDATA`**，而 `resolveConfigDir` 只认这个变量，于是真机上的 CVR 被报成 `installed:false / configDir:null` —— 已按 TDD 修成"缺 `APPDATA` 时从 `HOME`/`USERPROFILE` 派生 `AppData\Roaming`"（计划 Task 18 后追加，全量 160/160）。
- SessionStart hook 是否真的只在 CVR 运行时注入 —— **第二次重启后查明：hook 被调用了，但每次都崩（缺陷 6）**。Qoder 日志给出 `hook.started source="plugins" plugin_id="qoder-vpn-proxy@local"` 紧接 `hook.finished success=false exit_code=255`，stderr 是 cmd.exe 的"文件名、目录名或卷标语法不正确"；同一次启动里 superpowers 那份**命令串形态完全相同**的 launcher 却 exit 0，逐字节对比后唯一差异是我的批处理段里写了中文注释 —— cmd.exe 按 OEM 码页（GBK）读文件，UTF-8 多字节把行首偏移切错，`node server/session-start.js` 从未执行。这意味着缺陷 5 修完之后"CVR 没跑 ⇒ 不注入"**仍是二次假阳性**：观测到的空串来自进程崩溃，不是判断正确。已按 TDD 修（launcher 全 ASCII + 一条"零非 ASCII 字节"测试，全量 161/0），并在修好的 launcher 上取得正负两支证据：停核心 ⇒ 空串；`proxy_core_start` 拉起 ⇒ 注入"127.0.0.1:7897 可连通"那段且 `ProxyEnable` 仍 `0x0`。顺带修掉缺陷 7（文案里的工具名是拼的，实际前缀 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__`）。最后一步不需要再重启：用 `mcp__builtin__create_chat_session` 拉起全新 Qoder 会话（`startup` 命中 matcher）复验两条分支 —— 核心在跑时（15:15）新会话逐字引用到注入原文且工具名是可调用的全名；核心停掉后（15:16）新会话明确回答"没有"，并逐块排除了静态工具注册表、技能清单与跨会话记忆这三处混淆来源。**验收 9 就此闭环。**
- ~~插件的 `backups/profiles.yaml.*` 必然含原始订阅 token（那是 CVR 工作文件的逐字节副本），目前无保留期策略~~ → **已加保留期清理（计划 Task 18）**：`proxy_restore_config prune=true` 按"每个文件名留 5 份 / 超 14 天删 / 最新一份永远留"清理，`dryRun` 可先看清单。局限：清理**不自动触发**（备份写入层用注入的假 `fs`，prune 用真 `fs.unlinkSync`），所以 SKILL.md 要求每次动过配置的流程结束时跑一次。
- CVR 自己写入的注册表值 `ProxyServer`/`ProxyOverride`（基线里没有）留在机器上 —— **用户已定：不清（②）**。因 `ProxyEnable=0` 而惰性，插件从不写注册表。**唯一一次注册表写入是修复动作**：缺陷 8（`stop()` 在 CVR 拆除中就还原 `verge.yaml`，CVR 于是把 `ProxyEnable` 又打开）发生后，把 `ProxyEnable` 写回基线值 `0`，不是清理用户数据。该缺陷暴露了本前提的一条推论：**"插件不写注册表"不等于"系统代理不会被打开了"** —— 启停序列必须在进程真退出之后才改它的配置，并在改完只读复查 `ProxyEnable`（`proxy_core_stop` 现已返回 `systemProxyEnabled` 与 `stillRunning`，泄漏时把 `reg add` 命令交给用户执行）。

