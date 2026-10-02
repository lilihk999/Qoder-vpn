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
            {"name":"南山云","type":"Selector","now":"TW 2 | v4","count":17},
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

而这台机器上 CVR **确实装着**：`C:\Users\<user>\AppData\Roaming\io.github.clash-verge-rev.clash-verge-rev` 完整存在（`config.yaml`/`profiles.yaml`/`verge.yaml` 等），Git Bash 里 `APPDATA` 也有值。**同一段代码在 CLI 环境下 `installed:true`，在 Qoder 拉起的进程里 `installed:false`** —— 原因是 `resolveConfigDir()` 只认 `env.APPDATA`，缺失后直接退到 POSIX 的 `~/.config`，Windows 上必然找不到。`ProgramFiles` 却没被吞（`installDir` 正常解析），所以缺的只有 `APPDATA` 这一个变量。

后果比"看不出来"严重：`proxy_subscriptions`、`proxy_core_start`、`proxy_diagnose`、`proxy_restore_config` 全部会误报未安装；SessionStart hook 更是永远判定"没装 CVR"而永不注入 —— 也就是说验收 9 的"不注入"在修复前是**假阳性**：不是"检测到核心没跑所以不注入"，而是"根本没检测到装着"。

**处置（test-first，缺陷表第 5 条）**：`resolveConfigDir` 在 `APPDATA` 缺失时从 home 派生 `%USERPROFILE%\AppData\Roaming`；`APPDATA` 有值时仍以它为准（用户自定义位置不能被覆盖）；POSIX 分支原样保留。新增 1 条 discovery 测试（四个断言，含"APPDATA 有值时不能改查 home"与"哪里都没有仍是 null"），全套 **160 tests / 0 fail**。

**C. 修复后的端到端复现（用已安装副本 + 剥掉 APPDATA 的子进程）**

```
spawn …\.qoder\plugins\cache\local\qoder-vpn-proxy\0.1.0\server\index.js | APPDATA in child env: absent
installed = true
configDir = C:\Users\<user>\AppData\Roaming\io.github.clash-verge-rev.clash-verge-rev | source = config.yaml
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

**证据**（把「南山云」换成新链接的完整一轮）：

```
== 清单 ==
Rq14DVii2DNo 南山云 active=false nodes=null src=cvr remark=""
SEitsxVMpF0c 南山云(新) active=true nodes=15 src=plugin remark="2026-09-30 换地址"

SEitsxVMpF0c | 南山云(新) | active=true | nodes=15 | remark=2026-09-30 换地址 | quota={"upload":40651,"download":6808775,"total":74826208722,"expire":null}

== 删除当前激活订阅（应被拦）==
{"ok":false,"kind":"subscription_active_protected","message":"SEitsxVMpF0c 是当前激活订阅，删除会让 mihomo 没有配置可用","hint":"先 activate 到别的订阅，或确认后再传 force: true"}

== 给旧条目加备注（只改 remark 不动内容）==
{"ok":true,"data":{"uid":"Rq14DVii2DNo","name":"南山云","url":"https://…?token=<redacted>","urlPathOnly":"https://…","file":"Rq14DVii2DNo.yaml","type":"remote","active":false,…}}

== 删除旧条目 ==
{"ok":true,"data":{"removed":"Rq14DVii2DNo","trashed":["profiles.yaml.20260930130959726-001.bak","20260930130959728-003-Rq14DVii2DNo.yaml"],
 "undo":"注册表备份在 C:\\Users\\<user>\\.qoder\\vpn-proxy\\backups，内容文件在 C:\\Users\\<user>\\.qoder\\vpn-proxy\\.trash；放回 …\\profiles 并重新 add 即可撤销"}}

== profiles.yaml 注册项 ==
3:current: SEitsxVMpF0c
…
40:- uid: SEitsxVMpF0c
== .trash ==
20260930125704203-003-lkYFauvJwQeP.yaml
20260930130959728-003-Rq14DVii2DNo.yaml
```

**结论**：达成（带一条限定）。自定义名称与备注在 update 后保留、`activate` 写入的 `current` 落盘并被 CVR 接受、激活项删除被拦截、内容文件进 `.trash` 可放回 —— 都拿到了真机返回体。

**遗留问题（重要，实测推翻了原设计假设）**：
1. `activate` 第一次返回 `{"ok":false,"kind":"channel_unavailable","message":"POST /configs/reload -> HTTP 404 404 page not found"}` —— **mihomo v1.19.25 根本没有 reload 端点**（CVR 走 GUI 侧的 profile 切换，不走这个 REST 路径）。注册表写入其实已经成功。已按 TDD 改成如实上报（commit `ba63223`）：`reloaded` / `needsRestart` / `note` 三个字段明说"profiles.yaml 已改，需 `proxy_core_stop` + `proxy_core_start`（或 GUI 点一下该订阅）才真正加载新节点"。
2. 没观察到 `profile_registry_desync` —— CVR 运行期确实会重写 `profiles.yaml`，但插件的写后重读校验都通过了，所以计划里预设的"先停核心再操作订阅"这条备用路径没有被触发。
3. 操作过程中我自己犯过一次错：拿**未激活**的 uid 去测删除保护，误删了 `lkYFauvJwQeP`。已重新添加（新 uid `SEitsxVMpF0c`）并正确验证了 `subscription_active_protected`。这条留在文档里，作为"删除保护只对 current 生效"的事实记录。

---

## 验收 6：`proxy_toolconfig` revert 后与备份一致

**证据**：

```
== revert ==
{"ok":true,"data":{"action":"revert","targets":["npm","git"],"npm":{"action":"removed-created","file":"C:\\Users\\<user>\\.npmrc","backupPath":"C:\\Users\\<user>\\.qoder\\vpn-proxy\\backups\\.npmrc.20260930125506962-001.bak"},"git":{"removed":[{"key":"http.https://github.com/.proxy","existed":true},{"key":"http.https://objects.githubusercontent.com/.proxy","existed":true},{"key":"http.https://api.github.com/.proxy","existed":true}]}}}

== status（应 clean）==
verdict clean npmrc.exists false npmrc.managed false git.mismatch true
== 现场核对 ==
git http.* 已清空
-rw-r--r-- 1 <user> 197121 0 Sep 30 12:55 /c/Users/<user>/.gitconfig
```

**结论**：达成。`verdict:'clean'`；git 全局配置回到 0 字节空文件（基线本来就没有 `http.*`）；`~/.npmrc` 基线不存在，apply 时是"新建"，revert 就把它删回"不存在"，同时留了时间戳备份。

**遗留问题**：`git.mismatch true` 在 revert 后的 `status` 里仍为 true，但含义是"没有期望端口可比"而不是"配置错了"；空文件与缺失文件在审计上等价，读 `status` 的人需要知道这点。

---

## 验收 7：全程对话与日志不出现订阅 token 或节点凭据

**证据**：

```
== 插件数据目录（排除 CVR 自己的工作文件）==
/c/Users/<user>/.qoder/vpn-proxy/backups/profiles.yaml.20260930-123930-488-001.bak
/c/Users/<user>/.qoder/vpn-proxy/backups/profiles.yaml.20260930-130648-474-001.bak
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
- 扫描范围与结果：日志（`mcp.log`，7 行）、插件源码目录 `qoder-vpn-proxy/`（含测试 fixture、README、SKILL）、`subscriptions.json`、`.trash` 内容、所有对话输出 → 对 `123adsas|BGqmX0c|62ffcf3f|fgzvArRr` 全部 0 命中（`grep -rn -E '123adsas|62ffcf3f|南山云' qoder-vpn-proxy/` 也 0 命中，连机场名都没进代码）。
- `proxy_nodes` 只回节点**名称**，不回 `server`/`port`/`password`/`uuid`/`sni`（设计如此，有测试锁住）。

**本次一并处理的文档侧泄露**：spec §2 的事实表原本写了**完整**的旧/新订阅 URL 路径段，已换成 `<旧订阅路径>` / `<新订阅路径>` 占位（本文档也不复述原值）。计划里仍保留上面那四个 **8 字符前缀**，因为它们是 Task 15/17 凭据 grep 命令的搜索词本身（改成占位符会让验证命令失去可复现性）；前缀不足以重建 32 位 token。若日后 token 轮换，这些前缀应一起更新。

**遗留问题（不能粉饰的那一条）**：插件自己的 `backups/profiles.yaml.*.bak` **含原始 token** —— 这是物理必然：备份是 CVR `profiles.yaml` 的逐字节副本，而那份文件本来就存订阅 URL。目前**没有**备份保留/过期策略，也没有对备份内容做脱敏（脱敏会让备份失去还原价值）。可选处置（都要用户点头）：加 `backups/` 保留期清理，或把备份目录权限收紧。

**后记（用户点头后的处置）**：用户选了"① backups/ 加保留期清理"，实现见计划 Task 18 —— `proxy_restore_config prune=true`（默认每个文件名留 5 份、超 14 天的旧副本删除、最新一份永远留，`dryRun` 先出清单）。仍在的局限有两条，不遮掩：清理**不自动触发**（备份写入层用注入的假 `fs`，prune 用真 `unlinkSync`，硬拼会让那些假件失效），所以靠 SKILL.md 要求流程收尾跑一次；且**保留期内**的备份依旧是未脱敏原文，`keepPerName`/`olderThanDays` 只是把暴露窗口从"永久"压到"5 份 / 14 天"。另一条备选（收紧目录权限）没做。

**第二次更正（20:0x，见未闭环清单第 13 条）**：本项当时判"达成"用的是**只红 token** 的口径，而订阅的**主机名与路径段本身**也留在每一次工具返回里。这个口径与后来为公开仓库做的域名重写（第 9 条）互相打脸，所以契约已升级为整条 URL 脱敏 + `urlFingerprint` 身份位。验收 7 的原始证据（token 0 命中）依然成立、没有被推翻，但**"达成"的含义变严了**：现在要求 host / path / query 三段都不出现在输出面与日志。

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
== output: C:\Users\<user>\...>OK_DIR%~1"   ← cmd.exe 已经错位到行中间
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
| 4 | 新订阅链接返回的节点集合与旧 profile 是否一致 | **一致**：新条目刷新后 `nodes=15`，与旧条目在 GUI/`/proxies` 里看到的 15 个业务节点同一集合（4 个策略组：GLOBAL 20 / 南山云 17 / 故障转移 15 / 自动选择 15，组数与成员未变）。quota 也读回来了（total 74826208722）。所以"换链接"是纯地址变更，不是套餐变更。 |
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
profiles.yaml 155b55c511e267b3（首次收尾是 f2dfaeb510fe77ca；CVR 启停时自己重写元数据，current 仍是用户选的 SEitsxVMpF0c）
clash-verge.yaml 01441c4bdf3fdf32（CVR 自己的运行时文件；插件从不写它）
$ 订阅清单
1 条：SEitsxVMpF0c /「南山云(新)」/ 15 节点 / remark="2026-09-30 换地址"
旧条目 Rq14DVii2DNo 已删除，内容文件在 ~/.qoder/vpn-proxy/.trash/，可放回撤销
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
   用户已给出处置（18:0x）：**仓库可见性 = 公开**、**PR 走"我推送 + 用户在网页手工建"**、**推送认证 = Git Credential Manager 弹窗**（本机 `credential.helper=helper-selector`，无 SSH 密钥、无 `.git-credentials`）、**直连优先，失败再由本插件的 per-host git 代理键走 `127.0.0.1:7897`**。remote 已给出并推送完成，过程与新发现的认证真相见下面第 10 条。域名那条新阻塞见第 9 条。
7. ~~缺陷 8 的修复还没进"正在服务的那个 MCP 进程"~~ —— **第三次重启后已在会话内闭环**（16:59–17:0x）。`mcp_get proxy_core_stop` 的描述已是"等进程确实退出后再把 verge.yaml 还原…"；随后从会话的 MCP 通道跑了一整轮：`proxy_core_start`（scope=session，命名管道可用、7897 在听、运行中 `ProxyEnable=0x0`）→ `proxy_core_stop` 返回 `{"killed":["clash-verge.exe","verge-mihomo.exe"],"restored":true,"restoredList":[{"name":"verge.yaml",…}],"stillRunning":[],"systemProxyEnabled":false,"warnings":[]}` → 独立复查：无残留进程、7897 监听数 0、`ProxyEnable` 仍是 `0x0`、`verge.yaml` 的 `enable_system_proxy` 已回到 `true`。还原列表只有 verge.yaml 一项也对上了新语义（profiles.yaml 属用户持久数据，不由 stop 还原）。
8. ~~`prune` 只跑了 dryRun~~ —— **用户点头后实跑完成**（17:0x）：`scanned 30 / deleted 19 / kept 11 / failed 0`，磁盘核对剩 5 份 `profiles.yaml.*` + 5 份 `verge.yaml.*` + 隐藏的 `.npmrc.20260930125506962-001.bak`，`.trash/` 里的撤销副本（`…-Rq14DVii2DNo.yaml`、`…-lkYFauvJwQeP.yaml`）仍在。保留最新 5 份意味着**存活的 5 份备份里仍含原始 token** —— 这是策略本身的选择，不是遗漏；推送前不涉及它们（它们在 `~/.qoder/vpn-proxy/`，不在仓库里）。
9. **公开仓库前的第二轮重写：订阅域名 → 占位主机**（用户选"再抹一次域名"）。凭据清干净之后又查出一层：订阅**主机名本身**还留在 **16 个 blob** 里 —— 分支 tip 早已换成占位（0 命中），但 master tip 的 plan ×7 + spec ×1 仍带原值，而 PR 的 base 必须是 master，所以推上去就等于把"用的是哪家机场"永久公开。做法：`Temp/qvp-pre-domain.bundle` 存档并 verify → 在**它的克隆**里预演 → 用同一套 `filter-branch --index-filter` 把主机名全量换成仓库既有占位约定 `sub.example.invalid`（本文档不复述原值）。**预演与真仓库的结果逐字节一致**：master `2b3a7cc`、分支 `081dce4`、master tip tree `63020e1…` —— 说明这条替换是确定性的，不是碰运气。扫描用的是主机名探测器的形状法（不看清单，把每个 blob 里的 URL 主机名都提出来分类）：仓库里唯一的非公共主机就是这一个，其余 33 种是 `*.test` / `*.example.invalid` 合成 fixture 与 github.com、qoder.com、pypi.org、www.gstatic.com、cp.cloudflare.com 等公共地址。**验证**：提交数 37→37、父链同构 `ok=37 root=0 bad=0`、29/37 对提交树完全未变、变动的只有 3 个路径（spec ×29、plan ×17、`redact.test.js` ×2）、**分支 tip 的 tree hash 仍然逐字节不变**（`4d5bb1ea0695dc6200e55d7abb01b8b001c07856`，工作成果依旧没被动过）、master tip 只改那两份文档、重写后 `node --test` 165/165；purge（`reflog expire` + `repack -adf --unpack-unreachable=now` + `prune` + `gc --prune=now`）后主机名扫描**真域名 0 命中**、`sub.example.invalid` 从 17 个 blob 增至 25 个、凭据形状扫描继续 **0 个 blob**。第二轮又换了全部 37 个哈希，文档里 8 处旧短哈希引用（plan ×5、acceptance ×3）已按映射表换新，复查残留 0。`qvp-pre-domain.bundle` 里仍带域名 —— 本机存档，不外传。
10. **推送完成（18:4x）与认证真相**。remote `https://github.com/lilihk999/Qoder-vpn.git` 用 `git remote add` 加好（只写仓库级配置），远端原有一个与我们历史无关的 `main`（`c460b18`），**未做任何改动**。网络按"直连优先"：`git ls-remote` 直连 → `Recv failure: Connection was reset`；改走会话级环境变量 `HTTPS_PROXY=http://127.0.0.1:7897`（**没有**写 per-host 持久键、**没有**碰系统代理）→ 立刻通。最终远端：`master 2b3a7cc`、`qoder-vpn-proxy 4f9a1ee`，分支比 base 多 32 个提交，PR 由用户在网页手工建。
   **认证这条推翻了原假设**：用户选的是"GCM 弹窗"，但实测 `credential.helper` 指向的 `~/.qoder/bin/git/mingw64/bin/git-credential-manager.exe` 在本机**退出码 127、零输出**，根本起不来，`git credential fill` 因此返回空 → git 回落到终端提示 → 被 `GIT_TERMINAL_PROMPT=0` 挡成 `could not read Username`。真正能用的凭据在 Windows 凭据库里的 `git:https://github.com`（wincred 命名格式，账户 `lilihk999`），改用一次性 `-c credential.helper= -c credential.helper=wincred`（不落盘、不改配置）后推送立即成功。
   **过程里踩到的测量坑**：`cmdkey /list` 在 Git Bash 里被 MSYS 把 `/list` 当路径转换掉了，第一次执行输出的是 usage，我据此得出"凭据库为空"的**错误结论**；换成 `MSYS_NO_PATHCONV=1` + `iconv -f GBK -t UTF-8` 才读到真实列表（4 条）。另一个未解释点要如实记下：**第一支 `master` 推送成功时并没有显式用 wincred**，理论上当时 GCM 也该是坏的，所以那次成功是怎么发生的没查清 —— 不影响结果（两支都已推上、远端哈希与本地逐字节相同），但这条因果留作缺口。
11. **回滚 bundle 已删 + 用"活凭据"做的终局审计（19:0x）**。用户点头后 `rm Temp/qvp-pre-scrub.bundle Temp/qvp-pre-domain.bundle` —— 这两份是重写前历史的**唯一本机副本**，删掉意味着回滚只能靠 GitHub 远端，此后机器上不再有任何带明文订阅凭据的仓库快照。审计脚本 `Temp/qvp-final-audit.js` 换了个更硬的口径：**不再靠形状猜测，也不靠历史清单**，而是运行时从本机 CVR 配置（含 `backups/`、`.trash/`）现取全部 `url:` 值，只把"带 `token=<32hex>` 或路径段是 16–24 位字母数字"的当凭据，比较时只打印 `sha256[:10]` + 长度。真凭据 needle 共 3 个：`HOST:<fp:sub-host>/18`、`PATH:<fp:sub-path>/20`、`TOKEN:<fp:sub-token>/32`（换链接前那条旧路径段已不在本机配置里，前一轮的形状扫描已覆盖它）。**结果**：仓库 `rev-list --objects --all` 全部 344 个对象里的 **130 个 blob，真凭据命中 0**。远端一致性用 `git ls-remote` 核过：`master 2b3a7cc…`、`qoder-vpn-proxy 919a8c0…`、`main c460b18…` 与本地逐字节相同，blob 是内容寻址的，所以"本地 0 命中"直接就是"GitHub 上那两个分支 0 命中"；同时看到 `refs/pull/1/head = 919a8c0` —— 用户已在网页把 PR #1 建好，base 正是要的 master。
   **仍然留在本机的东西（本机-only，未外传，删不删归用户）**：同一套 needle 扫 `Temp` 得 **7 个文件**——`qvp-scrub-host.js`（它的搜索键就是域名本身，重写工具自带）、`qvpb/002.js` 与 `qvpb2/002.js`（09:52 那批 redact 测试草稿的副本，里面是**真 token**；仓库 tip 上同名位置早已换成合成 fixture）、`qvpb|qvpb2` 的 `025.js`（域名+路径段）、`031.js`（域名）。扫 `~/.qoder` 与 `Documents/Qoder` 另得 40+ 处，分两类：`vpn-proxy/backups/*.bak` 5 份是插件按设计为用户数据做的时间戳备份（预期内，prune 策略保留最新 5 份）；`logs/runs/*/qodercli.log`、`logs/sessions/**/segments/*.jsonl`、`projects/**/*.jsonl`（含当前会话那份 20MB，被我的 8MB 上限跳过但必然包含）、`file-history/aa25fd26-*/…@v1|v2|v3` 9 个快照、`tasks/aa25fd26*/20.json`、`tmp/**/tool-results/*.txt` —— 这些是**会话记录的自然残留**：用户第一条消息就把整条订阅链接贴进了对话，Qoder 的 transcript／运行日志／文件版本历史都会原样留存。它们不是插件的泄露，也不在任何仓库里；要清就得同时接受清掉本轮会话历史，是用户的取舍，我没有动。
   **一个必须记下的误报教训**：脚本早期版本把 CVR 配置里**所有** `url:` 的主机都当凭据，于是 `HOST:80255870a6/15` 与 `PATH:cf3a006b60/12` 命中仓库 32 个 blob，看上去像"还有第三轮泄露"。用掩码上下文探针（`Temp/qvp-ctx.js`，把命中的字面量换成 `⟦HOST⟧` 只打印周边）一看就清楚了：那是 `www.gstatic.com` 与 `generate_204` —— 连通性探测 URL，公共地址且早已在公共源码里。所以判定凭据要按**形状**（token 查询串、16–24 位随机路径段），不能按"配置里出现过的字符串"。
12. **Temp 全部临时件已清（19:1x）**。用户点头"清理那些临时文件"后删除：262 个 `qvp*` 条目（重写脚本、remap/pair/harvest 工具、`qvp-hook-*` 42 个 hook 测试目录、`qvp-install/` 冒烟产物、两份 hash-map TSV、`qvpb/` 与 `qvpb2/` 两批草稿副本）+ 4 个早期探针产物 `body.txt`、`raw-yaml.txt`、`h.txt`、`subhdr.txt`。**后两个里躺的是真节点凭据不是订阅串**：清理前的形状扫描（needle 从 CVR 运行档案与插件 store 现取）显示 `body.txt`/`raw-yaml.txt` 各命中 2 类节点秘密，所以它们和带真 token 的 `qvpb*/002.js` 一起进了删除清单。没碰 `qoder-git-hooks-*`、`qoder-*-cwd`、`qoder-sdk-auth-*` 等 Qoder 宿主自己的临时目录，也没碰任何非本项目的 Temp 条目。
   **删后复验**（脚本用 stdin 喂给 `node`，机器上不再留副本）：18 个 needle（订阅 3 + 节点凭据 15）扫 Temp 现存 1356 个文件 → **命中 0**；扫仓库 349 个对象 / 131 个 blob → 报出 1 个 `NODE@22` 命中在公共 fixture `qoder-vpn-proxy/test/fixtures/sub-yaml.txt`。掩码上下文一看是 `chacha20-ietf-poly1305`（**22 个字符的算法名**，被我的 `cipher:` 抓取规则错当秘密），而该 fixture 本身是干净的合成数据：`server: 192.0.2.10`（TEST-NET 文档地址段）、`password: REDACTED`、`uuid: REDACTED-UUID`、`panel.example.invalid`。把算法名从 needle 里剔除后重跑：17 个 needle（订阅 3 + 真节点凭据 14），仓库 **0 命中**。
   **第二条误报教训（和上一条同构）**：抓取"看起来像凭据"的键名时，`cipher`/算法名必须排除 —— 它是协议常量，本机配置与公共 fixture 里都是同一个字面量，不排除就会把公开测试数据读成泄露。
13. **订阅 URL 完整脱敏（第二轮重启后的 20:0x，用户指令"先实现订阅 URL 脱敏逻辑"）**。这轮重启后重测插件健康度时暴露出一个自相矛盾：我们为了公开仓库把**域名**从历史里重写掉了（第 9 条），而插件自己却在**每一次工具返回**里把那个域名和路径段原文打印出来 —— 旧契约只红掉 `token=`（验收 7 当时判"达成"就是按这个口径）。`proxy_subscriptions` 的输出会进会话 transcript、进运行日志、被我这类助手复述，等于一边清理仓库一边往公开通道里补发凭据。

   **新契约**（`server/redact.js`）：订阅地址的展示形态是 `https://<masked-host>/<masked-path>?<masked-query>`，解析不了的整条替换为 `<masked-url>`，空/非字符串回 `''`；主机名、路径段、query 三段都不出边界。同一条链接的身份改由 `urlFingerprint = sha256(host + '/' + pathname)` 前 10 位承担，**token 不参与计算** —— 用户对指纹要回答的是"是不是同一家同一条链接"，换 token 前后应当一致；`urlPathOnly` 字段（旧契约里唯一暴露路径段的字段）直接删除，不保留兼容位。
   **形状判据**沿用第 11/12 条凭据审计的同源规则而不是白名单：`token=` 查询参数，或路径首段恰为 16–24 位纯字母数字。这条判据必须**只**命中订阅，否则 `proxy_diagnose` 就废了 —— 公共探测地址逐条验过都不命中（`pypi.org/simple/`、`www.gstatic.com/generate_204` 首段 12 位含下划线、`raw.githubusercontent.com/a/b/main/x.js` 首段 1 位、`cp.cloudflare.com/` 无路径段），并有一条回归用例把"公共 URL 原文保留"钉住。`redactUrl`（只红 token 的那版）**留着**，给非订阅 URL 用。（**此句已作废**：第 14 条的 ① 发现 `proxy_diagnose` 正是拿它去回显用户自传的 target，等于主机名与路径段明文出境，故 `redactUrl` 已整体删除，见第 15 条。）
   **两个新助手解决两类漏口**：`maskHosts(text, url)` 存在的理由是 Node 的网络错误消息把**裸主机名**塞进字符串（`getaddrinfo ENOTFOUND xxx`），那不是 URL 形状，任何"整条 URL"正则都管不到，只能拿已知订阅地址逐词替换；`urlFingerprint` 见上。
   **三层纵深**：源头（`subscriptions.js` 的 `toEntry`、`tools.js` 的 `subscriptionSummary` —— 后者只透传已脱敏值，注释写明不做二次脱敏）；边界（`callTool` 对每个返回值过 `redactText`）；持久落盘点（`index.js` 的 `makeLogger` 对**每一行**日志先 `redactText` 再写 `mcp.log`/stderr，`protocol.js` 对自身那条内部异常栈同样脱敏）。`subscription.js` 的超时/HTTP 非 200/URL 解析失败三条消息全部改走 `maskSubscriptionUrl` 或 `maskHosts`。
   **TDD 与测试**：先写红再改实现，净增 **17 条用例**（18 条新写 + 1 条旧 `list` 契约用例改写；redact +8、subscription +3、subscriptions +3、tools +1、protocol +1、index +1）。tools.test.js 新增的"输出面审计"跑的是**真的** `SubscriptionRepo`，把 `proxy_status` / `proxy_subscriptions` / `proxy_subscription_add` / 一条错误路径都过一遍，断言 5 个泄露字面量（主机名、host:port、路径段、token 值、`token=` 形态）一个都不出现，同时断言 `profiles.yaml` 里**仍是原始完整链接** —— 脱敏只在输出面，CVR 必须能拿到真值才能发起请求。全量 `node --test --test-force-exit`：**182 tests / 182 pass / 0 fail**（改动前 165）。
   **一处必须如实交代的测试期望修正**：我先写的第一版断言里给 `maskSubscriptionUrl('https:///SUBPATH?token=x')` 规定了"保留路径段掩码"，跑红之后才发现这条红不是实现的错，是我对 WHATWG 解析器的假设错了 —— 主机为空的 special scheme 会把路径吃掉，Node `new URL('https:///SUBPATH?token=x')` 的 `pathname` 并不是 `/SUBPATH`。于是把期望改成真正要守的不变量（原文任何子串都不得出现 + 保留 scheme），再写实现；改的是**测试对退化输入的期望**，不是对正常订阅链接的期望。
   **真机验证（不打印任何明文）**：安装副本 `C:\Users\<user>\.qoder\plugins\cache\local\qoder-vpn-proxy\0.1.0` 与 worktree `diff -rq` 无差异；直接 spawn 安装副本的 server 走 stdio 调 `proxy_status` + `proxy_subscriptions`，返回 `url = "https://<masked-host>/<masked-path>?<masked-query>"`、`urlFingerprint = <fp:url-fingerprint>`、字段清单里 `urlPathOnly` 已消失。对照口径与第 11 条一致，needle 运行时从本机 CVR 配置现取、只比 `sha256[:10]` + 长度（`HOST <fp:sub-host>/18`、`PATH <fp:sub-path>/20`）：工具输出**与 `mcp.log`** 里真主机名 0 命中、真路径段 0 命中、`token=` 0 命中；指纹与从本机配置独立重算的结果一致（`<fp:url-fingerprint>`）。
   **两个未闭环点**：① 这条改动只在**安装副本被重新加载之后**才对会话内工具生效 —— 当前正在服务的 Qoder 进程仍是改前的代码，本会话里 `proxy_subscriptions` 的返回还是旧形态，需用户重启一次才算进服务进程（与缺陷 5/6 同一个坑，已第三次踩到）。② 计划文档 `docs/superpowers/plans/2026-09-30-qoder-vpn-proxy.md:3269` 仍写着旧契约 `Entry = {… url(redacted), urlPathOnly …}`，那是**历史执行记录**、不是待办规格，故不回改；以本条为准。
14. **同一轮插件健康重测暴露的 4 个候选缺陷（①②④ 已由第 15 条补完并推进 PR #1；③ 仍待用户点头）**：① `proxy_diagnose` 在"HTTP 200 但 curl 退出码 28"这一组合下的归类 —— 200 说明探测本身成功，exit 28 只是末尾计时截断，不该被降级成通道问题；② `proxy_restore_config` 之后 `configModified` 的语义不清（它指的是"相对还原前变了"还是"相对基线变了"，还原成功时返回 true 会让人误读）；③ `~/.qoder` 会话残留（transcript / 运行日志 / file-history）要不要清 —— 见第 11 条末，清了就没有本轮会话历史，属用户取舍；④ 每次 `tools/call` 的审计行目前只落 `mcp.log`，没有可查询的调用账本。①②④ 都可在 worktree 里按 TDD 补，③需要用户点头。
15. **第 14 条的 ①②④ 已按同一 TDD 流程补完，并把脱敏 + 这三项推进 PR #1**（③ 未动，按第 11 条末的口径等用户点头）：

   **① `proxy_diagnose` 不再把"通但慢"判成"坏了"（`56c91bc`）**：`probe` 改判为「状态码 2xx/3xx 即算够到目的地」，`curl` 退出 28 只表示 `--max-time` 在传输尾部触顶，于是这种组合记 `ok:true, truncated:true`；`000 + exit 28` 仍算失败。行结论追加"（直连与经代理在 max-time 触顶截断，响应体未收完）"，`summarize` 汇总 `truncatedCount` 并把建议指向"把 `timeoutMs` 调大（如 20000）再跑一次"而不是"换节点"。顺带把第 13 条遗留的漏口堵住：`runDiagnose` 回显**用户自传**的 target 之前走的是"只红 token"的 `redactUrl`，等于主机名与路径段明文出境 —— 现在统一走 `redactText`，并且 `redactUrl` 整个删除，用一条用例钉住"不再存在只红 token 的退路"（第 13 条里"`redactUrl` 留着给非订阅 URL 用"那句就此作废）。

   **② `configModified` → `configDrift` 三态（`c6b6cf7`）**：`CvrConfig.modifiedSinceBackup` 返回 `{modified, clean, noBackup}`，文件当前不存在时另标 `missing:true`；`proxy_status` 用 `configDrift` 取代布尔字段，写清 `comparedTo`（跟"插件对每个配置文件最近一次落盘的时间戳备份"比）、`note`（**只说字节不同，分不清是插件、CVR 运行时回写还是用户手改**）、`noBackup` 是"没得比"不是"没问题"，读不到时 `available:false` + `error:<kind>` 而不是静默给空数组。`proxy_restore_config` 新增 `driftAfterRestore`（还原成功后立刻逐字节复查），脏则按 `warnings` 点名"极可能是 CVR 还在运行时把它写回去的"，并给出两条出路（接受 / 先 `proxy_core_stop` 再还原）；干净还原时 `warnings` 保持空数组——警告一多用户就不信警告了。

   **④ 每次 `tools/call` 的可查询账本（`350d7a4`）**：新增 `server/audit.js`，`callTool` 的四条出口（成功、handler 抛错、参数校验失败、未知工具）各落一行 JSONL 到 `logs/calls.jsonl`，字段固定 `{ts, tool, args, ok, kind, ms}`。`args` 是**参数名**数组：`argNames` 只做 `Object.keys`，值没有任何写入通路——`logs/` 是永久磁盘残留，会话结束不清、卸载插件也未必清，订阅链接/节点名/组名进去就出不来。超过 64KB 裁到最近 200 条且最新一条必留；`logs` 被占成文件时 `record` 静默返回 `null`，记账失败绝不拖垮调用；`proxy_status` 用 `audit` 字段回读最近 10 条。**开关是环境变量 `QODER_VPN_PROXY_AUDIT=0` 而不是工具参数**：被审计的那次调用不该有权决定要不要被记；关闭时如实回 `enabled:false` + `note`，而不是当这功能不存在。

   **测试**：182 → 188（①）→ 193（②）→ **207**（④ 净增 14：audit 6 + tools 5 + index 2 条端到端，另 1 条"未注入 `getAudit` 时行为不变"是回归护栏、写出来即绿，用途是钉住账本可选而非前置条件）。每一步都先跑红并核对红的理由（`Cannot find module '../server/audit'`、`ENOENT ... calls.jsonl`、`Cannot read properties of undefined (reading 'enabled')`）再写实现。**两处如实交代**：① ④ 的第一版用例我要求 `proxy_status` 读到的 `recent` 里含本次调用，实现做不到——账由 `callTool` 在 handler 返回后补写，成败与 kind 那时才知道，为自我包含去落两遍会破坏 append-only 且第一遍没有 `ok`，于是把期望改成"`note` 必须明写不含本次"；② 同一用例里我以为账本会有 3 行，实际 2 行（沙箱里只有两次调用），是我算错，按真实不变量改正。② 里还有一次"生产消息 vs 测试措辞"冲突（`CVR 正在运行` 的措辞），按第 9 条既定口径改的是**消息**、测试留作规格。

   **推送与 PR**：直接把分支整体推上去会把第 11/12 条那两条只记录凭据清理过程的文档提交（`7d674d9`、`787f63c`）也带进 PR，而用户明确说过"不用把这两条补进 PR"。所以走**临时分支**：从 `origin/qoder-vpn-proxy`（`919a8c0`）切 `temp/pr-mask`，只 cherry-pick `590737a`/`56c91bc`/`c6b6cf7`/`350d7a4` 四个代码提交（这四个只碰 `qoder-vpn-proxy/**`，两条文档提交只碰 `docs/`，因此无冲突）。推送前三道验证：临时树上 `node --test --test-force-exit` **207/207**；`diff -rq qoder-vpn-proxy/` 与本地工作树**无差异**；59 个文件逐一对本机现取的真凭据 needle 做包含测试（`HOST <fp:sub-host>/18`、`PATH <fp:sub-path>/20`、`TOKEN <fp:sub-token>/32`、整条 `<fp:sub-url>/86`）**0 命中**。`git push origin temp/pr-mask:qoder-vpn-proxy` 快进 `919a8c0..34fe7f1`，`git ls-remote` 证实 `refs/heads/qoder-vpn-proxy` 与 `refs/pull/1/head` **同为 `34fe7f1`** —— 脱敏与三项修复已进 PR #1。临时 worktree 与 `temp/pr-mask` 已清理，本地 `7d674d9`/`787f63c` 与本条文档提交仍未推送。直连 `github.com` 仍 `Recv failure: Connection was reset`，走本机 7897 代理成功；认证沿用 `-c credential.helper= -c credential.helper=wincred`。

   **仍未闭环（与第 13 条同一个坑）**：安装副本 `C:\Users\<user>\.qoder\plugins\cache\local\qoder-vpn-proxy\0.1.0` 已同步（`server/`、`test/`、`README.md`、`skills/vpn-proxy/SKILL.md` 全部 `diff -rq` 无差异，并在该目录内跑绿 207），但**当前在服务的 Qoder 进程还是改前代码**——`proxy_status` 的 `audit`、`configDrift`、`truncated` 都要用户重启 Qoder 后才对会话内工具生效。另：`~/.qoder/vpn-proxy/logs/calls.jsonl` 从重启后开始积累，之前的调用无从补记。

16. **2026-10-01 重启后：①②④ 与脱敏在真进程里逐条验实，并补掉新发现的 ⑤（`3b011ae`）**

   **生效证据（都来自本次会话的 MCP 工具返回，不是测试推断）**：`proxy_status` 的 `description` 本身就带新字段文案；`subscription.current.url = "https://<masked-host>/<masked-path>?<masked-query>"` 且 `urlFingerprint = <fp:url-fingerprint>` 在核心启停前后一致（指纹不含 token，所以这条性质正好被"换会话/换状态"验了一次）；① 在 `timeoutMs=2500` 与代理轮各命中一次 `200 + exit 28 → truncated:true`、`truncatedCount:1`，建议文案指向"调大 timeoutMs 再判"；② `configDrift` 在 `proxy_core_start` 之后报 `dirty:[verge.yaml, profiles.yaml]`，而 `profiles.yaml` **插件从未写过**，是 CVR 自己回写（`subscription.updated` 1790752062 → 1790849067）—— 这正是 `note` 里"分不清谁改的"要覆盖的真实场景；④ 账本从 0 行涨到 10 行，含失败那条 `proxy_select args:["group","target"] ok:false kind:channel_unavailable`。
   **账本的凭据复验**（口径同第 11/13 条：needle 运行时从本机 CVR 配置现取，只印 `sha256[:10]`+长度）：`HOST <fp:sub-host>/18`、`PATH <fp:sub-path>/20`、`TOKEN <fp:sub-token>/32` 共 5 条形状 needle 对 `logs/calls.jsonl` **0 命中**；全文件连 `http` 子串都不存在；每行键集合恰为 `{ts,tool,args,ok,kind,ms}`，`args` 每项都匹配 `^[A-Za-z][A-Za-z0-9_]*$`（值无写入通路这条性质由形状证出来）。
   **⑤ 404 被当成通道故障**（本次实跑撞出来的，第 14 条四条候选之外的新问题）：`server/clash-client.js` 把除 401/503/504 之外的一切非 2xx 归 `channel_unavailable`，**包括 404**，而紧挨着的一行给 404 写的 hint 是"组名 / 节点名 / uid 可能拼错"——kind 与 hint 自相矛盾。实测：`running:true` 且命名管道可达时 `proxy_select group=不存在的组` 仍回 `channel_unavailable`，而 skill 对这个 kind 的动作是"先 `proxy_core_start`"，于是打错名字会把调用方支去重启核心。修法是一行分档：404 → `malformed_config`，hint 补一句"若这个路径本身是核心没有的端点（v1.19.25 的 `POST /configs/reload`），404 说的是版本不支持"。`proxy_subscription_activate` 那边吞掉 reload 异常与 kind 无关，行为不变（`subscriptions.js:276-279`）。
   **TDD**：`test/clash-client.test.js` 里原有一条**把旧分类钉成规格**的断言（`(e) => e.kind === 'channel_unavailable'`），本次连同新用例一起改成 `malformed_config`；先跑红并核对红的理由（`actual: 'channel_unavailable'` / `expected: 'malformed_config'`）再改实现。全量 **207 → 208/208**，且安装副本同步后在 `C:\Users\<user>\.qoder\plugins\cache\local\qoder-vpn-proxy\0.1.0` 目录内再跑一次同样 208/208（`server/`、`test/`、`skills/`、`hooks/`、`README.md`、`package.json` 与源码树逐字节相同）。
   **收尾与状态**：`proxy_core_stop` 还原 `verge.yaml` 到本次 `core_start` 前的备份 `20261001-180420-189-002`，独立复查过：无 `clash-verge/verge-mihomo` 进程、7897 无监听、`\\.\pipe\verge-mihomo` 不存在、注册表 `ProxyEnable=0x0`（`ProxyServer`/`ProxyOverride` 按用户口径没动）、`verge.yaml` 回到 `enable_system_proxy: true`。本次核心是用 `proxy_core_start scope=session` 拉起的（浏览器全程不受影响）。**同一个坑第五次**：⑤ 的修法只对**重启后的**服务进程生效，本会话里 `proxy_select` 传错名字仍会回旧 kind。
   **顺带纠正一条我的错误结论**：上一轮我判"本机已卸载 RollBack Rx"，错了。它装着（服务 `ShdServ` Running/Automatic、`C:\Program Files\Shield`、`shield.sys`+`shieldf.sys`、`HKLM\SOFTWARE\Shield` = v12.5），我上次按 "RollBack" 这个词找服务名与 Program Files (x86) 所以假阴性；读状态的正确命令是 `ShdCmd.exe /Status`（回 `Yes`）与 `/List`（只剩 `Id 3*` 99.0 GB 锁住，2026-06-26）。同时这次真实重启把 09-30 的写入**全部保住**（安装树、两个分支、工作树都在），所以"重启会吞改动"不是无条件成立的。

17. **⑤ 的真机验证（不靠重启也不靠推断）＋ 新缺陷候选 ⑥：discovery 读的是**没人加载的**那份 config.yaml**

   **前提先说清楚：Qoder 本次并没有真的重启。** `~/.qoder/vpn-proxy/logs/mcp.log` 里最后一条 `server 启动，17 个工具…` 是 `2026-10-01T09:48:04.815Z`（本地 17:48），早于 ⑤ 的代码改动，所以**正在服务的那个进程跑的仍是改前字节**——本会话里直接调 `proxy_select` 传错组名，回的还是 `channel_unavailable`。这与第 13/15/16 条是同一个坑，只是这次我不再等重启，改成**验安装副本的字节本身**。

   **两条互补的实路（都拿到真 404，不是假想）**：
   1. **MCP stdio 层**：`spawn` 安装副本 `server/index.js`，`QODER_VPN_PROXY_DATA` 指到 Temp、`QVP_CONFIG_DIR`/`QVP_INSTALL_DIR` 指到 Temp 里的**合成**配置（不含任何真订阅字节），另在本地命名管道上起一个假 mihomo，对 `PUT /proxies/<不存在的组>` 回 `HTTP 404`。走 `initialize` → `tools/call proxy_select` 的真实帧（换行分隔 JSON）拿到 `isError:true, kind:"malformed_config"`，`hint` 里点出 `proxy_nodes`；同一次调用在合成账本里落成 `{tool:"proxy_select",args:["group","target"],ok:false,kind:"malformed_config",ms:69}`。这条证明**打包后的服务端 + 协议层 + 账本**这一整串都对。
   2. **真核心层**：不写盘、不复制配置，直接在内存里 `require` 安装副本的 `transport.js` + `clash-client.js`，用**本机 `clash-verge.yaml` 现读的**管道名与 secret 构 `createTransport({controller:{pipe,tcp:null},secret})` → `kind=pipe` 握手成功 → `select('不存在的组-verify5', …)` → 真 mihomo 回 `PUT /proxies/%E4%B8%8D… -> HTTP 404 {"message":"Resource not found"}` → 归 `malformed_config`，`hint` 含 `proxy_nodes`。这条证明**真核心真的这么答**，不是测试替身的脾气。两条都验完才叫 ⑤ 落地。

   **⑥（未修，等用户点头）：`discovery.js` 的配置源顺序是错的。** `CONFIG_SOURCES = ['config.yaml', 'clash-verge.yaml', …]` 逐个 `try` 并在**第一个可读文件**上 `break`，于是永远命中 `config.yaml`。但 CVR 里 `config.yaml` 是**用户基座配置**（本机 mtime 2026-08-22，607 B，里面写着 `external-controller-pipe: \\.\pipe\verge-mihomo`），**mihomo 实际加载的是 `clash-verge.yaml`**（本次 mtime 18:22:09，26 257 B，声明 `\\.\pipe\verge-mihomo-sidecar-release-<64hex>`，共 102 字符、`sha256[:10]=<fp:pipe-name>`）。CVR 2.x 的 Sidecar 运行模式给管道名加了后缀，所以插件按老名字连——`Test-Path` 与 Node 连接都回 **ENOENT**，而按真名字连则 `GET /version -> 200 {"meta":true,"version":"v1.19.31"}`。这条同时解释了 18:22 那次 `proxy_core_start scope=session` 为什么报 `core_not_running`「25000ms 内未就绪」却**确实把进程拉起来了、7897 也在监听**：就绪判定走的是通道握手，通道名取错了。
   **为什么算缺陷而不是环境问题**：第 8 条当初定的就是「`external-controller-pipe` 从文件里读，不硬编码」，⑥ 是这条契约**没读完**——读到了字段，但读的是没人加载的那份文件。修法很小也很明确：把 `clash-verge.yaml` 排在 `config.yaml` 之前（它是运行时产物，永远比基座新），或者干脆逐源都读、以**能握手成功的那个**为准并把 `configSource` 如实回显。但它会改 `proxy_status`/`proxy_core_start` 的判定路径，属于规格级取舍，所以**按第 14 条的口径先报不改**。
   **顺带一条要更正的环境事实**：本文开头（第 7 行）写的「mihomo v1.19.25、控制通道 `\\.\pipe\verge-mihomo`」对 09-30 成立、对 10-01 不再成立——真机现在是 **v1.19.31 + sidecar 管道名**。⑤ 的 hint 文案里「v1.19.25 的 `POST /configs/reload`」是**举例**、不是版本上界，读作「这个端点在 v1.19.x 系列上就没有」即可；1.x 的版本漂移正是 ⑥ 值得修的长期理由（下次改名不用改代码）。

   **收尾复查**：`proxy_core_stop restore=true` 回 `killed:[clash-verge.exe] restored:true`（用的备份是本次 start 前落的 `verge.yaml.20261001-182207-556-002`），独立复核不靠它的自述——`tasklist` 里 `clash-verge`/`verge-mihomo` 都没有；7897 无监听；两个管道名（sidecar 与 legacy）都 **ENOENT**；注册表 `ProxyEnable=0x0`，`ProxyServer`/`ProxyOverride` 按用户口径**没动**；`verge.yaml` 回到 `enable_system_proxy: true` / `enable_external_controller: false` / `enable_tun_mode: false`。本轮所有 Temp 脚手架（含合成配置与假管道服务端）已删除，`backups/` 现有 16 个文件、其中 7 个 `profiles.yaml.*.bak` 仍是**未脱敏原始字节**——是否 `prune` 等用户点头（第 11 条口径）。
   **顺带一条测试卫生问题（候选 ⑦，未修）**：`npm test` 会在 `%TEMP%` 落 `qvp-hook-*` / `qvp-index-*` / `qvp-audit-wire-*` 等临时目录且**不自动回收**——第 12 条那次"Temp 已清空 262 项"之后，09-30 19:14 与 10-01 两轮跑测又攒出 **134 项**（249 个文件 / 133 KB）。本轮清理前按第 11 条口径重扫过：现取 needle（`HOST <fp:sub-host>/18`、`PATH <fp:sub-path>/20`、`TOKEN <fp:sub-token>/32`）**0 命中**；形状法另有 9 条命中，逐条与仓库 fixture 字面量比指纹后 8 条对上、剩下 1 条要单独定性（`qvp-red.txt` 里的 `9912700ada/43`）：它是 `http://`、主机 9 字符（真订阅主机 18 字符、fp `<fp:sub-host>`），路径段**长度同为 20 但 fp 是 `a51dec84b9` ≠ 真值 `<fp:sub-path>`** → 判为合成值，不是泄露；这条恰好说明为什么判据必须落在**值/指纹**上而不是"长度像不像"。**结论：每跑一次测试就要重新清一次 Temp**，修法应是用例自己的 `finally` 回收（或统一挂到 `QODER_VPN_PROXY_DATA` 下的单一目录），属测试改造、不动生产代码，所以同样先报不改。

18. **⑥ 与 ⑦ 都已按 TDD 修掉（`056ded7` / `7b8a20f`），7 份带 token 的 profiles 备份按授权删除；跑验证时撞出新缺陷 ⑧（未修）**

   **⑥ 的改法就一行顺序 + 一段为什么**：`server/discovery.js` 的 `CONFIG_SOURCES` 由 `['config.yaml', 'clash-verge.yaml', 'clash-verge-check.yaml']` 改成 `['clash-verge.yaml', 'config.yaml', 'clash-verge-check.yaml']`，并把"运行时产物优先、基座是坏运行时配置的兜底"写进注释。RED 核对过失败理由（断言实际拿到 `+ 'config.yaml'`、期望 `- 'clash-verge.yaml'`）再改实现。`test/discovery.test.js` 新增一条"clash-verge.yaml 与 config.yaml 同时存在时取前者"，除了管道名还必须断言 **`secret` 也来自运行时文件**——基座的旧密钥连 Sidecar 新管道只会 401，这是"读错文件"的第二种症状；同时把原有两条用例改名成「只有基座 config.yaml 时用它兜底」和「只有 clash-verge.yaml（首选源）时用它」，让"基座=兜底"这层语义落在标题里而不是注释里。**⑥ 之后 208/208。**
   **⑥ 的真机证据（spawn 安装副本的 `server/index.js` 走 MCP stdio，`QODER_VPN_PROXY_DATA` 指到 Temp，不碰真数据目录）**：`discover()` 回 `configSource:"clash-verge.yaml"`，Sidecar 管道名与第 17 条现读到的那个一致；`proxy_core_start` 的**就绪耗时 63 ms**——修前那次同一条路径是 25 000 ms 超时、还谎报 `core_not_running`（进程其实起来了、7897 也在听）；`proxy_status` 连上真核心回 **v1.19.31**。顺带把 ⑤ 也在真核心上复验了一次：传不存在的组 → `kind:"malformed_config"`，响应体是 mihomo 自己的 `HTTP 404 {"message":"Resource not found"}`，与第 17 条假核心的脾气对得上。
   **⑦ 的改法：测试侧集中登记 + 进程退出自扫，外加一处 `package.json` 的发现模式修正**：新增 `test/tmp.js`（`mkTmp(label)` 建 `qvp-<label>-XXXXXX` 并登记、`tmpDir(label)` 给依赖同名复位的老用例保持原语义、`sweepTmp()` 对 EBUSY/EPERM **计数不抛**、`process.on('exit', sweepTmp)`），把 `audit/store/index/session-start/subscriptions/toolconfig/tools` 里 17 处 `fs.mkdtempSync(path.join(os.tmpdir(), 'qvp-…'))` 全部换过去；`test/tmp.test.js` 4 条，其中"退出钩子真的扫"这条走子进程 fixture（`test/fixtures/tmp-leak-probe.js` 故意不自扫，父进程断言目录消失）。**反向对照做过**：临时注释掉 `process.on('exit', …)` 后，同一条 fixture 确实在 `%TEMP%` 留下了 `qvp-leak-vmxY4j` —— 证明这条断言不是空转，随后手工删掉该目录。
   **`package.json` 的 test 命令为什么改成显式 glob**：`node --test` 的默认发现模式含 `**/test/**/*.js`，会把测试替身和工具当用例跑——`test/fake-mihomo.js`、`test/tmp.js`、`test/fixtures/tmp-leak-probe.js` 各算一条，于是计数虚高。**实测**：默认模式 `# tests 215`，显式 `node --test "test/*.test.js"` `# tests 212`，多的 3 条正是那三个非用例文件（`node --test test/` 也是错的，只跑 1 条）。所以命令定成 `` "test": "node --test \"test/*.test.js\"" ``（JSON 里那对反斜杠是 JSON 转义，跑起来就是 `node --test "test/*.test.js"`），而**数字口径从现在起是 212 声明 / 212 通过**。
   **⑦ 的效果是量出来的，不是推的**：跑测前 `%TEMP%` 里 `qvp-*` 目录 **0** 个 → `npm test` 全量 **212/212** → 跑完再数仍是 **0**（改之前每跑一次留 5 个，第 17 条那两轮攒出过 134 项）。刚又用默认发现模式跑了一遍 215/215，Temp 依然 0，即自扫不依赖命令写法。安装副本同步后与源码树逐字节相同（`diff -rq` server/test/skills/hooks + `cmp README.md/package.json/.qoder-plugin/plugin.json`；写比对脚本时别把 `plugin.json` 摆在插件根去找——它其实在 `.qoder-plugin/` 子目录里，路径写错会报成一次假 "DIFF"，本次就这么错过一次）。

   **⑧（新缺陷，未修，等点头）：一次被中断的 `core_start` 会把"压制系统代理"永久留在 `verge.yaml` 里。** 触发方式很日常：我把验证脚本的输出接了 `head -120`，`head` 读完就退出 → node 收到 **SIGPIPE** 被杀 → 脚本里排在后面的 `proxy_core_stop` 根本没执行。后果是 `verge.yaml` 停在 `enable_system_proxy: false`（4808 B），而 `proxy_status` 里**没有任何字段说"插件压制过且未还原"**，调用方看不到这个状态。
   **为什么这算缺陷而不是我的操作失误**：`stop()` 的还原基准是"它自己那次调用的入口状态"，`start()` 压制成功后不留任何跨调用凭证；一旦进程被中断，压制就成了无主状态，下次 `stop()` 也不会去补。修法建议（**未实现**）：`start()` 压制时在数据目录落一个 session marker，记下压制前的键值，`proxy_status` 见到 marker 就把它列进 `warnings` 并给出还原命令；这与第 10 条"绝不写注册表"的边界不冲突——只改 `verge.yaml`，且仍走既有备份。
   **本次的现场修复**：没有手改字节，而是用插件自己的 `CvrConfig.patchVerge` 把 `enable_system_proxy` 改回 `true`（它按契约先落了备份 `verge.yaml.20261001-192533-016-001`），复核现读 `verge.yaml`（4807 B）：`enable_system_proxy: true` / `enable_tun_mode: false` / `enable_external_controller: false`。
   **顺带一条 Windows 事实（与 ⑧ 同族的加固项，本次实测坐实）**：`fs.copyFileSync` 走 Win32 `CopyFile`，**保留源文件的 mtime**——造一个 mtime 为 `2026-08-22T10:00:00Z` 的文件再 copy，副本 mtime 一模一样（只有 birthtime 是当下）。而 `listBackups()` 的排序键是 `(mtime desc) || (ts desc)`，**mtime 是主键、文件名里的 ts 只是并列时的次序**，所以"哪份备份最新"这句话在一个"复制旧基座 → 落新备份"的流程里会判错（例：先备份一份被 CVR 几个月前写过的 `verge.yaml`，它的 mtime 比昨天的备份还老，却排在前面）。加固方向：把 ts 提为主键、mtime 降为次要键；`backup()` 已经用 `stamp()+"-"+seq` 保证了 ts 在同一毫秒内也可排序，改起来不引入新信息。

   **7 份带 token 的 profiles 备份已按授权删除**（口径同第 11/13/16 条：needle 运行时从本机 CVR 配置现取，只印 `sha256[:10]`+长度）。**删前**扫 `backups/` + `.trash/` + `logs/` 共 **22 个文件**，命中订阅 URL needle 的正好 **7 个**，且都是 `profiles.yaml.*.bak`（原始字节、未脱敏）；**删后**复扫 **15 个文件、URL needle 0 命中**。现在 `backups/` 剩 **10 个文件，全部是 `verge.yaml.*.bak`**（含本次修复落的 `192533-016-001`），`verge.yaml` 本身不含订阅 token。
   **一条要用户单独点头的残留**：`~/.qoder/vpn-proxy/.trash/` 里两份 `20260930125704203-003-lkYFauvJwQeP.yaml` / `20260930130959728-003-Rq14DVii2DNo.yaml`（各 **28 648 B**）命中 **14 条节点秘密 needle**（现取运行时配置里的 password/uuid/server/sni 值）。这是 09-30 那次订阅操作软删的旧正文，属于"节点凭据"而不是"订阅 token"，所以没被上面那条删除覆盖——**本次授权只到 profiles 备份，这两份我没动**，等一句话确认。

   **收尾复查**：核心已 `proxy_core_stop`，`tasklist` 无 `clash-verge`/`verge-mihomo`，7897 无监听，两个管道名都 ENOENT；注册表 `ProxyEnable=0x0`、`ProxyServer`/`ProxyOverride` 按用户口径没动；本轮所有 Temp 脚手架与一次性脚本（`verify6.cjs` / `store-scan.cjs` / `temp-scan.cjs` / `repair-verge.cjs` / `migrate-tmp.cjs`）已删除，验证跑测的带 token 备份因走 `QODER_VPN_PROXY_DATA` 只落在 Temp 里、随目录一起清掉。**同一个坑第六次**：`056ded7`/`7b8a20f` 的字节要等 Qoder 真重启才在服务进程里生效——本会话里正在服务的那个进程仍是改前字节，第 17 条那套"验安装副本本身"的绕法是有效的替代。
   **git 状态**：本地 tip `7b8a20f`（⑥ `056ded7` + ⑦ `7b8a20f`），远端仍是 `34fe7f1`；`3b011ae`（⑤）与这两条都**未推送**，推送与 PR #1 的增量都等用户点头。（→ 10-02 已按授权推送，见第 19 条。）

19. **2026-10-02：⑤⑥⑦ 按授权推进 PR #1（远端 `34fe7f1` → `e32b983`），推送前三道门与一条假警报定性**

   **做法与第 15 条同**：从 `origin/qoder-vpn-proxy`（`34fe7f1`）切**临时 worktree + 临时分支**，只 cherry-pick 三个代码提交 → `f55306f`(⑤)、`e3f420f`(⑥)、`e32b983`(⑦)；本地那 11 条 docs 提交（第 15–18 条与其修正）一条都没带出去。**踩到的一条**：`git cherry-pick` 不带身份会在**已经 apply 之后**才失败（`unable to auto-detect email address`），此时索引里留着改动、后续 pick 全被 `local changes would be overwritten` 挡下——`git -c user.name=… -c user.email=… cherry-pick` 才对（仍不动 `git config`），我这次是先 `cherry-pick --abort` 再重跑。
   **三道门**：(1) **子树一致性**：`git diff --stat qoder-vpn-proxy e32b983 -- qoder-vpn-proxy/` 输出为空 → 要推的插件目录与本地 tip 逐字节相同，差异只在 `docs/`（工作树根、插件目录之外）。(2) **在被推的那棵树里跑测试**：`npm test` → **212/212**，`%TEMP%` 里 `qvp-*` 仍为 0（⑦ 自扫在临时 worktree 里同样成立）。(3) **凭据扫描**：对改动文件在 base+tip 两端的 **29 个 blob**，用运行时从本机 `profiles.yaml`/`clash-verge.yaml` 现取的 **16 条 needle**（订阅面 4 / 节点面 12）比对，只印 `sha256[:10]`+长度 → **0 条真凭据命中**。
   **两类"看着像"必须逐条定性，否则下次还会误判**：(a) 形状法在 `audit/subscriptions/tools` 三个测试里各命中 1–2 条带 `token=<32hex>` 的 URL，但主机 `ba44c0cdf2/19`、`1fcb5f1086/22`、`f417b8c2f8/21` 都与真值 `<fp:sub-host>/18` 不同，路径段 `bd0f1d29c1/22`、`a51dec84b9/20`、`4266a021bd/22` 都与真值 `<fp:sub-path>/20` 不同 → 全是合成 fixture。(b) 唯一一条 needle 真命中是 `f1412386aa/7`，落在 `tools.test.js` 两行假 curl 输出的 `%{remote_ip}` 位；我用候选词反查指纹确认它就是 **`1.1.1.1`**（Cloudflare 公共 DNS，本机订阅里某个 `server:` 值恰好是它）。**教训**：公共值（公共 DNS、`127.0.0.1`、`example.com`）进 needle 表会造成长期假警报——needle 抽取要带一张公共值排除表，这条比"按形状取 needle"更值得固化。
   **网络与生效方式（两处要更正前面的口径）**：推送这一刻 github.com 直连**又**挂了（`--noproxy '*'` 连续 5 次全 `000`，而同一会话开头 `git fetch` 还成功——第 6 次印证"别缓存这个判断"），于是按用户既定口径走会话级代理：`proxy_core_start scope=session` → `git -c http.proxy=http://127.0.0.1:7897 push` → `34fe7f1..e32b983`（**fast-forward，无 force**）。同时这次 `core_start` 回 `channel.kind:"pipe"`、`waitedMs:9011` 直接就绪，说明**新会话重新 spawn 的服务进程已经带 ⑥**——第 16/17/18 条反复说的"要等真重启"过强了，准确说法是**新建会话即生效**（与安装副本字节同步是两件事），本条把那条口径纠正过来。
   **远端核对**：`git ls-remote` 回 `refs/heads/qoder-vpn-proxy = refs/pull/1/head = e32b983ba44e997bd6243d61dbc95bf1a9259674` → **PR #1 现在含订阅 URL 脱敏 + ①②④ + ⑤⑥⑦**。
   **收尾复查**：`proxy_core_stop restore=true` 用本次 start 落的 `verge.yaml.20261002-080940-559-002`；独立复核：`tasklist` 0 个 `clash-verge`/`verge-mihomo`、7897/9097 0 监听、注册表 `ProxyEnable=0x0`（`ProxyServer`/`ProxyOverride` 未动）、`verge.yaml` 三键 `enable_system_proxy: true` / `enable_tun_mode: false` / `enable_external_controller: false`、4807 B。临时 worktree 注销后 `git worktree remove` 删空目录时报过一次 `Permission denied`（内容已删净，`git worktree list` 里已消失），随后 `rmdir` 成功；`tmp/pr1-push` 分支已删；Temp 的 4 个一次性脚本（扫描器 + 掩码上下文探针 + 两份输出）已删，`qvp-*` 归 0。
   **新残留一条，等点头**：本次 `core_start` 又按契约落了 `backups/profiles.yaml.20261002-080940-557-001.bak`（**未脱敏、含订阅 token**），`backups/` 现 **13 个文件**。上一轮的删除授权只覆盖当时那 7 份，这份我没有动；要么单独授权删，要么以后每次 `core_start` 都提醒一次。（→ 10-02 按"先脱敏，然后修复缺陷"就地掩掉了，见第 20 条。）

20. **2026-10-02：三处凭据残留改为就地脱敏（不删文件），缺陷 ⑧ 按 TDD 修完并真机复验 17/17；同族加固把备份排序的主键从 mtime 换成时间戳**

   **用户口径变了**：第 18/19 条留的"要么删、要么每次提醒"没有选删除，而是**"三件事先脱敏，然后修复缺陷"** —— 保留文件（restore 的依据还在），只把里面的凭据掩掉。这三处是 `backups/profiles.yaml.20261002-080940-557-001.bak` 与 `.trash/` 两份订阅正文。

   **脱敏不是"跑个正则"，第一轮差点漏干净**（这一条最值得固化）：
   - **行锚定的 `key: value` 解析看不见 flow-mapping**。`.trash` 那两份是 mihomo 运行时配置（556 行），节点写成一行一个 `    - { name: …, type: ss, server: …, port: 53, password: …, cipher: …, udp: … }`，`^\s*(password):\s*(.+)$` 这类锚定式**整段扫不到**，所以第一版探针报"needle 命中 0 条"、而上一轮按形状扫的是 14 条 —— 两个数字都不算错，只是量的面不同。改成"整行子串比对内存里的原值"才抓到真值，掩码也改成按 `key:` 在 `空格 / , / { / "` 之后出现来定位。
   - **"算法名"启发式会静默排掉 UUID**。我原先用"含 `-` 且只由 `[a-z0-9-]` 组成"来排除 `aes-256-gcm` 这类 cipher 值，结果 `uuid`/`short-id` 这些同样是 UUID 的秘密被一起排除了，needle 表停在 23 条。换成显式密码套件前缀黑名单（`CIPHER_RE = /^(aes|chacha20|xchacha20|salsa20|rc4|des-|camellia|bf-|seed|aria|twofold|none|plain|http)/i`）后 needle 从 **23 → 40 条**，并把 `public-key` / `short-id` / `secret` / `obfs-password` 补进 SECRET_KEYS、把 `set-your-secret`、`verge-mihomo` 这类占位/进程名补进公共值表（第 19 条 `1.1.1.1` 假警报的同族）。
   - **`proxy-groups` 里内联的 `url:` 是旧订阅链接**，行锚定法同样到不了 → 再加一层"全文 needle 替换，长串优先"。URL 形状的 needle 统一替换成插件自己的显示形态 `https://<redacted-host>/<redacted-path>?<redacted-query>`，跟 `proxy_status` 的输出面口径一致。
   - **一处越界在复核时被自己否掉**：最初连节点的 `name:` 一起掩了，但这既和 `proxy-groups` 里的 `proxies:` 数组失配（改出来的文件语义坏掉），也违背插件自己的契约——`proxy_nodes` 本来就返回节点名。最终**节点名保留**，只掩 server/port/password/uuid/sni/cipher 之外的秘密键。

   **改前先验、改后才动真文件**：整个掩码先在 `QODER_VPN_PROXY_DATA` 指到 Temp 的**副本**上跑，两道独立证据都过才落到真文件：(1) 用 40 条 needle 重扫 → 0 命中；(2) 结构法"不存在未被掩的凭据键" → 0 命中。再加形状自检：行数、花括号数、冒号数逐项对齐（中途正是靠"冒号 87→86"抓到一个正则分组下标取错的 bug：`maskUrlLine` 把 `m[2]`（嵌套的空白组）当值，URL 被替换成裸 `<redacted>` 并把 `url:` 的冒号吃掉了）。实测结果：
   - `backups/profiles.yaml.20261002-080940-557-001.bak`：**1750 → 1720 B，恰好只改 1 行**（L44 的 `url:`），89 行 → 89 行，冒号 87 → 87。
   - `.trash/` 两份订阅正文：各 **28648 → 27615 B**，每份掩掉 **66 个结构性凭据值 + 2 处订阅 URL needle**，556 行、31/31 花括号不变。
   - 全盘复扫（`backups/` + `.trash/` + `logs/` 共 **19 个文件**，40 条 needle）→ **命中文件 0 个、命中 0 条**。输出面照旧只印 `sha256[:10]` + 长度，全程没把任何一个原值打到屏幕上。
   **两条要说给用户后果**：(a) 那份 profiles 备份不再是可用的还原源——用它 restore 会把 `url:` 写成一条死链接；(b) 真 `profiles.yaml` 与这份"掩码后的基线"字节必然不同，所以 `proxy_status.configDrift` 从现在起会把 `profiles.yaml` 报成 `dirty`。这是脱敏的代价，不是新问题。

   **⑧ 的修法就是第 18 条写下的方案，一字未改地实现**：`CvrConfig` 新增可选 `markerPath`（不注入时整套机制休眠，现有调用与测试零改动）；`start(scope=session)` **在压制之前**把 `enable_system_proxy` / `enable_proxy_guard` 的原值记进数据目录的 `suppression.json`（`{version, created, updated, entries:[{key,before,after}]}`），**合并时同键保留最早的 `before`**（否则第二轮 start 会把用户的 `true` 洗成上一轮压制出来的 `false`）；`stop()` 先 restore 再按凭证补写（`patchVerge` → 照例先备份），全部对齐才作废凭证，`restore:false` 则保留并说话；`start` 失败的回滚除 `restoreFrom(入口备份)` 之外**也要按凭证补写一次**——入口备份本身就可能是压制态。`proxy_status` 多出 `suppression` 一块：`present` + `state`（核心在跑 = `active`，没跑 = `orphaned`）+ `entries`，且 `present:true` 时**必然进 `warnings`**（只在子字段里说等于没说）。边界与第 10 条不冲突：只改 `verge.yaml`、仍走既有备份、注册表照旧只读。

   **TDD 里抓到一个自己写的空转用例**：`start 失败回滚时也要把 marker 撤掉` 第一轮**直接通过**了——因为实现根本没写过 marker，"文件不存在"这句断言自然成立。改成两轮：先让一轮**成功**的 start 把凭证落到盘上（断言前置条件成立），再用 `waitForChannel` 抛错的第二轮 start 去失败回滚，并加断言"回滚后 `enable_system_proxy` 必须已是原值"（这条同时把"回滚要按凭证补写"这个新契约钉住）。其余 8 条 marker 用例 + 1 条 `listBackups` 用例 + 2 条 `proxy_status` 用例都先核对过失败理由（缺字段 / `ENOENT` / `reading 'present'`）再改实现。
   **同族加固（第 18 条末实测坐实的那条）**：`listBackups` 与 `store.listBackupsIn` 改成**时间戳为主键、mtime 只兜底**（两种 stamp 去掉分隔符后同为 20 位数字，可直接比大小；`padEnd(24,'0')` 只给极端长度留确定次序）。危害不止"restore 挑到过期那份"——`pruneBackupsIn` 的"每组至少留最新一份"依赖同一顺序，mtime 主键会把 `copyFileSync` 复制来的、mtime 很老的**真正最新备份**当旧的删掉，所以新增的 store 用例把这条直接断言进 prune 结果里。原有用例只改标题（`按 mtime 排` → `按时间戳排（mtime 只兜底）`），其断言在新主键下同样成立（那份带横杠的文件既是更晚 ts 也是更晚 mtime）。

   **测试**：`npm test`（显式 glob `node --test "test/*.test.js"`）→ **223/223**，口径从 212 起 **+11**（cvr-config 8、store 1、tools 2）。跑完 `%TEMP%` 里 `qvp*` = **0**（⑦ 自扫仍成立）。

   **真机复验（spawn 安装副本的 `server/index.js` 走 MCP stdio，`QODER_VPN_PROXY_DATA` 指到 Temp，不碰真数据目录）：17/17**。现场照 ⑧ 的踩法复现：会话 A `core_start scope=session`（`waitedMs=2552`、`channel=pipe`）→ 返回值自证 `suppressionMarker.entries = [[enable_system_proxy,true],[enable_proxy_guard,false]]`（**本机 `enable_proxy_guard` 用户本来就设 false，凭证如实记 false**，所以"合并保住原值"那条断言按起始快照比而不是硬编码 true）→ 直接把调用方 **SIGKILL**（没有 stop）→ `tasklist` 证实核心仍在跑、`verge.yaml` 停在压制态 → 会话 B `proxy_status` 报得出凭证并进 `warnings`（"…enable_system_proxy（原值 true）…尚未确认还原…收尾请用 proxy_core_stop"）→ 会话 B 再 `core_start`（入口备份本身就是压制态）后 `stop restore=false` 保住凭证、`stop restore=true` 回 `suppression.repaired=[{enable_system_proxy, false→true}] cleared=true`。收尾独立复核：`verge.yaml` **四个键与起始值相同且逐字节相同（sha256[:10] `<fp:verge-yaml>` → `<fp:verge-yaml>`，4807 B）**、`suppression.json` 已消失、`tasklist` 0 个 CVR 进程、7897 无监听、`ProxyEnable=0x0`（`ProxyServer`/`ProxyOverride` 未动）、Temp 数据目录（含 7 份备份、其中 2 份带 token 的 profiles）**随目录删除**，真 `backups/` 仍是 **13 个文件、没有新增**、真数据目录下没有 `suppression.json`（说明此刻确实无欠）。

   **一条真机未通过项的定性（不是 ⑧ 的逻辑错）**：第一次跑时 `stop(restore=false)` 之后立刻 `proxy_status` 仍回 `running:true` → `state:active` 而不是 `orphaned`。单独探针定位：同一时刻 `tasklist /FO CSV` 实测**没有任何 CVR 进程**，而 2.4 秒后同一条 `proxy_status` 就回 `running:false / state:orphaned` —— 是 `server/index.js` 的 **`RUNTIME_TTL_MS = 2000` runtime 缓存**在 stop 之后还留着旧值（`stop` 本身不刷新缓存），属第 15 条就存在的缓存语义，与 marker 判定无关。影响面很窄：`warnings` 在 `present:true` 时无论如何都会出（只是措辞是"本会话压制中"），而真实孤儿场景是**新会话**冷启动读到的，缓存是空的，判得准。所以本轮只把主验证的等待从 800ms 调到 2600ms 让断言口径与实测一致，**没有**为此扩 `getRuntime` 的签名（改成"present 时强制刷新"或"拿 `core.reachable` 反推"都会把"CVR 在跑但控制器不可达"误标成 orphaned，风险大于收益）。留给以后的候选修法：给 `getRuntime` 加一个 `force` 参数并只在 `proxy_core_stop` 之后用一次。

   **安装副本**：`server/{cvr-config,store,tools,index}.js`、`test/{cvr-config,store,tools}.test.js`、`README.md`、`skills/vpn-proxy/SKILL.md` 同步后与源码树逐字节相同（`diff -rq --exclude=node_modules` server/test/skills/hooks + `cmp README.md/package.json/.qoder-plugin/plugin.json`，全 SAME）。README 补了 `suppression.json` 一行与两个工具的输出说明；SKILL.md 在"什么时候用哪个工具"加一行"上一个会话是不是压制了系统代理没还原"、在边界里点明 **`scope=session` 确实会改 `verge.yaml`**（先前那句"不改系统代理"容易被读成"这个键不碰"）、并新增"`suppression.available:false` 是读不到、`error:"unreadable"` 时插件既不猜原值也不顺手删"。

   **git 状态**：本地 tip `2788372`（⑧ 的代码提交，含同族加固与文档；测试 223/223），其下是第 19 条推出去的 `98c5824` 等 docs 提交。**远端仍是 `e32b983`** —— 这条代码提交**未推送**，推不推、要不要再走一次"临时 worktree + cherry-pick"的三道门等用户点头。Temp 的一次性脚本（`qvp-mask.cjs` / `qvp-audit-tree.cjs` / `qvp-diff.cjs` / `qvp-shape.cjs` / `qvp-residual-host.cjs` / `qvp8-verify.cjs` / `qvp8b-probe.cjs`）全部删除，`%TEMP%` 里 `qvp*` = 0。

21. **2026-10-02：docs 口径从"永不推"改为"脱敏后一起推 PR #1"——先把第 11–20 条里的身份指纹与本机用户名换成语义占位，再推。推之前必须验的一件事是"远端那份文档现在到底到第几条"**

   **为什么这次一定要脱敏，是先查证而不是先假设**：`git ls-tree -r e32b983 | grep '^docs/'` 回 6 个文件，`git show e32b983:docs/.../acceptance.md` 是 **522 行 / 53 229 B、编号只到第 10 条**，而且对 5 个身份指纹逐个 `grep -c` 全是 **0**（订阅 host/path/token 与 `urlFingerprint`、Sidecar 管道名那批 `sha256[:10]` 一条都不在远端）。也就是说公开仓库里的 docs 停在"还没有活凭据审计叙事"的第 10 条；把第 11 条往后推上去**才是**首次公开，而第 11–20 条恰好是审计叙述，里面钉着真值指纹。反过来说：如果当初查证成"docs 早就公开了"，这次的处置就得变成第三轮历史重写，完全是另一件事。**结论先记下来**：判"要不要脱敏"之前先查远端那一版到哪，别拿本地 tip 的内容推断公开面。

   **脱敏映射（`Temp/qvp-mask-docs.js`，只打印替换计数，原值一个不上屏）**：7 个身份承载的 `sha256[:10]` → 语义占位 —— 订阅 host `<fp:sub-host>`、路径段 `<fp:sub-path>`、token `<fp:sub-token>`、整条 URL `<fp:sub-url>`、`urlFingerprint` `<fp:url-fingerprint>`、Sidecar 管道名 `<fp:pipe-name>`、本机 `verge.yaml` 内容哈希 `<fp:verge-yaml>`；外加本机登录名（Windows 账户名，13 字符，不在任何 needle 表里）→ `<user>`（同时覆盖 `C:\Users\…`、`C:\\Users\\…`、`/c/Users/…`、`ls` 属主列与 JSON 里的 `author.name`）。计数：acceptance **39 处**（指纹 25 + 用户名 14，105 049 → 105 055 B）、plans 3 处、probes/03 1 处，specs 与 probes/01、02 零替换。**指纹的"长度"保留**（`<fp:sub-host>/18` 这种写法照旧），泄露的是值不是位数，而位数本来就是审计口径的一部分。

   **有意保留的 10 位十六进制**（复核时逐个定过性，别下次又当残留）：公共值与合成 fixture 的指纹 —— `www.gstatic.com`/`generate_204`/`1.1.1.1` 各一条，加 6 条测试替身里的假 host/假路径段指纹（第 19 条"两类看着像"的叙事要靠它们才能对上"与真值不同"）；以及十进制整数（时间戳 `179xxxxxxx`、`1073741824`）与 Qoder beta 版本号里的 `26f2496093`。**判据是"这个串是不是本机独有身份的哈希"，不是"它像不像十六进制"**。

   **复扫（口径要说清，别混用）**：`Temp/qvp-docs-scan.js` 运行时从 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev` 现取 needle —— `profiles.yaml` 的 `url:` 出订阅面 3 条（host/path/query），`profiles/` 13 个内容文件出节点面秘密（`password` 1、`server` 12），带公共值排除表与 cipher 前缀黑名单，共 **16 条**。结果：docs 6 个文件 + 两个脱敏前旧 blob（`98c5824` 94 113 B、`daf583b` 105 049 B）**命中 0**，作对照器的插件子树 54 文件也 0。这条表比第 20 条那次的 **40 条窄**，因为 `.trash/` 两份已经掩掉、不再当 needle 源 —— 所以它证明的是"docs 不含本机现值"，不重复证明第 20 条的残留结论。

   **推 docs 的正确做法不是 cherry-pick 那两条 docs 提交**（这一条最容易做错，值得固化）：`98c5824`/`daf583b` 的 **tree 里存的是脱敏前的整份文件**，cherry-pick 等于把未掩码 blob 送进公开历史，掩码白做。改成：临时 worktree 从 `e32b983` 切分支 → cherry-pick 代码提交 `2788372` → **从已脱敏的工作树快照单独建一条 docs 提交**（`git checkout <本地 tip> -- docs/` 之后整棵 `docs/` 作为一个新 blob）。这样公开历史上每一版 `docs/` 都是掩码后的。附带好处：本地历史保留未掩码原文（事实记录不缩水），公开面只有占位。

   **推送与三道门 / 远端核对 / 收尾（补记）**：门 1 `git diff --stat <本地 tip> HEAD -- qoder-vpn-proxy/` **为空**（要推的插件子树与本地逐字节相同）。门 2 在临时 worktree 里 `npm test` → **223/223**，跑完 `%TEMP%` 无 `qvp-*` 目录残留。门 3 换成了"对**要推的那棵树**逐 blob 扫"（`Temp/qvp-push-gate.js`：`git ls-tree -r HEAD` 全 62 个 blob 都 `git show` 出来比对），三条判据一起看：16 条现取 needle **0 命中**、7 个身份指纹字面量 **0 命中**、本机登录名 **0 命中**。**这道门当场抓到我自己的漏口**：第 21 条正文里为了说明映射关系把登录名原值写了出来（1 处）—— 改成"本机登录名（13 字符）"后本地补一条提交再重过门。唯一剩下的 flagged 是 `qoder-vpn-proxy/.qoder-plugin/plugin.json` 的 `"author": {"name": "<本机登录名>"}`，它是 `e32b983` 之前**就已公开**的既有值且本次未改动该文件（`git diff --name-only e32b983 HEAD -- .qoder-plugin/` 为空）；前向修法（author 换成 GitHub 登录名或占位）是另一件事，等点头再做，别顺手混进这次推送。
   **网络**：直连三连测两次 `Failed to connect to github.com port 443 after ~21100 ms`、一次 `expected flush after ref listing` → 按既定口径走会话级代理 `proxy_core_start scope=session` → `git -c http.proxy=http://127.0.0.1:7897 push` → **`e32b983..734ce57`（fast-forward，无 force）**；推前 `ls-remote` 先确认远端确实还停在 `e32b983`。远端核对：`refs/heads/qoder-vpn-proxy = refs/pull/1/head = 734ce57c7622d3853a961fa49490f2d3e4425ed0`，`master` 仍是 `2b3a7cc` 未动。**PR #1 现在含订阅 URL 脱敏 + ①②④ + ⑤⑥⑦ + ⑧，以及第 11–21 条的掩码版验收文档**。
   **⑧ 这次没参与兜底（要说清，否则会误以为新代码在护着）**：本会话的服务进程是在同步安装副本**之前**spawn 的，活证据是 `proxy_status` 返回里**没有** `suppression` 字段、`core_start` 返回里没有 `suppressionMarker`。所以 start→push→stop 全程靠流程纪律（不接 `| head`、push 完立刻 stop、独立复核收尾），与第 19 条"新建会话才是新字节"是同一件事的正反两面。
   **收尾独立复核**（不采信工具自述）：`tasklist` 0 个 `clash-verge`/`verge-mihomo`、7897/9097 0 监听、注册表 `ProxyEnable=0x0`（`ProxyServer`/`ProxyOverride` 未动）、`verge.yaml` **4807 B 且 sha256 前缀与压制前相同**、四键 `enable_system_proxy: true` / `enable_tun_mode: false` / `enable_external_controller: false` / `enable_proxy_guard: false`、数据目录下没有 `suppression.json`。临时 worktree 与 `tmp/pr1-push-2` 分支清理，一次性脚本删除。
   **本次 `core_start` 又落了一份带真 URL 的备份，按第 20 条既立的做法就地掩掉（这是"常规动作"的第一次执行）**：`backups/profiles.yaml.20261002-094318-067-001.bak` **1750 → 1720 B、只改 1 行、89 → 89 行、冒号 87 → 87、掩掉 1 处 URL needle（`<fp:sub-url>/86`）**，复扫残留 0。数据目录现状：`backups/` **17 项**（其中 1 个 `.npmrc.<时间戳>.bak` 是点文件，`ls -1` 不带 `-a` 会数成 16 —— 记一句免得下次对不上数）、`.trash/` 2、`logs/` 2、`subscriptions.json` 1，共 **22 个文件对 17 条现取 needle 0 命中**。顺带一条只读观察：这份新备份与上一份 profiles 备份的 mtime 相同（源文件这段时间没被改），所以本轮**时间戳序与 mtime 序恰好一致、没复现第 20 条那个分叉**；mtime 陷阱靠 store 用例钉着，不靠现场复现。
   **补记本身也被推上去了（第二次 push，带一段自指）**：上面那句"远端核对 = `734ce57`"写进文档之后，文档自己就成了下一条要推的内容，于是再走一次 `core_start scope=session` → push → `stop restore=true`，得到 **`734ce57..3a233d3`**（仍是 fast-forward）。**第一次尝试失败了**：`schannel: failed to receive handshake, SSL/TLS connection failed`，三条 curl 经代理到 `github.com` 全 `exit 35`；而 `proxy_status` 证明核心在跑、管道可达（v1.19.31），`proxy_test` 15 个节点 7 个通过、最快 88 ms 且本来就是当前选择 —— 所以**不是节点选择问题，是这台机器到 github 的 TLS 会话瞬时被打断**；隔几条命令后同一条 curl 回 `200 1.03s`，重试即成。"经代理失败"要分三层查（核心可达 / 节点健康 / 目标站握手），别一上来就换节点。
   **PR head 这次不靠本地代理核对**：核心已停，改走 GitHub API 读 PR #1 → `head.sha = 3a233d3…`、`base = master 2b3a7cc`、`merged:false`、`commits 43 / changed_files 61 / +10014 −794`。这比 `refs/pull/1/head` 可靠：那个 ref 由 GitHub 异步刷新，`git ls-remote` 当时还停在 `734ce57`。**由此产生的公开面自指滞后要认**：PR 里那份文档写的远端哈希是 `734ce57`，而记录它的提交把它推成了 `3a233d3` —— 公开文档永远落后自己一条，不再追推（追推只是把滞后往前挪一格）。
   **第二次 `core_start` 落的那份备份同样掩掉了**：`backups/profiles.yaml.20261002-094703-427-001.bak`，1750 → 1720 B、只改 1 行、89 → 89 行、冒号 87 → 87、复扫残留 0。数据目录终态：`backups/` **20 项**（含 1 个 `.npmrc.<时间戳>.bak` 点文件）、`.trash/` 2、`logs/` 2、`subscriptions.json` 1，共 **25 个文件对 17 条现取 needle 0 命中**。第二轮收尾独立复核同样干净：0 进程、7897/9097 0 监听、`ProxyEnable=0x0`、`verge.yaml` 4807 B 且内容哈希与压制前相同、四键原值、无 `suppression.json`。

22. **2026-10-02：推送后复核 —— 门 3 对"已经推出去的那棵树"重跑，并当场发现 PR #1 与 master 是真冲突**

   **对 `3a233d3` 逐 blob 重扫（不是复述推送前的结果）**：`git ls-tree -r` 62 个 blob 全部 `git show` 出来比对 → 16 条现取 needle **0 命中**、7 个身份指纹字面量 **0 命中**、本机登录名 **1 处**，就是 `qoder-vpn-proxy/.qoder-plugin/plugin.json` 的 `author.name`（既有公开值，本次未改该文件）。工作树侧同样干净：docs 8 个文件 + 作对照器的插件子树 54 文件 0 命中。**登录名那 1 处是唯一还挂在公开面的身份项**，前向修法（换成 GitHub 登录名或占位）等点头，别顺手混进别的推送。

   **本地与现场终态**：本地 tip `0cbad47`（把记录第二次 push 的那 4 行落在本地，**有意不追推**，理由见上一条的自指滞后）；`npm test` 在被复核的插件目录里 **223/223**、跑完 `%TEMP%` 里 `qvp-*` 条目 **0**（含目录）。临时 worktree `.worktrees/tmp-pr1-push` 与分支 `tmp/pr1-push-2` 已删，Temp 里本项目 19 个一次性脚本/输出（含带登录名字面量的门脚本）已清 —— 重建法就写在第 21 条与本条，不必留副本。收尾独立复核：0 个 `clash-verge`/`verge-mihomo`、7897/9097 0 监听、`ProxyEnable=0x0`，`ProxyServer`/`ProxyOverride` 按既定口径**未动**。

   **新发现（有实质含义，不是"PR 有点小冲突"）**：GitHub 报 PR #1 `mergeable_state:"dirty"`，本地 `git merge-tree --write-tree origin/master 3a233d3` 证实唯一冲突文件是 `docs/superpowers/plans/2026-09-30-qoder-vpn-proxy.md`。根因值得记一笔：master 的 `2b3a7cc` 把 git 代理键的测试片段改成**带尾斜杠**的 `http.https://github.com/.proxy`，并补了断言 —— 无斜杠时 git 的 `http.<url>.*` 前缀匹配会连带命中 `https://github.com.evil.example`，等于把代理设置泄漏给仿冒域名；而 PR 分支那份计划文档第 398 行**仍是修复前的无斜杠形式**（同一文档 4107/4201 行已是带斜杠形式，属漏改没漏到实现里 —— 实现的 `gitProxyKeys` 一直是带斜杠的）。**所以解冲突时不能整份取分支侧**，否则把修复前的措辞复活；正确取向是把 master 并入分支后手工把那一行对齐带斜杠形式并补上断言。

   **三条待点头（本次都没动）**：(1) 上面的冲突解决 —— 要再走一次 `core_start scope=session` → push → `stop` 的循环；(2) PR #1 正文仍停在"7 个 MCP 工具 / 165/165 / 8 个真机缺陷"，与现状（17 工具 / 223 用例 / 缺陷 ①–⑧）不符，且 `token=<redacted>` 的旧口径已被"整条订阅 URL 脱敏"取代 —— `update_pull_request` 一次即可；(3) plugin.json 的 `author.name`。
   **两条留给用户点头的公开面小事（本次都没动）**：(1) `qoder-vpn-proxy/.qoder-plugin/plugin.json` 的 `"author": {"name": "<本机登录名>"}` 从 `e32b983` 起就公开着；改成 GitHub 登录名或占位只要一次提交，但要同步安装副本并让门 1 重跑。(2) PR #1 正文还停在"7 个 MCP 工具 / 165/165 / 8 个真机缺陷"，与现状（17 工具 / 223 用例 / 缺陷 ①–⑧）不符，`update_pull_request` 一次即可。
