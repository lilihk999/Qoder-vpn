# 探针 01：命名管道的 mihomo REST 支持程度

**时间**：2026-09-30 12:39–13:10（本地）
**环境**：Clash Verge Rev（`C:\Program Files\Clash Verge`）+ 内置 `verge-mihomo` **v1.19.25**，
`verge.yaml` 的 `enable_external_controller: false`，`config.yaml` 的 `external-controller: 127.0.0.1:9097`（未监听）。
**结论先行**：命名管道完全够用，TCP 兜底一次也没用上；实现计划里"可能需要用户同意开外部控制"这条 **不成立**，spec §8 该项可以关掉。

## 1. 管道握手

| 项 | 结果 |
|---|---|
| 管道名 | `\\.\pipe\verge-mihomo`（`config.yaml` 里 `external-controller-pipe` 的真实值） |
| 认证 | `secret: set-your-secret`（默认值，CVR 没改），`Authorization: Bearer set-your-secret` |
| `GET /version` | 200 `{"meta":true,"version":"v1.19.25"}` |
| 需要开 `enable_external_controller` 吗 | **不需要**。该开关只控制 TCP 端口 9097 是否监听，管道由 mihomo 无条件创建 |

`proxy_core_start {scope:"session"}` 首次调用即 `channel.kind = "pipe"`，`waitedMs 2058`，
全程没有走 TCP 分支，也没有触发 `core_not_running`。

## 2. 端点实测矩阵

探针脚本按候选列表逐个发请求，2.5 秒内没返回的判为流式（`STREAM_OR_HANG`）。

| 方法 路径 | 结果 |
|---|---|
| `GET /version` `/configs` `/proxies` `/rules` `/connections` `/providers/proxies` | 2xx，正常 JSON |
| `PATCH /configs` | 204，**真的生效**（mode 改成 global 后回读为 global） |
| `PUT /configs` | 有 body 时 204 但**静默不生效**；空 body 时 400 `{"message":"Body invalid"}` |
| `PUT /proxies/<组>` | 204 且生效（回读 `now` 变了） |
| `GET /proxies/<节点>/delay` | 200 `{"delay":…}`；节点不通时 503 `An error occurred in the delay test`，非法名 504 `Timeout` |
| `POST /configs/reload` | **404 page not found** |
| `GET /providers` `/profiles` `/mode` `/cache/fakeip` `/experimental/ports` | 404 |
| `GET /traffic` `/memory` `/logs` | 流式：连上后不返回，会占死请求（我们的客户端没有 HTTP 级超时，只能靠不发这类请求规避） |

### 由此改掉的两处代码

1. `clash-client.setConfigs()` 从 `PUT /configs` 改为 `PATCH /configs`。
   真机现象：`proxy_select {mode:"global"}` 返回 `confirmed:false`、回读仍是 `rule`——
   PUT 接受请求却不应用。测试全绿是因为 fake-mihomo 当年实现了 PUT；现在 fake 改成
   "PUT 回 204 但不动状态"，把这个静默失败永久钉住。
2. `subscriptions.activate()` 不再依赖 `POST /configs/reload`。
   真机现象：profiles.yaml 的 `current` 已写对，但 reload 404 让整个 activate 报
   `channel_unavailable`，调用方会以为没切换成功而反复点。改成如实返回
   `reloaded:false, needsRestart:true` + 修复动作（重启核心或 GUI 点一下）。

## 3. 测速语义的坑

首轮 `proxy_test` 用默认 5000ms 扫全部 15 个节点 → `passed:0`，全是 503/504。
单独用 8000ms 复测同一个节点 → `HK 1 | v4 356ms OK`。再整组扫（8000ms）→ **8/15 通**，
最快 `TW 1 | v4 89ms`，失败的正好是 4 个 `| v6` 节点（本机无 IPv6 出口）与 3 个
订阅里混进来的非节点条目（`官网地址：`、`https://panel.nanshanyun.com`、`欢迎加群闲聊`）。

结论：`/delay` 首次拨号要建 TLS 隧道，5 秒预算在冷核心上会把好节点误判成死节点。
`ok:false` 的标注本身是对的（v6 与垃圾条目确实该失败），但**默认 timeout 偏紧**，
遗留问题记一条：考虑把默认值提到 8000，或在 hint 里提示"整组扫请传 timeout>=8000"。

## 4. 与 spec 的偏差

- spec §7.0 假设"管道可能不被 mihomo 支持，需要 TCP 兜底 + 用户同意开外部控制"。
  真机管道全功能，兜底路径至今没被走过（代码保留，作为 CVR 换版本时的保险）。
- `transport` 的 ORDER（pipe → tcp）不需要改。
