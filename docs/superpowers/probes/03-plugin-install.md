# Probe 03 — Qoder 插件安装与 `@local` source

日期：2026-09-30 · 影响：Task 16（打包与安装）、spec §8「`@local` source 能否加载」

## 做了什么（都是用户级持久改动，动手前逐一备份）

| 写入 | 内容 | 备份 |
|---|---|---|
| `~/.qoder/plugins/cache/local/qoder-vpn-proxy/0.1.0/` | 整份插件（`.qoder-plugin/plugin.json`、`.mcp.json`、`hooks/`、`server/`、`skills/`、`test/`、`README.md`、`package.json`） | 新建目录，无需备份 |
| `~/.qoder/plugins/installed_plugins_v2.json` | 追加一条 `qoder-vpn-proxy@local` | `installed_plugins_v2.json.qvp-bak`（13658B，11:14） |
| `~/.qoder/settings.json` | 启用表里加 `"qoder-vpn-proxy@local": true` | `settings.json.qvp-bak`（3459B，08:27） |

**没有**动 `~/.qoder/mcp-router.json`（写完复查：`grep -c vpn` = 0）。该文件含本机 apiKey，全程不打印内容。

## 安装后的实际状态（只读核对）

`installed_plugins_v2.json`：

```
version: 2 | plugins 类型: object | 条目数: 38
qoder-vpn-proxy@local => [{"scope":"user",
  "installPath":"C:\\Users\\<user>\\.qoder\\plugins\\cache\\local\\qoder-vpn-proxy\\0.1.0",
  "version":"0.1.0","installedAt":"2026-09-30T04:36:55.204Z",
  "lastUpdated":"2026-09-30T04:36:55.205Z","displayName":"VPN 代理助手"}]
```

`settings.json`（启用表尾部）：

```
    "pm-data-toolkit@qoderapp-bundler"…,
    "pm-data-toolkit@qoder-marketplace": true,
    "qoder-vpn-proxy@local": true
```

安装副本与开发副本逐文件 `cmp`：`server/*.js`、`test/*.js`、`README.md`、`skills/vpn-proxy/SKILL.md`、`.qoder-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json` → **无差异**。每次修 bug 后都要重跑这条，否则"验的是源码、装的是旧版"。

## 从已装插件反推出来的格式事实（写死在实现里）

1. 清单是 **点目录** `.qoder-plugin/plugin.json`，不是根级 `plugin.json`。
2. MCP 声明在**根级** `.mcp.json`，stdio 型本地 server 可行；`${QODER_NODE_RUNTIME}` 与 `${QODER_PLUGIN_ROOT}` 在 `.mcp.json` 里都会被展开。
3. `hooks/hooks.json` 的 SessionStart `matcher` 用 `"startup|resume|clear|compact"`；hook 命令走 polyglot `run-hook.cmd`（同一个文件 cmd 与 bash 都能跑）。
4. 注册表是 `{version:2, plugins:{ "<id>@<source>": [entry...] }}` —— **值是数组**，一个插件可以有多个 scope 条目。
5. 启用状态不在注册表里，在 `settings.json` 的启用表里（`"<id>@<source>": true`）。两处都要写，缺一处插件不出现。

## 未验证（必须重启 Qoder）

`@local` 这个 source 是否真的被 Qoder 接受、17 个 `mcp__vpn-proxy__*` 工具是否出现、SessionStart hook 是否只在 CVR 运行时注入 —— 三条都是重启后才能看的，记录在 `docs/superpowers/verification/2026-09-30-acceptance.md` §验收 4 / §验收 9 的待验证清单里。

**重启后的实测（同日两次重启）**：`@local` 被接受，17 个工具出现，但**前缀不是预测的 `mcp__vpn-proxy__*`，而是 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__*`** —— Qoder 把插件 source 与插件名两段都拼进工具名，所以任何给模型看的文案（包括 hook 注入的提示）都必须照 `mcp_list` 的输出抄，不能按插件 id 拼。第三条最初"看起来符合"其实是假阳性，连吃两个缺陷：MCP/hook 子进程环境里没有 `APPDATA`（发现层退化成"没装 CVR"），以及 `run-hook.cmd` 批处理段里的中文注释让 cmd.exe 按 GBK 码页错位解析、hook 每次 `exit_code=255` 而 `node` 从未执行 —— 日志里 `hook.started` 与 `hook.finished success=false` 成对出现，是能区分"没调用"和"调用即崩"的唯一依据。排查顺序因此要在本节原有三条之前加一条：**先翻 `~/.qoder/logs/latest/qodercli.log` 的 `hook.*` 行**。

**如果重启后插件不出现**，按这个顺序退：
1. 从 `settings.json.qvp-bak` / `installed_plugins_v2.json.qvp-bak` 还原两处写入（还原前再各备份一次当前态）。
2. 改用「已验证可行的 source」：把插件放进 marketplace/bundler 实际使用的目录结构，或退回 `.mcp.json` 单文件方案（只声明 MCP server、不带 hook 与 skill）。
3. hook 单独失败而 MCP 成功时，`server/session-start.js` 仍可手工当 CLI 跑，验证输出是否为空串（验收 9 的代码层证据已经有）。
