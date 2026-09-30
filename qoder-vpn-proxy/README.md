# VPN 代理助手（qoder-vpn-proxy）

让 Qoder 认识并使用**本机已经装好的** Clash Verge Rev / mihomo 代理：探测控制通道、选节点、测速、管订阅、诊断"这个域名到底要不要走代理"，并把代理配置写进本会话用到的 npm / git。

插件自己**不转发任何流量**，也不新起一个代理进程 —— 它只是驱动本机那套 Clash Verge。

## 前置条件

- Windows / macOS / Linux，已安装 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)（默认目录即可，或设 `QVP_INSTALL_DIR` 指过去；配置目录自动从 `%APPDATA%\io.github.clash-verge-rev*` 解析，也可用 `QVP_CONFIG_DIR` 覆盖）。
- Node ≥ 18（用 Qoder 自带 runtime，`.mcp.json` 里写的是 `${QODER_NODE_RUNTIME}`）。
- 零第三方依赖：只用 `node:fs` / `node:net` / `node:child_process` 等标准库，测试用 `node --test`。

## 它不会碰什么

这是设计前提，不是实现疏忽：

- **不改系统代理**（`scope=session` 时甚至会把 CVR 的 `enable_system_proxy` 压成 `false`，见下表）
- **不开 TUN、不写注册表、不装驱动**
- 因此**浏览器、游戏、其他终端的行为不变**。只有 agent 显式带上代理前缀的命令，或 `proxy_toolconfig apply` 之后的 npm/git，才走代理。
- 只连 `127.0.0.1` 和本机命名管道 `\\.\pipe\verge-mihomo`，不出网抓取除订阅地址以外的地方。
- 订阅 URL **整条都是凭据**（不止 token）：主机名与路径段能定位到"哪家机场的哪条链接"，且可直接复用发起请求。**所有**工具输出、错误与日志里它们一律掩成 `https://<masked-host>/<masked-path>?<masked-query>`，另给一个 `urlFingerprint`（sha256(host+path) 前 10 位，换 token 不变）用来判断"两次看到的是不是同一条"。原始链接只留在 CVR 自己的 `profiles.yaml` 里，由 CVR 抓取使用。`proxy_nodes` 只回节点名，不回 `server` / `port` / `password` / `uuid` / `sni`。

## 17 个工具

| 工具 | 作用 |
|---|---|
| `proxy_status` | 现状一页纸：是否安装/在跑、通道（管道还是 TCP）、mixed 端口、模式、当前节点、订阅余量、系统代理与 TUN 开关（只读展示）。核心没跑也回 `ok:true`，不可达原因在 `data.core` |
| `proxy_detect` | 解析出的端口 + 常见端口逐个 TCP 握手，列出哪些真能连 |
| `proxy_core_start` | 启动 CVR。`scope=session`（默认）先备份 `verge.yaml` 再压制系统代理与 proxy guard；`scope=global` 保留用户自己的设置。需要开外部控制时传 `enableExternalControl=true`（**先征得用户同意**） |
| `proxy_core_stop` | 结束 `clash-verge.exe` / `verge-mihomo.exe`，**等进程确实退出后**才动手还原（否则 CVR 拆除中会重新打开系统代理）；`restore:true`（默认）只把 `verge.yaml` 的系统代理压制还原回去，**不会**撤销你已经切换/新增的订阅；返回 `stillRunning` 与只读复查的 `systemProxyEnabled` |
| `proxy_nodes` | 列策略组与组内**节点名**，含当前选中项 |
| `proxy_select` | 切节点或切模式（`rule` / `global` / `direct`），切完回读确认生效 |
| `proxy_test` | 对节点跑真实 `/delay` 测速，串行执行，按延迟升序返回，坏节点标 `ok:false` 与原因 |
| `proxy_env` | 给内联前缀或 `export` / npm / git / pip 片段，端口实时解析（不是写死的 7897） |
| `proxy_toolconfig` | `apply` / `revert` / `status`：把代理写进 `~/.npmrc` 的托管块与 git 的 `http.https://<host>/.proxy`（只针对 GitHub 域名，不动全局 `http.proxy`） |
| `proxy_subscriptions` | 列订阅：名称、掩码 url + `urlFingerprint`、是否激活、节点数、流量余量、到期日、最后更新时间 |
| `proxy_subscription_add` | 加一条订阅（Clash 家族 UA 抓取，校验返回必须是 YAML/base64 节点而非 HTML 登录页；写后立即重读校验，不一致回滚） |
| `proxy_subscription_edit` | 改订阅：换 url（token 轮换 / 换域名）、改名、备注、自动更新策略。**自定义名称在更新后保留** |
| `proxy_subscription_update` | 重新抓取刷新：传 `uid` 更单条，`all=true` 批量 |
| `proxy_subscription_activate` | 切换激活订阅：写 `profiles.yaml` 的 `current` 并回读确认。mihomo v1.19.25 **没有** reload 端点，所以返回里 `needsRestart: true` 表示还要 `proxy_core_stop` + `proxy_core_start`（或在 GUI 点一下该订阅）才真正加载新节点 |
| `proxy_subscription_remove` | 删除订阅：移除注册项，内容文件移入插件回收目录 `.trash`（可撤销，不硬删） |
| `proxy_diagnose` | 对 GitHub / npm / PyPI / Qoder 等地址，同一时刻各跑一轮"直连"与"经代理"的 curl（直连轮强制 `--noproxy '*'`，不被环境变量污染），给出该不该走代理的结论 |
| `proxy_restore_config` | 列出插件做过的全部带时间戳备份并还原；`prune=true` 改为按保留期清理备份目录 |

## `scope=session` 与 `scope=global`

| | `session`（默认） | `global` |
|---|---|---|
| CVR 的 `enable_system_proxy` | 启动前压制为 `false`（已备份，`proxy_restore_config` 可还原） | 保持用户原设置 |
| 谁走代理 | 只有 agent 显式带前缀的命令、以及 `proxy_toolconfig apply` 写过的 npm/git | 整机包括浏览器 |
| 影响游戏/浏览器 | 否 | 取决于用户原本的设置 |

## `proxy_toolconfig` 改的是哪两个用户级文件

1. `~/.npmrc` —— 只动插件自己的托管块（`# >>> qoder-vpn-proxy >>>` 与 `# <<< qoder-vpn-proxy <<<` 之间），apply 前整文件备份到 `~/.qoder/vpn-proxy/backups/`；如果文件本来只由插件创建，revert 会连文件一起删掉而不留空文件。
2. git 全局配置 —— 按域名前缀写 `http.https://github.com/.proxy` 等三条（`github.com`、`objects.githubusercontent.com`、`api.github.com`），**不写** 全局 `http.proxy`，所以 `git clone` 国内仓库不受影响。

两者都是**用户级持久改动**，会话结束不会自动消失。用前先 `action=status` 看当前状态，用后 `action=revert` 还原；`status` 会告诉你值是否还和当前端口一致（换端口后旧配置会静默失效，这是它专门检查的一项）。

## 数据目录 `~/.qoder/vpn-proxy/`

| 路径 | 内容 |
|---|---|
| `subscriptions.json` | 插件侧的订阅备注（显示名、备注、自动更新策略）；真正的订阅注册表仍是 CVR 的 `profiles.yaml` |
| `backups/` | 每次写 `verge.yaml` / `profiles.yaml` / `~/.npmrc` 前的时间戳备份，`proxy_restore_config` 列的就是这里。**`profiles.yaml.*.bak` 是原始字节，里面带着未脱敏的订阅 token**；保留期靠 `proxy_restore_config prune=true`（默认每个名字留 5 份、超过 14 天的旧副本删掉，最新一份永远留），清理不会自动发生 |
| `.trash/` | 删除订阅时移入的内容文件，可手动挪回 |
| `logs/mcp.log` | MCP 服务端日志。**只写文件与 stderr，绝不写 stdout** —— stdout 是协议通道 |

设 `QODER_VPN_PROXY_DATA` 可整体挪走（测试与多实例用）。

## 安装

Qoder 插件走 `~/.qoder/plugins/cache/<source>/qoder-vpn-proxy/<version>/`，并在 `installed_plugins_v2.json` 与 `settings.json` 的 `enabledPlugins` 里注册。**改这两个 JSON 属于 Qoder 自身配置，动手前先备份**；注册后必须重启 Qoder 才会加载。

## 卸载

1. 先还原持久改动：`proxy_toolconfig(action=revert)`，若用过 `scope=session` 启动核心，再 `proxy_restore_config` 还原 `verge.yaml`。
2. 在 Qoder 里关闭/卸载插件（并从 `enabledPlugins` 与注册表移除对应键）。
3. 删除插件目录与数据目录 `~/.qoder/vpn-proxy/`。
4. 复核：`git config --global --get-regexp 'http\..*\.proxy'` 应为空，`~/.npmrc` 里没有 `# qoder-vpn-proxy` 块。

## 开发

```bash
cd qoder-vpn-proxy
node --test          # 全套测试（无第三方依赖）
node server/index.js # 手跑 stdio 服务端
```

设计与取舍见仓库 `docs/superpowers/specs/2026-09-30-qoder-vpn-proxy-design.md`，逐步实现记录见 `docs/superpowers/plans/2026-09-30-qoder-vpn-proxy.md`。
