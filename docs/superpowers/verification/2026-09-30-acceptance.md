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
1. 第一版输出里 `direct.totalMs` 是 `null`（上面这段是修复后的重跑）。原因是 curl 8.17.0 在连接失败时 `%{remote_ip}` 打的是空串，`parseCurlOut` 的四段正则整行匹配失败，把耗时一起丢了。已按 TDD 修（commit `572c599`），并补了两条测试锁住"失败行也要有耗时"。
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

**证据**：全程 `ProxyEnable` 读回 `0x0`（见验收 1 末行，以及收尾现场核对）；`enableTunMode:false`、`core.tunEnabled:false`；插件代码里唯一的写路径是 `%APPDATA%` 下的 `verge.yaml`/`profiles.yaml` 文件、`~/.npmrc` 与 git 全局配置，外部命令只有 CVR 启动、`taskkill`、`curl`，另有**只读**的 `tasklist`（判进程是否退出）与 `reg query … /v ProxyEnable`（缺陷 8 修复加的复查）—— **没有任何注册表写操作**，测试里还专门断言了 `reg` 只能以 `query` 形态出现。

**结论**：达成，但**中途真实破防过一次**（缺陷 8，见下面"破防记录"）。"插件不写注册表"不等于"系统代理不会被打开了" —— `proxy_core_stop` 的还原时序会让 CVR 自己去写。

**破防记录（缺陷 8，15:16 收尾核查时发现）**：验收 9 那轮 `proxy_core_stop` 之后现场是

```
tasklist → clash-verge.exe / verge-mihomo.exe 都已退出
netstat  → 127.0.0.1:7897 无人监听
reg query ProxyEnable → 0x1        ← 浏览器此刻全线"连接被拒绝"
```

原因：`stop()` 在 `taskkill` 之后**立刻** `copyFileSync` 还原 `verge.yaml`，而文件里 `enable_system_proxy` 本来就是 `true`；CVR 进程还在拆除中读到这份"已还原"的配置，就按它把系统代理重新打开了。核心随后消失，开关留着 —— 插件一行注册表代码都没写，却造成了整机影响。

处置（当场，按用户"注册表不要清掉"的边界只做最小修复）：

```
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f
读回 → ProxyEnable 0x0        （ProxyServer / ProxyOverride 一字未动，保持用户决定的"不清"）
```

修复（TDD，红 → 绿）：`stop()` 改成 `taskkill` → `waitForExit()` 轮询 `tasklist /FI "IMAGENAME eq <image>" /NH`（按镜像名子串判活，绕开 tasklist 中文提示的 GBK 乱码）→ 进程确实没了才 `restore(['verge.yaml'])`；等不到也照样还原（不能把压制永久留着），但把 `stillRunning` 与一句警告报出来；还原后再只读复查 `ProxyEnable`，若仍为 1 就回 `systemProxyEnabled:true` + 带 `reg add` 全命令的警告，**由用户执行，插件不代写**。四条新测试：还原必须晚于最后一次轮询（且只还原一次）、杀不掉时有上限且仍还原并上报、泄漏必须被报出且事件里不许出现 `reg add`/`reg delete`、`waitForExit` 吃 GBK Buffer。真机复验：完整 `start → stop` 两轮，`ProxyEnable` 全程 `0x0`：

```
调用前 ProxyEnable = 0x0
start -> pipe {"mixed":7897,"socks":7898,"http":7899} systemProxySuppressed = true
运行中 ProxyEnable = 0x0
stop -> {"killed":["clash-verge.exe","verge-mihomo.exe"],"restored":true,"stillRunning":[],"systemProxyEnabled":false,"warnings":[]}
停止后 ProxyEnable = 0x0
```

（红 → 绿也单独证过：把 `waitForExit` 那行换成旧行为，两条新测试立刻 fail，恢复后 22/22。）

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

**结论（初测时）**：**半成品**。"核心关闭时不崩不挂、给出修复提示"这一半已经用真机命令证明（`kind` 是 `channel_unavailable` 而不是 `core_not_running`，两者都在计划 §"proxy_status 例外约定"允许的两态之内，且 hint 直接给出下一步工具）；"17 个工具在 Qoder 里可见"这一半**必须重启 Qoder 才能验证**，见验收 9 一并处理。

**遗留问题**：
1. `proxy_test` 默认 timeout 5000ms 在冷核心上会全员误报超时。已确认是默认值偏紧，本次未改（改动会影响测速语义），记在这里：第一次测速建议显式传 `timeout: 8000`，或先跑一条 `proxy_env`/`proxy_diagnose` 把链路热起来。
2. ~~验收 4 的工具可见性未闭环，等用户重启~~ → 见下面"重启后补测"，**已闭环**。

### 重启后补测（用户重启 Qoder 之后，同一天的后半程）

重启确实发生了，而且**这一轮才第一次真正暴露出插件在 Qoder 里的样子**。四条证据：

**A. 17 个工具在 Qoder 侧可见（验收 4 的后一半达成）**

```
mcp_list({keyword:"vpn-proxy"}) → "total": 17
mcp__plugin_qoder-vpn-proxy_vpn-proxy__proxy_{status,detect,core_start,core_stop,nodes,select,
test,env,toolconfig,subscriptions,subscription_add,subscription_edit,subscription_update,
subscription_activate,subscription_remove,diagnose,restore_config}
```

`@local` 这个 source 能被加载（spec §8 最后一项一并结），插件的 skill 也出现在技能列表里（`qoder-vpn-proxy:vpn-proxy`）。

**B. 真机调用发现缺陷 5：Qoder 给 MCP 子进程的环境里没有 `APPDATA`**

在会话里直接调 `proxy_status`，回的是：

```
{"ok":true,"data":{"installed":false,"running":false,"configDir":null,
 "installDir":"C:\\Program Files\\Clash Verge",
 "warnings":["未找到配置目录（APPDATA=空 下的 io.github.clash-verge-rev.clash-verge-rev，也没有 QVP_CONFIG_DIR）"],
 "core":{"reachable":false,"kind":"not_installed","message":"未检测到 Clash Verge Rev 的安装与配置目录"}}}
$ proxy_nodes {} → {"ok":false,"kind":"not_installed", …}
```

而这台机器上 CVR **确实装着**：`<HOME>\AppData\Roaming\io.github.clash-verge-rev.clash-verge-rev` 完整存在（`config.yaml`/`profiles.yaml`/`verge.yaml` 等），Git Bash 里 `APPDATA` 也有值。**同一段代码在 CLI 环境下 `installed:true`，在 Qoder 拉起的进程里 `installed:false`** —— 原因是 `resolveConfigDir()` 只认 `env.APPDATA`，缺失后直接退到 POSIX 的 `~/.config`，Windows 上必然找不到。`ProgramFiles` 却没被吞（`installDir` 正常解析），所以缺的只有 `APPDATA` 这一个变量。

后果比"看不出来"严重：`proxy_subscriptions`、`proxy_core_start`、`proxy_diagnose`、`proxy_restore_config` 全部会误报未安装；SessionStart hook 更是永远判定"没装 CVR"而永不注入 —— 也就是说验收 9 的"不注入"在修复前是**假阳性**：不是"检测到核心没跑所以不注入"，而是"根本没检测到装着"。

**处置（test-first，缺陷表第 5 条）**：`resolveConfigDir` 在 `APPDATA` 缺失时从 home 派生 `%USERPROFILE%\AppData\Roaming`；`APPDATA` 有值时仍以它为准（用户自定义位置不能被覆盖）；POSIX 分支原样保留。新增 1 条 discovery 测试（四个断言，含"APPDATA 有值时不能改查 home"与"哪里都没有仍是 null"），全套 **160 tests / 0 fail**。

**C. 修复后的端到端复现（用已安装副本 + 剥掉 APPDATA 的子进程）**

```
spawn …\.qoder\plugins\cache\local\qoder-vpn-proxy\0.1.0\server\index.js | APPDATA in child env: absent
installed = true
configDir = <HOME>\AppData\Roaming\io.github.clash-verge-rev.clash-verge-rev | source = config.yaml
warnings  = []
core      = channel_unavailable | mihomo 控制器不可达（命名管道 \\.\pipe\verge-mihomo: GET /version 连接失败: ENOENT）
```

这同时是"核心关闭时返回可读错误而不是崩或挂起"的又一条证据：走 JSON-RPC stdio，秒级返回，`proxy_status` 保持 `{ok:true}` + `core.kind`，`proxy_nodes` 保持 `{ok:false}`。

**D. Task 18 的 prune 在真服务端可用**

```
tools/list 数量 = 17
proxy_restore_config 参数 = name, listOnly, prune, keepPerName, olderThanDays, dryRun
prune dryRun => ok: true | scanned: 15 | would delete: 5 | keep: 10 | dryRun flag: true
```

待删的 5 个都是较早的 `profiles.yaml.*.bak`（`reason:count`），即多余的 token 副本；**只跑了 dryRun，没真删**，等用户点头。

**仍未闭环（诚实的部分）**：本会话正在用的那个 MCP 进程是 **12:38 启动的**（`mcp.log` 最后一行"server 启动"在 12:38:04，而文件同步发生在 13:54），所以**它内存里的 `proxy_restore_config` 还没有 `prune` 参数**，`proxy_status` 也还回 `installed:false` —— 上面 C/D 两条是拿同一份已安装文件另起子进程证明的，不是从当前会话的 MCP 通道拿到的。下一次重启 Qoder 后，会话里才应看到 `prune`。**在此之前不能宣称缺陷 5 已在 Qoder 内闭环。**

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
1. `activate` 第一次返回 `{"ok":false,"kind":"channel_unavailable","message":"POST /configs/reload -> HTTP 404 404 page not found"}` —— **mihomo v1.19.25 根本没有 reload 端点**（CVR 走 GUI 侧的 profile 切换，不走这个 REST 路径）。注册表写入其实已经成功。已按 TDD 改成如实上报（commit `ba63223`）：`reloaded` / `needsRestart` / `note` 三个字段明说"profiles.yaml 已改，需 `proxy_core_stop` + `proxy_core_start`（或 GUI 点一下该订阅）才真正加载新节点"。
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

**遗留问题**：早期版本的 `listBackups` 把备份按**文件名字典序**排，而目录里混着两种时间戳格式（`20260930-123930-488-001` 带连字符、`20260930130959726-001` 不带），于是"最新一份"会挑到过期那份，`restore` 会退回更老的状态。已按 TDD 改成按 mtime 排（commit `54a308b`），并用 `utimesSync` 钉住 mtime 的测试复现了原 bug。同类地，`stop()` 原本连 `profiles.yaml` 一起回滚，会撤销用户刚切的订阅 —— 已收窄到 `SESSION_RESTORE_NAMES = ['verge.yaml']`，上面那条 `stop` 返回体的 `restoredList` 只有一项 `verge.yaml` 就是它的直接证据。

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

**结论（初测时）**：**代码层达成，Qoder 集成层待重启验证**。hook 脚本在 CVR 未运行时确实输出空串（不注入）；但"重启后新会话开头看不到代理提示 / 启动 CVR 后新会话才出现提示"只能在真实 Qoder 会话里看，而重启会结束当前会话。

**重启后的实测（同一天后半程）**

原列的三件事，逐条对号：

1. **工具可见性 → 达成**。新会话里 17 个工具全在，但**实际前缀是 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__proxy_*`**，不是当初预测的 `mcp__vpn-proxy__*` —— 名字里带了插件 source 与插件名两段。核心关闭时的调用（`proxy_status`、`proxy_nodes`）都是秒级返回的 `{ok:…}` 信封，没有挂起，见验收 4 的补测 C。
2. **`@local` source 能否加载 → 能**。`installed_plugins_v2.json` 里 `qoder-vpn-proxy@local`（值是**数组**）+ `settings.json` 的 `enabledPlugins` 这一组合被 Qoder 正常识别，插件的 skill 同时出现在技能列表里。spec §8 最后一项就此结掉。
3. **"CVR 未运行时不注入" → 现象符合，但这条**不能算已证明**，本项仍是开放的。

第 3 条要说清楚当时为什么不算数。本会话收到的 SessionStart 注入只有环境路由那一段，确实没有任何代理文本；CVR 也确认真的没跑（`tasklist` 无 `clash-verge`/`verge-mihomo`，`netstat` 上 7897/7898/7899 都没监听）。**但缺陷 5 让这个观察失去区分力**：修复前 `resolveConfigDir` 在 Qoder 的子进程环境里拿不到 `APPDATA`，hook 里的 discovery 会一路退到"这台机器没装 CVR"，于是**无论 CVR 跑没跑都必然输出空串**。观测到的现象和"设计正确"之间断了一环 —— 这是假阳性，不是验证。（第二次重启后的实测见下一节：真正让 hook 吐空的是缺陷 6，`node` 那一步压根没执行到。）

要真正把验收 9 结掉，需要两步（都要用户配合）：① **再重启一次 Qoder**，让新代码进入 hook 与 MCP 进程；② 开着 CVR 触发一次 SessionStart（新会话，或 `/clear`、`/compact` —— matcher 是 `startup|resume|clear|compact`），确认注入出现"本机代理端口可连通"那段；然后再停掉 CVR 复看一次不注入。在①之前，"不注入"这个观察无论重复多少次都不构成证据。

**第二次重启后的实测（14:58，另发现缺陷 6 与缺陷 7）**

第 ① 步做到了，而且立刻见效：`mcp_get(proxy_restore_config)` 的 schema 已带 `prune / keepPerName / olderThanDays / dryRun`，会话内 `proxy_status` 回 `installed:true`、`configDir` 正确、`warnings:[]` —— 缺陷 5 与 `prune` 都进了正在服务的那个进程。

但第 ② 步之前，先按 §333 给的排查顺序去日志里查"hook 压根没被调用"这一支，结论是**调用到了，但每次都崩**：

```
$ grep vpn-proxy ~/.qoder/logs/latest/qodercli.log | grep hook
14:58:19.648 INFO  hook.started  hook_name="SessionStart:startup" source="plugins" hook_index=3 total_hooks=3
                  display_text="\"${QODER_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start"
                  plugin_id="qoder-vpn-proxy@local"
14:58:19.818 WARN  [HookRunner] Hook "..." (event: SessionStart) exited with code 255.
                  stderr: 文件名、目录名或卷标语法不正确。      ← GBK 码页下的 cmd.exe 报错
14:58:19.819 WARN  hook.finished ... success=false duration_ms=170 exit_code=255
```

同一次启动里，superpowers 插件的 SessionStart hook **命令串形态完全相同**（`${QODER_PLUGIN_ROOT}/hooks/run-hook.cmd session-start`，同样 LF 换行、同样的 `: << 'CMDBLOCK'` 双语种 wrapper），却 `success=true exit_code=0`。逐字节对比两份 `run-hook.cmd`，唯一差异是**我的那份批处理段里写了中文注释**。

最小复现（把 Qoder 的调用形态照抄成脚本跑两个插件）：

```
$ bash qvp-hook-repro.sh 'C:\Users\...\local\qoder-vpn-proxy\0.1.0' session-start
== exit=255
== output: <HOME>\...>OK_DIR%~1"   ← cmd.exe 已经错位到行中间
                        ...>ram Files (x86)\Git\bin\bash.exe" (
$ bash qvp-hook-repro.sh 'C:\Users\...\superpowers\6.3.0' session-start
== exit=0    （正常吐出 additionalContext）
```

根因（缺陷 6）：cmd.exe 用**当前 OEM 码页**（本机 GBK/936）读批处理文件，UTF-8 中文注释被按双字节切分，行首偏移就此错位，后续每一行都从中间开始解析 —— 于是 `if exist "C:\Program Files\Git\bin\bash.exe" (` 被读成 `ram Files (x86)\...`，最终撞出"文件名、目录名或卷标语法不正确"并以 255 退出。**`node server/session-start.js` 从未被执行**，所以修复缺陷 5 之后"CVR 没跑 ⇒ 不注入"依然是**二次假阳性**：真正的原因是 hook 进程根本没跑到判断那一步。

修复按 TDD 走：先加断言"launcher 必须零非 ASCII 字节"的测试（红：`发现 216 个非 ASCII 字节，首个在第 3 行`），再把 `hooks/run-hook.cmd` 的注释全部改回英文（文件里留了一条 `KEEP THIS FILE PURE ASCII` 说明为什么），全量 **161/161** 绿。同步进安装副本后用同一个复现脚本回归：

```
== exit=0
== output: {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}   ← CVR 未运行，正确不注入
```

正向分支用 `proxy_core_start`（scope=session，压制系统代理）临时拉起 CVR 再跑一次：

```
additionalContext = "本机 Clash Verge 代理端口 127.0.0.1:7897 当前可连通（插件 qoder-vpn-proxy 检测）。
                     直连失败时，联网命令请加前缀：HTTP_PROXY=http://127.0.0.1:7897 ... "
$ reg query "HKCU\...\Internet Settings" → ProxyEnable 0x0     ← 前提仍然成立：拉起 CVR 没打开系统代理
$ proxy_core_stop → killed [clash-verge.exe, verge-mihomo.exe], restoredList 只有 verge.yaml（profiles.yaml 不再被撤销）
$ 再跑一次 hook → additionalContext = ""                        ← 停核心后回到不注入
```

顺带查出缺陷 7：注入文案里把工具写成 `mcp__vpn-proxy__proxy_diagnose`，而 Qoder 实际暴露的全名是 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__proxy_diagnose`（见本节第 1 条）—— 模型照文案调用必然找不到工具。已改文案并同步。

**验收 9 现在的状态：两条分支都在真实 Qoder 会话里观测到了，本项闭环。**

最后这一步没有再麻烦用户重启，改用 `mcp__builtin__create_chat_session` 拉起一个**全新的 Qoder 会话**（matcher 里 `startup` 命中，SessionStart 钩子照常跑），让那个会话逐字复述它收到的开场附加上下文：

```
15:14:45  proxy_core_start → scope=session, systemProxySuppressed:true, ports 7897/7898/7899
          netstat → 127.0.0.1:7897 LISTENING (pid 38656)
15:15:00  新会话 f7fe8738（CVR 在跑）逐字引用到的注入原文：
          "本机 Clash Verge 代理端口 127.0.0.1:7897 当前可连通（插件 qoder-vpn-proxy 检测）。
           直连失败时，联网命令请加前缀：HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=…
           NO_PROXY=\"127.0.0.1,localhost,::1,*.cn,…\" npm/git 想长期走代理用
           mcp__plugin_qoder-vpn-proxy_vpn-proxy__proxy_toolconfig(action=apply)；…
           注意：系统代理未开启，本提示只影响命令行工具；Qoder 自身请求建议保持直连。"
          $ reg query "HKCU\...\Internet Settings" → ProxyEnable 0x0   ← 前提成立：拉起 CVR 没打开系统代理
15:14:xx  proxy_core_stop → killed [clash-verge.exe, verge-mihomo.exe]，restoredList 只有 verge.yaml
          （这一步当时看着完美；十几分钟后收尾核查才发现它把 ProxyEnable 留成了 0x1 —— 缺陷 8，见验收 3"破防记录"）
15:16:29  新会话 aec483cd（端口已关）明确回答"没有"，并逐项排除了三类干扰来源：
          它上下文里出现的 17 个 vpn-proxy 工具名与 qoder-vpn-proxy:vpn-proxy 技能属于**静态注册表**，
          MEMORY.md 里的 Clash Verge 条目属于**跨会话记忆**，都不是本次 SessionStart 注入 ——
          排除后没有任何块承载"7897 / 代理端口"字样。
```

正向（核心在跑 ⇒ 注入落地，且工具名是能被调用的全名）与负向（核心停了 ⇒ 不注入）各拿到一次真会话证据，且这轮跑的是修好的 ASCII launcher —— 缺陷 6 的正主 `node server/session-start.js` 这次确实执行到了。

顺带收下那个会话提的一条建议，但它**不改**：它建议"hook 未注入时额外说明'工具已注册但不代表代理可用'"。这与验收 9 的前提冲突（CVR 未运行时必须完全静默），而"工具注册 ≠ 代理可用"已经写在 SKILL.md 的边界一节里，不需要靠开场提示重复一遍。

复核路径（下次怀疑 hook 时照这个顺序）：`~/.qoder/logs/latest/qodercli.log` 的 `hook.started` / `hook.finished` → launcher 是否纯 ASCII → `hooks.json` 是否被读到 → `run-hook.cmd` 在 bash 下能否跑通 `node server/session-start.js` → 是否 5 秒内退出。原始三步来自 `docs/superpowers/probes/02-hooks.md` §4，前两步是本轮新加的。


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

## 本轮真机跑出来的 8 个缺陷（1–4 同源：测试替身没像真机；5–7 同源：宿主环境/命名没像开发 shell；8：进程生命周期时序）

| 缺陷 | 触发方式 | 修复 |
|---|---|---|
| `PUT /configs` 被 v1.19.25 静默吞掉（回 204 但 mode/tun 不变） | `proxy_select {mode}` 无效，GUI 不动 | `clash-client.js` 改 `PATCH`；`fake-mihomo.js` 里 PUT 分支改为"回 204 但不改状态"，两条测试锁住 |
| curl 失败行 `%{remote_ip}` 是空串 → `parseCurlOut` 整行不匹配，耗时一起丢 | `proxy_diagnose` 的 `direct.totalMs:null` | `diagnose.js` 第 4 段改可选 `(?:\s+(\S+))?`，`remoteIp: m[4] ?? null` |
| 备份按字典序排 → `restore` 挑到过期那份（目录里混了两种时间戳格式） | `listBackups` 打印的"最新"其实不是最新 | `cvr-config.js` + `store.js` 改按 `mtimeMs` 排，名字作 tiebreak；测试用 `utimesSync` 钉 mtime 复现 |
| `stop()` 连 `profiles.yaml` 一起回滚 → 撤销用户刚激活的订阅；`activate` 因 reload 404 被误报失败 | `proxy_core_stop` 后当前订阅变回旧的那条 | `stop` 收窄到 `SESSION_RESTORE_NAMES=['verge.yaml']`；`activate` 改回 `{reloaded, needsRestart, note}` 如实上报 |
| **（第 5 个，类别不同）Qoder 拉起的 MCP/hook 子进程没有 `APPDATA`** → `resolveConfigDir` 退到 `~/.config`，装着 CVR 的机器被报成未安装，hook 永不注入 | 会话内调 `proxy_status` 回 `installed:false` + `warnings:["…APPDATA=空…"]`，而同一段代码在 CLI 下回 `installed:true` | `discovery.js` 在 `APPDATA` 缺失时从 home 派生 `AppData/Roaming`（有 `APPDATA` 时仍以它为准）。前 4 个是"测试替身不像真机"，这一个是**"宿主环境不像开发 shell"** —— 单测与 CLI 手测都摸不到，只有真在 Qoder 里调用才暴露 |
| **（第 6 个）`hooks/run-hook.cmd` 里的中文注释让 cmd.exe 解析错位 → hook 每次 exit 255，`node` 从未执行** | Qoder 日志 `hook.finished success=false exit_code=255` + stderr"文件名、目录名或卷标语法不正确"；同形状的 superpowers launcher 同一次启动里 exit 0。把 Qoder 的调用形态抄成脚本即可稳定复现 | launcher 全文改回纯 ASCII（cmd.exe 按 OEM 码页 GBK 读批处理，UTF-8 多字节注释会把行首偏移切错）。新增测试断言"launcher 零非 ASCII 字节"，红 → 修 → 全量 161/0。**教训**：双语种 polyglot launcher 的批处理段只能放 ASCII；解释性中文放到 bash 段或 README 里 |
| **（第 7 个）注入文案里的工具名是猜的**：写成 `mcp__vpn-proxy__proxy_diagnose`，Qoder 实际暴露 `mcp__plugin_qoder-vpn-proxy_vpn-proxy__proxy_diagnose` | 会话内列出工具时看到真实前缀（`mcp_list` 返回 17 个全名），与 hook 文案对不上 —— 模型照文案调用必然"工具不存在" | `session-start.js` 文案改用实测全名，先把测试断言换成全名跑红再修。**教训**：给模型看的工具名必须从运行时列出来的清单里抄，不能按插件名拼 |

| **（第 8 个）`stop()` 在 CVR 还在拆除时就还原 `verge.yaml`，CVR 于是把系统代理重新打开** —— 核心已停、`ProxyEnable=0x1`、7897 无人监听，浏览器全线"连接被拒绝" | 15:16 收尾例行核查 `reg query ProxyEnable` 时发现；插件全仓没有一行注册表写代码，却造成了整机影响（验收 3 破防） | `stop()` 拆成 `taskkill` → `waitForExit()`（轮询 `tasklist /FI "IMAGENAME eq …"`，按镜像名子串判活以躲开 GBK 中文提示）→ 才 `restore(['verge.yaml'])`；等不到也还原，但回 `stillRunning` + 警告；还原后只读复查 `ProxyEnable`，为 1 时把 `reg add … /d 0 /f` 原文交给用户执行（插件不代写）。新增 4 条测试，红 → 修 → 全量 **165 / 0 fail**，真机 `start→stop` 两轮 `ProxyEnable` 恒为 `0x0`。**教训**：验证"不影响其他应用"不能只看代码里有没有写注册表，要看**外部程序会不会替我们写**；进程生命周期是有延迟的，杀进程和改它的配置之间必须有一次"真的退出了吗"的确认 |

前 4 个都先写红测试、改代码、再跑全量（147 → 148 → 150 → 152 → 153 → **154**，`# fail 0`），并且**同时把 fake 改成和真机一样**——否则同类 bug 下次还会从 fake 的缝里钻出来。第 5 个在重启后补测时发现，红测试 + 修复后全量 **160 / 0 fail**（中间加 Task 18 的 prune 5 条：154 → 159 → 160）。第 6、7 个在第二次重启时发现，同样红 → 修 → **161 / 0 fail**。第 8 个在验收全部闭环后的收尾核查里才冒出来 —— 它不是调用失败，而是"成功返回却把机器改坏了"，只有对照设计前提去读注册表才看得见，所以以后每轮 `proxy_core_stop` 之后都要再读一次 `ProxyEnable`。

---

## 收尾现场核对

```
（下面是缺陷 8 修复复验后的最新一次核对，15:3x；比首次收尾多跑了三轮 start→stop）
$ tasklist /FI "IMAGENAME eq clash-verge.exe" → 没有运行的任务
$ tasklist /FI "IMAGENAME eq verge-mihomo.exe" → 没有运行的任务
$ netstat -ano -p tcp | grep ':7897' | grep LISTENING → 0 条
  （另有若干 FIN_WAIT_2 残留，是被 kill 掉的 pid 38656 的在途连接，会自己消失）
$ reg query "HKCU\...\Internet Settings"
ProxyEnable = 0x0                     ← 缺陷 8 修好后两轮启停都没再被打开
ProxyServer = 127.0.0.1:7897          ← CVR 自己写的，基线里没有；用户已定"不清"
ProxyOverride = localhost;127.*;…     ← 同上
$ 配置哈希（sha256 前 16 位）
verge.yaml 1685d55c4dd5d3ff == 基线   ← stop 的还原是对的，压制没留痕
config.yaml 995b9d6c703229d4 == 基线
profiles.yaml 155b55c511e267b3（首次收尾是 f2dfaeb510fe77ca；CVR 启停时自己重写元数据，current 仍是用户选的 TESTUID1ef15）
clash-verge.yaml 01441c4bdf3fdf32（CVR 自己的运行时文件；插件从不写它）
$ 订阅清单
1 条：TESTUID1ef15 /「示例机场(新)」/ 15 节点 / remark="2026-09-30 换地址"
旧条目 TESTUIDd7225 已删除，内容文件在 ~/.qoder/vpn-proxy/.trash/，可放回撤销
$ prune（只跑了 dryRun，真删等用户点头）
~/.qoder/vpn-proxy/backups 现有 27 个文件；keepPerName=5 / olderThanDays=14 的默认策略下
wouldDelete 16、kept 11、failed 0，删除原因全是 "count"（同一名备份超出 5 份的最新保留数）
$ 安装副本与开发副本
diff -rq server hooks skills + cmp .qoder-plugin/plugin.json → 无差异；
安装副本自己跑 node --test --test-force-exit → 165 tests / 165 pass / 0 fail
```

## 未闭环清单

1. ~~验收 4 的 Qoder 集成层~~ —— **已闭环**：第二次重启后会话内实测 `installed:true`、schema 带 `prune`，缺陷 5 与 prune 都进了正在服务的进程。~~验收 9~~ —— **也已闭环**：查明 hook 一直被调用却每次崩溃（缺陷 6），修成纯 ASCII launcher 后，正向与负向两条分支都用 `create_chat_session` 拉起的**全新真实会话**各观测到一次（15:15 注入逐字落地 / 15:16 完全不注入），见该节末尾。
2. `proxy_test` 默认 5000ms timeout 在冷核心上误报 —— 已记录，未改。
3. ~~`backups/profiles.yaml.*` 含原始 token，无保留期策略~~ —— **已由用户决定并实现（①，计划 Task 18）**：`proxy_restore_config prune=true`。残留局限见上面"后记"。
4. ~~CVR 遗留的 `ProxyServer`/`ProxyOverride` 注册表值~~ —— **用户已定（②追问后）："注册表不要清掉"**。两个值保持现状、插件与用户都不动它们；当前 `ProxyServer=127.0.0.1:7897`、`ProxyOverride=localhost;127.*;…` 仍在原位，`ProxyEnable=0` 使它们惰性（系统代理仍关闭，浏览器/游戏不受影响）。**但要说清一件事**：15:16 那次缺陷 8 让 `ProxyEnable` 变成过 `0x1`，我按上面"破防记录"里的命令把它写回 `0x0` —— 这是**唯一一次**注册表写入，且写回的是本机基线值（把 CVR 造成的偏离恢复原样），不是清理用户数据。除此之外本轮收尾未对机器产生任何不可逆改动。
5. ~~"Qoder 模型请求要不要走代理"仍未回答~~ —— **用户已定（③）：不走**。已写进 SKILL.md 边界与 spec §8。
6. ~~推送前的凭据阻塞~~ —— **已按用户选的 ② 重写完成**（17:1x–17:3x）。核查先纠正了两件事：
   - **范围比"6 个提交"大，而且凭据不止一个 token**。用本机全部来源配对（`profiles.yaml`、store 里保留的 11 份备份、`.trash`、会话 transcript）得到的最终清单是 **1 个 32 位 token + 2 个 20 位订阅路径段** —— 第二个路径段是换链接之前的旧地址，只活在历史文档里，从当前配置现取凭据的做法会漏掉它。逐提交精确矩阵：token 命中 4 个 blob、两个路径段各命中 13 个 blob，**29/36 个提交的树带凭据**，master tip 自己带 5 个。
   - **只扫 `.md` 会漏**。`redact.test.js` 的**两个历史版本**里带真 token（tip 上是合成 fixture，所以"tip 干净"这个结论本身没错，但按 tip 判断范围会低估历史）。
   **做法**：先把原历史 `git bundle` 存档并 verify（`Temp/qvp-pre-scrub.bundle`），在**它的克隆**里预演一遍再动真仓库。用 `filter-branch --index-filter` 直接改索引、不做 checkout —— 实测 `--tree-filter` 在这台机器上会把整棵树换成 CRLF（`core.autocrlf=true` 且 master 上没有 `.gitattributes`），而且 `git archive | tar -x` 提取出来的文件每个都"看起来变了"，逐行对比会得出 5761 行全改的假象。替换规则：真 token → 仓库既有的合成 fixture、真路径段 → `SUBPATH`。**6/8 位前缀规则试过就撤**：它命中了文档里 `UID_ALPHABET` 常量的字面量（误伤），而 8/32 位前缀不构成可用凭据，用户已决定保留它们作 grep 锚点。
   **验证**（克隆与真仓库各一遍）：`0 / 36` 提交命中；提交数 36→36；父链同构 `ok=35 root=1 bad=0`；36 对提交之间只有 3 个文件变动（spec ×29、plan ×14、`redact.test.js` ×2）；**分支 tip 的 tree hash 与重写前逐字节相同**（`3e251f0343dded12dbb99a228f140ed6507c228a`），即工作成果没被动过；master tip 只改那两份文档；重写后 `node --test` 165/165。**清不可达对象单跑 `git gc --prune=now` 不够**（克隆里实测残留 20 个旧 blob），要 `git repack -adf --unpack-unreachable=now` + `git prune --expire=now`，对象数 477→361 才归零；之后用**通用模式探测器**（不看清单，只按 `token=<32hex>` 与 16–24 位路径段的形状）扫全部对象 **0 命中**。文档里 15 处旧提交短哈希引用已按映射表换新（`6808775` 那处是配额字节数，不是哈希，属误报）。
   用户已给出处置（18:0x）：**仓库可见性 = 公开**、**PR 走"我推送 + 用户在网页手工建"**、**推送认证 = Git Credential Manager 弹窗**（本机 `credential.helper=helper-selector`，无 SSH 密钥、无 `.git-credentials`）、**直连优先，失败再由本插件的 per-host git 代理键走 `127.0.0.1:7897`**。仍然只缺 **remote URL**（不猜地址）。在拿到它之前不执行任何 push。域名那条新阻塞见下面第 9 条。
7. ~~缺陷 8 的修复还没进"正在服务的那个 MCP 进程"~~ —— **第三次重启后已在会话内闭环**（16:59–17:0x）。`mcp_get proxy_core_stop` 的描述已是"等进程确实退出后再把 verge.yaml 还原…"；随后从会话的 MCP 通道跑了一整轮：`proxy_core_start`（scope=session，命名管道可用、7897 在听、运行中 `ProxyEnable=0x0`）→ `proxy_core_stop` 返回 `{"killed":["clash-verge.exe","verge-mihomo.exe"],"restored":true,"restoredList":[{"name":"verge.yaml",…}],"stillRunning":[],"systemProxyEnabled":false,"warnings":[]}` → 独立复查：无残留进程、7897 监听数 0、`ProxyEnable` 仍是 `0x0`、`verge.yaml` 的 `enable_system_proxy` 已回到 `true`。还原列表只有 verge.yaml 一项也对上了新语义（profiles.yaml 属用户持久数据，不由 stop 还原）。
8. ~~`prune` 只跑了 dryRun~~ —— **用户点头后实跑完成**（17:0x）：`scanned 30 / deleted 19 / kept 11 / failed 0`，磁盘核对剩 5 份 `profiles.yaml.*` + 5 份 `verge.yaml.*` + 隐藏的 `.npmrc.20260930125506962-001.bak`，`.trash/` 里的撤销副本（`…-TESTUIDd7225.yaml`、`…-TESTUID6fc25.yaml`）仍在。保留最新 5 份意味着**存活的 5 份备份里仍含原始 token** —— 这是策略本身的选择，不是遗漏；推送前不涉及它们（它们在 `~/.qoder/vpn-proxy/`，不在仓库里）。
9. **公开仓库前的第二轮重写：订阅域名 → 占位主机**（用户选"再抹一次域名"）。凭据清干净之后又查出一层：订阅**主机名本身**还留在 **16 个 blob** 里 —— 分支 tip 早已换成占位（0 命中），但 master tip 的 plan ×7 + spec ×1 仍带原值，而 PR 的 base 必须是 master，所以推上去就等于把"用的是哪家机场"永久公开。做法：`Temp/qvp-pre-domain.bundle` 存档并 verify → 在**它的克隆**里预演 → 用同一套 `filter-branch --index-filter` 把主机名全量换成仓库既有占位约定 `sub.example.invalid`（本文档不复述原值）。**预演与真仓库的结果逐字节一致**：master `2b3a7cc`、分支 `081dce4`、master tip tree `63020e1…` —— 说明这条替换是确定性的，不是碰运气。扫描用的是主机名探测器的形状法（不看清单，把每个 blob 里的 URL 主机名都提出来分类）：仓库里唯一的非公共主机就是这一个，其余 33 种是 `*.test` / `*.example.invalid` 合成 fixture 与 github.com、qoder.com、pypi.org、www.gstatic.com、cp.cloudflare.com 等公共地址。**验证**：提交数 37→37、父链同构 `ok=37 root=0 bad=0`、29/37 对提交树完全未变、变动的只有 3 个路径（spec ×29、plan ×17、`redact.test.js` ×2）、**分支 tip 的 tree hash 仍然逐字节不变**（`4d5bb1ea0695dc6200e55d7abb01b8b001c07856`，工作成果依旧没被动过）、master tip 只改那两份文档、重写后 `node --test` 165/165；purge（`reflog expire` + `repack -adf --unpack-unreachable=now` + `prune` + `gc --prune=now`）后主机名扫描**真域名 0 命中**、`sub.example.invalid` 从 17 个 blob 增至 25 个、凭据形状扫描继续 **0 个 blob**。第二轮又换了全部 37 个哈希，文档里 8 处旧短哈希引用（plan ×5、acceptance ×3）已按映射表换新，复查残留 0。`qvp-pre-domain.bundle` 里仍带域名 —— 本机存档，不外传。
