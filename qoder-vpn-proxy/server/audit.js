'use strict';
// 每次 tools/call 落一行的审计账本。
//
// 为什么要有它：本插件会读写 Clash Verge 的配置（订阅链接、节点选择、系统代理压制开关），
// 出问题时第一句问的一定是"什么时候调的哪个工具、带了哪些参数、成没成"。没有账本就只能靠
// 会话记忆和 backups/ 的时间戳反推，而 backups/ 记录不了失败的调用。
//
// 为什么只记参数名、不记参数值：订阅链接的值里有 token，节点名和 group 值能拼出机场结构，
// 而 logs/ 目录里的东西是永久磁盘残留 —— 会话结束不会清，卸载插件也未必清。参数名加 kind
// 已经足够定位"哪次调用把 url 传错了"（proxy_subscription_add 的 url 就是 url），值留给
// 调用方的上下文去看。这条边界由测试钉住，不靠自觉。
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'calls.jsonl';
// 上限刻意收紧：64KB 的 JSONL 够记几百次调用，再多就不如直接看会话。超限裁剪保最近 keepLines 条。
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_KEEP_LINES = 200;

/** 只把参数对象的名字抄下来 —— 这个函数存在的意义就是让"值"没有通路进入账本。 */
function argNames(args) {
  if (!args || typeof args !== 'object') return [];
  return Object.keys(args);
}

function createAudit({
  dirs,
  env = process.env,
  fsImpl = fs,
  now = () => new Date().toISOString(),
  maxBytes = DEFAULT_MAX_BYTES,
  keepLines = DEFAULT_KEEP_LINES,
} = {}) {
  const file = dirs ? path.join(dirs.logs, FILE) : null;
  // 关闭方式是环境变量而不是工具参数：审计给用户看，不该由被审计的那次调用来决定要不要记。
  const enabled = !!file && env.QODER_VPN_PROXY_AUDIT !== '0';

  function entryOf({ tool, argNames: names, ok, kind, ms }) {
    return {
      ts: now(),
      tool: String(tool),
      args: Array.isArray(names) ? names.map(String) : [],
      ok: !!ok,
      kind: kind === undefined || kind === null ? null : String(kind),
      ms: Number.isFinite(ms) ? Math.round(ms) : null,
    };
  }

  function trim() {
    let size;
    try { size = fsImpl.statSync(file).size; } catch { return; }
    if (size <= maxBytes) return;
    let lines;
    try { lines = fsImpl.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return; }
    const kept = lines.slice(Math.max(0, lines.length - keepLines));
    try { fsImpl.writeFileSync(file, `${kept.join('\n')}\n`); } catch { /* 裁不动就留着，下一轮再试 */ }
  }

  /** 落一行；返回写入的条目，关闭或写不进去时返回 null。绝不抛 —— 记账失败不能拖垮工具调用。 */
  function record(input) {
    if (!enabled) return null;
    const entry = entryOf(input || {});
    try {
      fsImpl.mkdirSync(dirs.logs, { recursive: true });
      fsImpl.appendFileSync(file, `${JSON.stringify(entry)}\n`);
      trim();
      return entry;
    } catch {
      return null;
    }
  }

  /** 回读最近 limit 条。坏行算进 lines（它确实在占磁盘），但不会混进 recent。 */
  function read(limit = 20) {
    if (!enabled) return { enabled: false, path: file, lines: 0, recent: [], note: 'QODER_VPN_PROXY_AUDIT=0，账本已关闭' };
    let raw;
    try { raw = fsImpl.readFileSync(file, 'utf8'); }
    catch (e) {
      return { enabled: true, path: file, lines: 0, recent: [], error: e.code || 'unreadable' };
    }
    const lines = raw.split('\n').filter(Boolean);
    const recent = [];
    for (const line of lines.slice(Math.max(0, lines.length - (Number(limit) || 0)))) {
      try { recent.push(JSON.parse(line)); } catch { /* 上一条被进程截断写过半行，忽略 */ }
    }
    return {
      enabled: true, path: file, lines: lines.length, recent,
      note: 'recent 按时间升序，不含本次调用 —— 账本由 tools/call 在 handler 返回后补写，成败与 kind 那时才知道',
    };
  }

  return { file, enabled, record, read };
}

module.exports = { createAudit, argNames, FILE, DEFAULT_MAX_BYTES, DEFAULT_KEEP_LINES };
