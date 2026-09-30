# qoder-vpn-proxy 真机验收记录

日期：2026-09-30 · 分支 `qoder-vpn-proxy` · 计划 Task 17 · 规格 `docs/superpowers/specs/2026-09-30-qoder-vpn-proxy-design.md` §6

**脱敏约定**：本文所有订阅 URL 只写路径段占位（`<旧订阅路径>` / `<新订阅路径>`），token 一律 `<redacted>`。真机上的原始凭据只存在于 CVR 自己的 `profiles.yaml` 与其备份里。

**运行环境**（都是实测，不是假设）：Clash Verge Rev GUI + mihomo **v1.19.25**；安装目录 `C:\Program Files\Clash Verge`；配置目录 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev`；mixed 端口 7897；控制通道 `\\.\pipe\verge-mihomo`（TCP 9097 未开启）；Node v22.23.3；curl 8.17.0。

**测试基线**：`cd qoder-vpn-proxy && node --test --test-force-exit` → `# tests 154 / # pass 154 / # fail 0`。

---

## 验收 1：`proxy_diagnose` 里 github 从"直连超时"变"经代理 200"，同轮系统代理仍关闭

**证据**（CVR 运行中，`runDiagnose` 直连轮强制 `--noproxy '*'`）：

```
GitHub 站点      直连FAIL | 代理OK  4008/4587ms :: 需要代理：直连不通，经代理正常
GitHub raw     直连FAIL | 代理OK  130/1229ms :: 需要代理：直连不通，经代理正常
npm registry   直连OK  | 代理FAIL 4505/8014ms :: 经代理反而失败：该节点或规则可能有问题
PyPI           直连OK  | 代理OK  510/1385ms :: 直连更快（510ms vs 经代理 1385ms），此项不该走代理
Qoder          直连OK  | 代理OK  540/3622ms :: 直连更快（556ms vs 经代理 3622ms），此项不该走代理
verdict: 代理对 2 项目前是必需的
== 系统代理仍未开启 ==
0
```

同轮 `proxy_status`：`settings.enableSystemProxy:false`、`enableTunMode:false`、`core.tunEnabled:false`、`controller.tcpEnabled:false`。

**结论**：达成。GitHub 两行确实从直连失败翻成经代理成功，且这一轮系统代理读回来是 0。

**遗留问题**：
1. 第一版输出里 `direct.totalMs` 是 `null`（上面这段是修复后的重跑）。原因是 curl 8.17.0 在连接失败时 `%{remote_ip}` 打的是空串，`parseCurlOut` 的四段正则整行匹配失败，把耗时一起丢了。已按 TDD 修（commit `280cf21`），并补了两条测试锁住"失败行也要有耗时"。
2. `npm registry 经代理反而失败`是**机场侧**（该节点或分流规则），不是插件问题：同一轮里 npm 直连 4505ms 是通的。
3. `verdict` 只看"直连不通"的项，所以 npm 那行 FAIL 没进 verdict。这是设计（回答"该不该走代理"），但读表的人容易误以为 npm 没问题，README 里已按"逐行 conclusion 优先于 verdict"来讲。

---

## 验收 2：不加前缀也能让 git/npm 走代理，之后干净还原

**证据**（`proxy_toolconfig action=apply` 之后，命令行不带任何前缀）：

```
== 不带任何前缀：git ls-remote ==
e1d87d2ced01d5b7d855a7dc8b091bf7b014a1e4	HEAD
real	0m1.671s
== npm view react ==
{
  beta: '19.0.0-beta-26f2496093-20240514',
  rc: '19.0.0-rc.1',
  next: '19.3.0-canary-d5736f09-20260507',
  backport: '19.0.8',
  latest: '19.3.0',
```

对照：同一时刻直连 `git ls-remote` 是超时（验收 1 第一行）。

**结论**：达成。git 走 `http.https://github.com/.proxy` 三条 per-host 配置，npm 走 `~/.npmrc` 托管块，都不需要 agent 记着加前缀。

**遗留问题**：持久改动只在 `apply` 后生效，会话结束不会自动消失 —— 这是刻意的（`revert` 要显式调）。SKILL 里要求 agent 在收尾时提醒用户 revert，不要静默留着。

---

## 验收 3：浏览器/游戏等其他应用行为不变

**证据**：全程 `ProxyEnable` 读回 `0x0`（见验收 1 末行，以及收尾现场核对）；`enableTunMode:false`、`core.tunEnabled:false`；插件代码里唯一的写路径是 `%APPDATA%` 下的 `verge.yaml`/`profiles.yaml` 文件、`~/.npmrc` 与 git 全局配置，外部命令只有 CVR 启动、`taskkill`、`curl` —— **没有任何注册表写操作**。

**结论**：达成。WinINET 层 `ProxyEnable=0` 时浏览器忽略 `ProxyServer`，系统代理未开启即整机未受影响。

**遗留问题**：CVR 自己在运行期间写入了两个注册表值（基线里不存在）：

```
ProxyServer = 127.0.0.1:7897
ProxyOverride = localhost;127.*;192.168.*;10.*;172.16.*;…;<local>
```

因为 `ProxyEnable=0`，这两个值目前是惰性的、不影响任何应用。它们不是插件写的（插件无注册表写代码路径），但**留在机器上了**。是否清掉属用户决定 —— 需要动注册表，插件按设计前提不做这件事。

---

## 验收 4：17 个工具全部可用，核心关闭时返回可读错误而不是崩或挂起

**证据（核心已停时的三连调用，秒级返回，全部 `{ok:false}` + `hint`）**：

```
== 核心已停时 proxy_nodes（应 core_not_running）==
{"ok":false,"kind":"channel_unavailable","message":"mihomo 控制器不可达（命名管道 \\\\.\\pipe\\verge-mihomo: GET /version 连接失败: ENOENT）","hint":"先调用 proxy_core_start（默认 scope=session，不会打开系统代理）；若仍不可用，需取得用户确认后调用 pro…

== 核心已停时 proxy_test ==
{"ok":false,"kind":"channel_unavailable","message":"mihomo 控制器不可达（…

== 核心已停时 proxy_status ==
{"ok":true,"data":{"installed":true,"running":false,"configDir":"…
```

核心运行时的逐工具验证（Step 2）都过了，返回体一律 `{ok:...}` 两态，节选：

```
{"ok":true,"data":{"installed":true,"running":true,"ports":{"mixed":7897,"socks":7898,"http":7899},
 "controller":{"pipe":"\\\\.\\pipe\\verge-mihomo","tcp":null,"tcpConfigured":"127.0.0.1:9097","tcpEnabled":false},
 "settings":{"enableSystemProxy":false,"enableTunMode":false,"enableExternalController":false},
 "core":{"reachable":true,"channel":"pipe","version":"v1.19.25","mode":"rule","mixedPort":7897,"tunEnabled":false,
  "groups":[{"name":"GLOBAL","type":"Selector","now":"DIRECT","count":20},
            {"name":"示例机场","type":"Selector","now":"TW 2 | v4","count":17},
            {"name":"故障转移","type":"Fallback","now":"HK 1 | v4","count":15},
            {"name":"自动选择","type":"URLTest","now":"TW 2 | v4","count":15}]}, …}}
```

`proxy_test` 真实 `/delay` 扫描：15 个节点里 8 个有延迟数字，坏节点回 `ok:false` + 原因（首轮全 0/15 是**冷启动首拨超时**，同一节点把 timeout 从默认 5000ms 放到 8000ms 后立刻通过 —— 不是链路故障，见下）。

**结论**：**半成品**。"核心关闭时不崩不挂、给出修复提示"这一半已经用真机命令证明（`kind` 是 `channel_unavailable` 而不是 `core_not_running`，两者都在计划 §"proxy_status 例外约定"允许的两态之内，且 hint 直接给出下一步工具）；"17 个工具在 Qoder 里可见"这一半**必须重启 Qoder 才能验证**，见验收 9 一并处理。

**遗留问题**：
1. `proxy_test` 默认 timeout 5000ms 在冷核心上会全员误报超时。已确认是默认值偏紧，本次未改（改动会影响测速语义），记在这里：第一次测速建议显式传 `timeout: 8000`，或先跑一条 `proxy_env`/`proxy_diagnose` 把链路热起来。
2. 验收 4 的工具可见性未闭环，等用户重启。

---

## 验收 5：订阅可自主维护（加/列/刷新/切/改备注/删，删了能撤销）

**证据**（把「示例机场」换成新链接的完整一轮）：

```
== 清单 ==
TESTUIDd7225 示例机场 active=false nodes=null src=cvr remark=""
TESTUID1ef15 示例机场(新) active=true nodes=15 src=plugin remark="2026-09-30 换地址"

TESTUID1ef15 | 示例机场(新) | active=true | nodes=15 | remark=2026-09-30 换地址 | quota={"upload":40651,"download":6808775,"total":74826208722,"expire":null}

== 删除当前激活订阅（应被拦）==
{"ok":false,"kind":"subscription_active_protected","message":"TESTUID1ef15 是当前激活订阅，删除会让 mihomo 没有配置可用","hint":"先 activate 到别的订阅，或确认后再传 force: true"}

== 给旧条目加备注（只改 remark 不动内容）==
{"ok":true,"data":{"uid":"TESTUIDd7225","name":"示例机场","url":"https://…?token=<redacted>","urlPathOnly":"https://…","file":"TESTUIDd7225.yaml","type":"remote","active":false,…}}

== 删除旧条目 ==
{"ok":true,"data":{"removed":"TESTUIDd7225","trashed":["profiles.yaml.20260930130959726-001.bak","20260930130959728-003-TESTUIDd7225.yaml"],
 "undo":"注册表备份在 C:\\Users\\<USER>\\.qoder\\vpn-proxy\\backups，内容文件在 C:\\Users\\<USER>\\.qoder\\vpn-proxy\\.trash；放回 …\\profiles 并重新 add 即可撤销"}}

== profiles.yaml 注册项 ==
3:current: TESTUID1ef15
…
40:- uid: TESTUID1ef15
== .trash ==
20260930125704203-003-TESTUID6fc25.yaml
20260930130959728-003-TESTUIDd7225.yaml
```

**结论**：达成（带一条限定）。自定义名称与备注在 update 后保留、`activate` 写入的 `current` 落盘并被 CVR 接受、激活项删除被拦截、内容文件进 `.trash` 可放回 —— 都拿到了真机返回体。

**遗留问题（重要，实测推翻了原设计假设）**：
1. `activate` 第一次返回 `{"ok":false,"kind":"channel_unavailable","message":"POST /configs/reload -> HTTP 404 404 page not found"}` —— **mihomo v1.19.25 根本没有 reload 端点**（CVR 走 GUI 侧的 profile 切换，不走这个 REST 路径）。注册表写入其实已经成功。已按 TDD 改成如实上报（commit `0c105ac`）：`reloaded` / `needsRestart` / `note` 三个字段明说"profiles.yaml 已改，需 `proxy_core_stop` + `proxy_core_start`（或 GUI 点一下该订阅）才真正加载新节点"。
2. 没观察到 `profile_registry_desync` —— CVR 运行期确实会重写 `profiles.yaml`，但插件的写后重读校验都通过了，所以计划里预设的"先停核心再操作订阅"这条备用路径没有被触发。
3. 操作过程中我自己犯过一次错：拿**未激活**的 uid 去测删除保护，误删了 `TESTUID6fc25`。已重新添加（新 uid `TESTUID1ef15`）并正确验证了 `subscription_active_protected`。这条留在文档里，作为"删除保护只对 current 生效"的事实记录。

---

## 验收 6：`proxy_toolconfig` revert 后与备份一致

**证据**：

```
== revert ==
{"ok":true,"data":{"action":"revert","targets":["npm","git"],"npm":{"action":"removed-created","file":"C:\\Users\\<USER>\\.npmrc","backupPath":"C:\\Users\\<USER>\\.qoder\\vpn-proxy\\backups\\.npmrc.20260930125506962-001.bak"},"git":{"removed":[{"key":"http.https://github.com/.proxy","existed":true},{"key":"http.https://objects.githubusercontent.com/.proxy","existed":true},{"key":"http.https://api.github.com/.proxy","existed":true}]}}}

== status（应 clean）==
verdict clean npmrc.exists false npmrc.managed false git.mismatch true
== 现场核对 ==
git http.* 已清空
-rw-r--r-- 1 <USER> 197121 0 Sep 30 12:55 /c/Users/<USER>/.gitconfig
```

**结论**：达成。`verdict:'clean'`；git 全局配置回到 0 字节空文件（基线本来就没有 `http.*`）；`~/.npmrc` 基线不存在，apply 时是"新建"，revert 就把它删回"不存在"，同时留了时间戳备份。

**遗留问题**：`git.mismatch true` 在 revert 后的 `status` 里仍为 true，但含义是"没有期望端口可比"而不是"配置错了"；空文件与缺失文件在审计上等价，读 `status` 的人需要知道这点。

---

## 验收 7：全程对话与日志不出现订阅 token 或节点凭据

**证据**：

```
== 插件数据目录（排除 CVR 自己的工作文件）==
/c/Users/<USER>/.qoder/vpn-proxy/backups/profiles.yaml.20260930-123930-488-001.bak
/c/Users/<USER>/.qoder/vpn-proxy/backups/profiles.yaml.20260930-130648-474-001.bak
…（共 10 份 profiles.yaml 备份命中）
== 日志 ==
mcp.log
0
日志 0 命中
== 仓库源码 ==
（无命中）
== CVR 自己的 profiles.yaml（允许保留原值）==
1
```

收尾重跑：`grep -r -I -E '<token 前 8 位>' ~/.qoder/vpn-proxy/logs/ | wc -l` → `0`（真实前缀不写进本文档）。

**结论**：**诚实但带限定地达成**。
- 扫描范围与结果：日志（`mcp.log`，7 行）、插件源码目录 `qoder-vpn-proxy/`（含测试 fixture、README、SKILL）、`subscriptions.json`、`.trash` 内容、所有对话输出 → 对 `<needle-1>|<needle-2>|<needle-3>|<needle-4>` 全部 0 命中（`grep -rn -E '<needle-1>|<needle-3>|示例机场' qoder-vpn-proxy/` 也 0 命中，连机场名都没进代码）。
- `proxy_nodes` 只回节点**名称**，不回 `server`/`port`/`password`/`uuid`/`sni`（设计如此，有测试锁住）。

**本次一并处理的文档侧泄露**：spec §2 的事实表原本写了**完整**的旧/新订阅 URL 路径段，已换成 `<旧订阅路径>` / `<新订阅路径>` 占位（本文档也不复述原值）。计划里仍保留上面那四个 **8 字符前缀**，因为它们是 Task 15/17 凭据 grep 命令的搜索词本身（改成占位符会让验证命令失去可复现性）；前缀不足以重建 32 位 token。若日后 token 轮换，这些前缀应一起更新。

**遗留问题（不能粉饰的那一条）**：插件自己的 `backups/profiles.yaml.*.bak` **含原始 token** —— 这是物理必然：备份是 CVR `profiles.yaml` 的逐字节副本，而那份文件本来就存订阅 URL。目前**没有**备份保留/过期策略，也没有对备份内容做脱敏（脱敏会让备份失去还原价值）。可选处置（都要用户点头）：加 `backups/` 保留期清理，或把备份目录权限收紧。

**后记（用户点头后的处置）**：用户选了"① backups/ 加保留期清理"，实现见计划 Task 18 —— `proxy_restore_config prune=true`（默认每个文件名留 5 份、超 14 天的旧副本删除、最新一份永远留，`dryRun` 先出清单）。仍在的局限有两条，不遮掩：清理**不自动触发**（备份写入层用注入的假 `fs`，prune 用真 `unlinkSync`，硬拼会让那些假件失效），所以靠 SKILL.md 要求流程收尾跑一次；且**保留期内**的备份依旧是未脱敏原文，`keepPerName`/`olderThanDays` 只是把暴露窗口从"永久"压到"5 份 / 14 天"。另一条备选（收紧目录权限）没做。

---

## 验收 8：`proxy_restore_config` 后 CVR 配置文件逐字节还原

**证据**（sha256 前 16 位；基线是 Task 17 Step 0 在启动 CVR 前记录的）：

```
基线哈希: {"verge.yaml":"1685d55c4dd5d3ff","profiles.yaml":"f59029574ff9b4a7"}

verge.yaml: 共 4 份备份
  ✅ verge.yaml.20260930-123930-488-001.bak 与基线逐字节一致（sha256 前 16 位 1685d55c4dd5d3ff）
  最新一份 verge.yaml.20260930-130648-477-002.bak = 1685d55c4dd5d3ff
  当前文件 = 1685d55c4dd5d3ff (== 基线)

profiles.yaml: 共 10 份备份
  ✅ profiles.yaml.20260930-123930-488-001.bak 与基线逐字节一致（sha256 前 16 位 f59029574ff9b4a7）
  最新一份 profiles.yaml.20260930130959726-001.bak = ba52b8b3c95a289f
  当前文件 = f2dfaeb510fe77ca
```

收尾现场核对（本文档写之前重跑，与上表一致）：

```
(CVR 进程已退出)
(7897/9097 未监听)
verge.yaml 1685d55c4dd5d3ff        ← == 基线
profiles.yaml f2dfaeb510fe77ca     ← 故意不等于基线
config.yaml 995b9d6c703229d4       ← == 基线（插件从不写它）
ProxyEnable = 0x0
```

**结论**：**分两半达成**。
- `verge.yaml`（插件唯一为"压制系统代理"而改的会话级文件）：当前 = 最新备份 = 基线，**逐字节一致**，还原链路（含 `proxy_core_stop` 的自动回滚）成立。
- `profiles.yaml`：**故意**不等于基线 —— 它承载的是用户主动要求的订阅切换（验收 5）。把"改动"和"泄漏"分开看：切换前的原始字节就在 `profiles.yaml.20260930-123930-488-001.bak` 里，已验证与基线逐字节一致，随时可 `proxy_restore_config` 回滚。

**遗留问题**：早期版本的 `listBackups` 把备份按**文件名字典序**排，而目录里混着两种时间戳格式（`20260930-123930-488-001` 带连字符、`20260930130959726-001` 不带），于是"最新一份"会挑到过期那份，`restore` 会退回更老的状态。已按 TDD 改成按 mtime 排（commit `29196d1`），并用 `utimesSync` 钉住 mtime 的测试复现了原 bug。同类地，`stop()` 原本连 `profiles.yaml` 一起回滚，会撤销用户刚切的订阅 —— 已收窄到 `SESSION_RESTORE_NAMES = ['verge.yaml']`，上面那条 `stop` 返回体的 `restoredList` 只有一项 `verge.yaml` 就是它的直接证据。

---

## 验收 9：CVR 未运行时 SessionStart hook 不注入任何 `additionalContext`

**证据（可自动化的那一半已闭环，subprocess 级测试）**：

```
$ node --test --test-force-exit test/session-start.test.js
（3 条通过：未安装 CVR / CVR 装了但没跑 / 端口不可达）
assert.equal(msg.hookSpecificOutput.additionalContext, '', '验收 9：没装 CVR 时不注入任何文本')
```

手工等价验证（CVR 已停的当前状态）：hook 子进程 stdout 为
`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}`。

**结论**：**代码层达成，Qoder 集成层待重启验证**。hook 脚本在 CVR 未运行时确实输出空串（不注入）；但"重启后新会话开头看不到代理提示 / 启动 CVR 后新会话才出现提示"只能在真实 Qoder 会话里看，而重启会结束当前会话。

**待用户验证的两件事**（与验收 4 的后一半一起）：
1. 重启 Qoder → 新对话里是否出现 17 个 `mcp__vpn-proxy__*` 工具；核心关闭时调用是否像上面那样秒级返回 `{ok:false, kind:'channel_unavailable', hint:'先 proxy_core_start…'}`。
2. 重启后 CVR 未运行 → 会话开头**不应**有任何代理 `additionalContext`；手动启动 CVR 后再开新会话 → 应出现"本机代理端口可连通"那段。
3. 附带验证 spec §8 最后一项：`~/.qoder/plugins/cache/local/` + `installed_plugins_v2.json` 里 `@local` 这个 source 到底能不能被加载。

把用户反馈逐字记进本文档后再定稿。若 hook 没生效，按 `docs/superpowers/probes/02-hooks.md` §4 的顺序查：`hooks.json` 是否被读到 → `run-hook.cmd` 在 bash 下能否跑通 `node server/session-start.js` → 是否 5 秒内退出。

---

## spec §8「未验证项」的明确答案

| # | 未验证项 | 实测结论 |
|---|---|---|
| 1 | Qoder 桌面端自身的模型请求是否读 WinINET 系统代理 | **未做端到端证明，但已有决定性旁证且不需要它**：`proxy_diagnose` 的 `Qoder` 行显示直连 540ms / 经代理 3622ms，直连更快，所以设计上就是"不让 Qoder 走代理"。加上全程 `ProxyEnable=0`，WinINET 分支根本不会被读。**收尾时用户已给出决定（③）：Qoder 自身模型请求不走代理** —— 这条从"未回答的产品问题"变成设计约束，写进 SKILL.md 的边界一节。端到端验证要临时打开系统代理（违反设计前提），因此按决定不再做。 |
| 2 | 命名管道的 mihomo HTTP 支持程度 | **完全够用，默认通道就是管道**。`enable_external_controller:false` 时 `\\.\pipe\verge-mihomo` 照样能跑 `GET /version`、`GET /configs`、`GET /proxies`、`PATCH /configs`、`GET /delay`、`PUT /proxies/{name}`，全程无需 TCP、无需改 CVR 设置、无需用户额外授权。详见 `probes/01-named-pipe.md`（含 404 端点矩阵与两个流式端点）。 |
| 3 | `PreToolUse` 是否支持 `updatedInput` | **不支持**。hook stdout 契约只有 `decision`/`reason`/`hookSpecificOutput.additionalContext`，字段表里没有 `updatedInput`；二进制里那 23 处 `updatedInput` 属于 SDK 的 permission-response 通路。因此本插件接受"提示 + 工具级持久配置"的组合，不做入参改写。详见 `probes/02-hooks.md` §1。 |
| 4 | 新订阅链接返回的节点集合与旧 profile 是否一致 | **一致**：新条目刷新后 `nodes=15`，与旧条目在 GUI/`/proxies` 里看到的 15 个业务节点同一集合（4 个策略组：GLOBAL 20 / 示例机场 17 / 故障转移 15 / 自动选择 15，组数与成员未变）。quota 也读回来了（total 74826208722）。所以"换链接"是纯地址变更，不是套餐变更。 |
| 5 | CVR 运行时对 `profiles.yaml` 的回写是否会覆盖插件写入 | **会重写，但没覆盖掉插件的改动**：全程未触发 `profile_registry_desync`，插件的写后重读校验（含时间戳/内容对比）都通过；同时观察到 CVR 在 `proxy_core_stop` 前一刻（13:06:49）重写过 `clash-verge.yaml`。结论：§4 的"写后重读校验 + 不一致回滚"是必要的，够用；不需要预设的"先停核心再改订阅"备用路径。 |
| 6 | `~/.npmrc` 与 git 全局配置属用户级持久改动，需审计依据 | **已按此执行**：`apply` 前都留了时间戳备份（`.npmrc.20260930125506962-001.bak`），`status` 给 `verdict:'clean'`，`revert` 后 `~/.gitconfig` 回到 0 字节、`~/.npmrc` 回到"不存在"（基线态）。两者都不是插件"遗留"的改动，验收 6 已闭环。 |

`@local` source 能否加载 —— spec 里列的第六项，见上面验收 9 的待验证清单第 3 条（同样要重启）。

---

## 本轮真机跑出来的 4 个缺陷（都是"测试替身没像真机"这一类）

| 缺陷 | 触发方式 | 修复 |
|---|---|---|
| `PUT /configs` 被 v1.19.25 静默吞掉（回 204 但 mode/tun 不变） | `proxy_select {mode}` 无效，GUI 不动 | `clash-client.js` 改 `PATCH`；`fake-mihomo.js` 里 PUT 分支改为"回 204 但不改状态"，两条测试锁住 |
| curl 失败行 `%{remote_ip}` 是空串 → `parseCurlOut` 整行不匹配，耗时一起丢 | `proxy_diagnose` 的 `direct.totalMs:null` | `diagnose.js` 第 4 段改可选 `(?:\s+(\S+))?`，`remoteIp: m[4] ?? null` |
| 备份按字典序排 → `restore` 挑到过期那份（目录里混了两种时间戳格式） | `listBackups` 打印的"最新"其实不是最新 | `cvr-config.js` + `store.js` 改按 `mtimeMs` 排，名字作 tiebreak；测试用 `utimesSync` 钉 mtime 复现 |
| `stop()` 连 `profiles.yaml` 一起回滚 → 撤销用户刚激活的订阅；`activate` 因 reload 404 被误报失败 | `proxy_core_stop` 后当前订阅变回旧的那条 | `stop` 收窄到 `SESSION_RESTORE_NAMES=['verge.yaml']`；`activate` 改回 `{reloaded, needsRestart, note}` 如实上报 |

每一个都先写红测试、改代码、再跑全量（147 → 148 → 150 → 152 → 153 → **154**，`# fail 0`），并且**同时把 fake 改成和真机一样**——否则同类 bug 下次还会从 fake 的缝里钻出来。

---

## 收尾现场核对

```
$ tasklist | grep -i -E 'clash-verge|verge-mihomo'
(CVR 进程已退出)
$ netstat -ano -p tcp | grep -E ':(7897|9097)\b'
(7897/9097 未监听)
$ node qvp-reg.js
ProxyEnable = 0x0
ProxyServer = 127.0.0.1:7897        ← CVR 自己写的，基线里没有；ProxyEnable=0 故惰性
ProxyOverride = localhost;127.*;…   ← 同上
$ 配置哈希
verge.yaml 1685d55c4dd5d3ff == 基线
config.yaml 995b9d6c703229d4 == 基线
profiles.yaml f2dfaeb510fe77ca（用户主动的订阅切换；原始字节在 profiles.yaml.20260930-123930-488-001.bak）
clash-verge.yaml 8e3e41c9ea3116fe（CVR 13:06:49 自己重写；插件从不写这个文件）
$ 订阅清单
1 条：TESTUID1ef15 /「示例机场(新)」/ 15 节点 / remark="2026-09-30 换地址"
旧条目 TESTUIDd7225 已删除，内容文件在 ~/.qoder/vpn-proxy/.trash/，可放回撤销
$ 安装副本与开发副本
cmp server/*.js test/*.js README.md skills/vpn-proxy/SKILL.md .qoder-plugin/plugin.json .mcp.json hooks/hooks.json → 无差异
```

## 未闭环清单

1. 验收 4 / 9 的 Qoder 集成层（工具可见性、hook 是否真注入、`@local` source 能否加载）—— 等用户重启。
2. `proxy_test` 默认 5000ms timeout 在冷核心上误报 —— 已记录，未改。
3. ~~`backups/profiles.yaml.*` 含原始 token，无保留期策略~~ —— **已由用户决定并实现（①，计划 Task 18）**：`proxy_restore_config prune=true`。残留局限见上面"后记"。
4. CVR 遗留的 `ProxyServer`/`ProxyOverride` 注册表值 —— 用户收尾时提了这条（②），但**措辞是"值否清掉"，读不出是"是否要清"还是在指示"清掉"**；插件按前提从不写注册表，删除它属于对用户机器的不可逆改动，必须先确认语义再动手。当前状态：`ProxyEnable=0x0`，两值惰性。
5. ~~"Qoder 模型请求要不要走代理"仍未回答~~ —— **用户已定（③）：不走**。已写进 SKILL.md 边界与 spec §8。
6. **推送前的新增阻塞（本次核查发现，比上面几条都严重）**：spec §2 曾把订阅 URL 的完整路径段写进事实表，计划里 `redactUrl('…?token=<完整 token>')` 那行测试样例曾带**完整 32 位 token**。逐提交扫描全部 31 个提交把范围钉准：**6 个提交的树里仍带完整 token** —— master 的 `ecd10fd`/`d75f7e8`/`37b1d6c`/`0f8410a` 加分支早期的 `c9fdb9e`/`7673dd0`；分支从 `9957740`（Task 5）起树里已无真 token，**tip 干净**（HEAD 全仓只剩合成 fixture `token=0123…`，计划与本文档只剩 8 字符 grep 前缀）。但 PR 的 base 必须是 master，分支自身历史也带着那 6 个 blob，所以"只推 feature 分支"同样会泄露。本仓库至今 `git remote -v` 为空、`gh` 不在 PATH，所以尚未有任何内容外泄 —— 属可避免，不是已发生。可选处置：① 机场面板先轮换 token（最彻底；轮换后计划与本文档里那四个 8 字符 grep 前缀要一起更新）；② 重写那 6 个提交里对应的行（目前没有 remote，重写成本极低，但属破坏性 git 操作，需显式同意）；③ **推一份不含历史的干净快照**：从当前 tip 建 orphan 分支作为 base + 工作分支，公开的任何 blob 里都不含秘密，代价是丢掉逐任务的提交粒度；④ 暂不推。未选定前**不执行任何 push**；选定后还需要用户给出 remote URL 与仓库可见性（公开/私有），且 `gh` 缺失意味着 PR 只能用 API token 或网页手工创建。
