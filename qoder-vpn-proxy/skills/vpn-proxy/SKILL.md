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
| 实验做完、`backups/` 里堆了带 token 的旧备份 | `proxy_restore_config prune=true`（先 `dryRun=true` 看一眼要删什么） |

## 边界（不要越界）

- **不改系统代理、不开 TUN、不写注册表**。浏览器和游戏不受影响，这是设计前提，不是副作用。
- `proxy_core_stop` 会等进程真退出再还原配置，并把注册表里的 `ProxyEnable` 只读复查一遍回报（`systemProxyEnabled`）。若它是 `true`，说明系统代理被重新打开而核心已停 —— 浏览器会全线"连接被拒绝"。按 `warnings` 里给出的 `reg add` 命令**让用户自己执行**；插件不代写注册表，也不要擅自改动 `ProxyServer` / `ProxyOverride`。
- **Qoder 自身的模型与 MCP 请求不走代理**——这是用户的决定，不是性能建议。`proxy_diagnose` 的实测也支持它（`qoder.com` 直连 0.5s、经代理 3.7s）。不要把 `HTTPS_PROXY` 指向本机端口。
- 会话结束前若用了 `proxy_toolconfig apply`，提醒用户可 `action=revert` 还原；不要静默留着。
- 订阅 URL **整条**是凭据：主机名、路径段、token 在工具输出里全部掩掉，只剩 `https://<masked-host>/<masked-path>?<masked-query>` 与 `urlFingerprint`。**不要**在回复里复述原始链接（包括你自己从 `profiles.yaml` 读到的原值）；要确认"是不是同一条链接"就比指纹。
- `backups/` 里的 `profiles.yaml.*.bak` **是未脱敏的原始字节，含订阅 token**，且清理不会自动发生——每次动过配置的流程结束时跑一次 `prune`。

## 失败怎么读

`kind` 的 13 种取值与对应动作见 `hint` 字段。特别注意：
- `channel_unavailable` → 先 `proxy_core_start`；仍然不行则**先征得用户同意**再调 `proxy_core_start(enableExternalControl: true)`（这是 spec 刻意的设计：开启外部控制不单独成工具，只在用户确认后由启动工具顺带完成）。
- `profile_registry_desync` → Clash Verge 运行中会回写 `profiles.yaml`。先 `proxy_core_stop` 再重试订阅操作。
- `proxy_subscription_activate` 返回 `needsRestart: true` → 注册表已经改对，但 mihomo（v1.19.25 起）没有 reload 端点，新节点还没进内存。要么 `proxy_core_stop` + `proxy_core_start`，要么让用户在 GUI 里点一下该订阅，别重复调用 activate。
- `subscription_format_unexpected` → 机场按 UA 分流，或链接已失效；不是插件的 bug。
