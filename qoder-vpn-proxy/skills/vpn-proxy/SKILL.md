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
