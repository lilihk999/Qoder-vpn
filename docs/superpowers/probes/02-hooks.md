# Probe 02 — Qoder Hook 能力边界

日期：2026-09-30 · 影响：Task 16（是否做 hook 注入）、Task 13（toolconfig 是否独自承担"生效"责任）

## 证据来源（都是本机只读检查）

1. `D:\Qoder\resources\app.asar` 里 grep 到 hook 事件枚举的字面量数组：

```
var Mr=["PreToolUse","PostToolUse","PostToolUseFailure","UserPromptSubmit","SessionStart","SessionEnd",
"Stop","SubagentStart","SubagentStop","PreCompact","PostCompact","CwdChanged","InstructionsLoaded",
"FileChanged","PermissionRequest","PermissionDenied","WorktreeCreate","WorktreeRemove"]
```

2. **权威契约文档**随 CLI 分发，路径：
   `D:\Qoder\resources\app.asar.unpacked\node_modules\@qoder-ai\qoder-agent-sdk\dist\_worker\builtin\hook-config\SKILL.md`
   （595 行，`## Hook Events` / `### Command (type: "command")` 两节给出 stdin/stdout 的完整字段）。
   找运行时字符串时优先看这里，别硬啃 141 MB 的 asar。

## 结论

### 1. hook 的唯一注入通道是 `additionalContext`

stdout 契约（所有字段可选；`hookSpecificOutput` 必须带 `hookEventName`，否则报
`hookSpecificOutput is missing required field "hookEventName"`）：

```json
{
  "decision": "allow",
  "reason": "Checks passed",
  "hookSpecificOutput": { "hookEventName": "PreToolUse", "additionalContext": "..." }
}
```

字段表里**没有** `updatedInput`。二进制里那 23 处 `updatedInput` 属于 SDK 的
**permission response** 通路（`{decision:"allow", updatedInput:{...i.input, ...e.updatedInput}}`），
由权限确认 UI/SDK 使用，不是 hook stdout 能写的字段。
→ **PreToolUse 改不了工具入参**，只能 `decision` + 退出码放行或拦截。

### 2. hook 无法给 Bash 工具注入环境变量（推翻早期假设）

`type: "command"` 的 hook 是独立子进程：stdin 收 JSON，stdout 回 JSON。
`${QODER_PLUGIN_ROOT}`、`${QODER_PROJECT_DIR}`、`${QODER_PLUGIN_DATA}` 是导出给
**hook 子进程自己**的环境变量（文档明说 "exported as environment variables to the hook subprocess"），
hook 进程退出即消失。`~/.qoder/session-env/<uuid>/sessionstart-hook-N.sh` 是 Qoder 自建的空文件，
**不是**被 source 的注入点。

→ 会话内 `http_proxy` 之类的变量只能由**工具输出**交给 agent，再由 agent 写进它自己的命令行；
插件无法替 agent 设置环境。

### 3. 拦截是可行的：退出码 2 = blocking deny，stderr 作为理由

`PreToolUse` 的 `matcher` 是工具名正则，还能用 `if` 条件收窄（例：`Bash(git commit:*)`）。
本项目**不启用**任何拦截型 hook：压制/回滚逻辑放在工具里更可测，且拦截会影响用户在
同一会话里的其他操作，blast radius 不属于本插件。

### 4. 生效需要重启 Qoder

hook 配置在会话启动时读取。插件装好后当前会话不会立刻有 hook 效果，必须重启。

## 对下游任务的裁定

- **Task 16**：实现 `hooks/session-start` 只做一件事 —— 读插件状态文件，
  有新起的会话级代理就通过 `additionalContext` 提醒 agent "本会话代理端口 X、
  用 `proxy_env_block` 取命令前缀"。**不要**在 hook 里做任何网络探测或配置写入
  （hook 阻塞会拖慢会话启动）。
- **Task 13（toolconfig）独自承担"真正生效"的责任**：既然 hook 注入不了环境变量、
  PreToolUse 又改不了入参，那么 `npm config` / `git config --global` 这类
  持久化写入就是唯一能让第三方 CLI 稳定走代理的手段。必须保留 `status` 与备份作为审计证据。
- **Task 17**：验收项「新会话出现代理提示」由用户手动重启后确认；重启会中断当前会话，
  不能由 agent 自己代劳。
