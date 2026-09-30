'use strict';
const { ApiError } = require('./envelope');

/**
 * profiles.yaml 归 CVR 所有，插件只动该动的字节，所以这里不用 YAML 库做全量
 * parse+stringify（那会丢掉 CVR 的格式习惯）。唯一的不变量是 render(parse(x)) === x。
 */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** CVR 把每项的第一个字段写在破折号同一行，其余字段缩进两空格 */
function fieldRe(key) {
  return new RegExp(`^(?:  |- )${esc(key)}:[ \\t]*(.*)$`);
}

function needsQuote(s) {
  if (s === '') return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true; // 行首指示符
  if (/:(\s|$)/.test(s)) return true; // 冒号后跟空格才是键值分隔，URL 里的 :// 不算
  if (/\s#/.test(s)) return true;
  if (/["\\\t]/.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  // 纯数字/true/false 一律裸写：readNested 交回来的是字符串，读改写时给它们加引号
  // 会让 CVR 在 u64/bool 字段上反序列化失败，而 CVR 自己写的就是裸值。
  return false;
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (!needsQuote(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function stripQuotes(v) {
  const t = String(v).trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  return t;
}

function readValue(raw) {
  if (raw === null || raw === undefined) return null;
  const v = stripQuotes(raw);
  return v === 'null' || v === '' ? null : v;
}

function parse(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // 文件末尾的换行在 split 后表现为最后一个空串元素。把它单独记成 finalNewline，
  // 块内就只剩内容行，不必再猜"这个空行属于哪个块"。
  const finalNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop();

  const start = lines.findIndex((l) => /^items:[ \t]*$/.test(l));
  if (start === -1) {
    return { headLines: lines, blocks: [], tailLines: [], eol, hasItems: false, finalNewline };
  }

  const headLines = lines.slice(0, start + 1);
  const blocks = [];
  const tailLines = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^- \S/.test(line)) { cur = { lines: [line] }; blocks.push(cur); continue; }
    if (cur && (line === '' || /^[ \t]+\S/.test(line))) { cur.lines.push(line); continue; }
    cur = null;
    tailLines.push(line);
  }
  return {
    headLines,
    blocks: blocks.map((b) => {
      const m = fieldRe('uid').exec(b.lines[0]);
      return { uid: m ? stripQuotes(m[1]) : null, lines: b.lines };
    }),
    tailLines,
    eol,
    hasItems: true,
    finalNewline,
  };
}

function render(model) {
  const lines = [...model.headLines];
  if (model.hasItems) {
    for (const b of model.blocks) lines.push(...b.lines);
    lines.push(...model.tailLines);
  } else {
    lines.push(...model.tailLines);
  }
  return lines.join(model.eol) + (model.finalNewline === false ? '' : model.eol);
}

function findBlock(model, uid, { required = true } = {}) {
  const hits = model.blocks.filter((b) => b.uid === uid);
  if (hits.length > 1) {
    throw new ApiError('malformed_config', `profiles.yaml 中 uid ${uid} 出现 ${hits.length} 次`, 'CVR 注册表异常，需手工确认后重试');
  }
  if (!hits.length) {
    if (required) throw new ApiError('subscription_not_found', `profiles.yaml 中没有 uid ${uid}`, '用 proxy_subscriptions 查看现有订阅');
    return null;
  }
  return hits[0];
}

function readField(lines, key) {
  const re = fieldRe(key);
  const hit = lines.find((l) => re.test(l));
  return hit === undefined ? null : readValue(re.exec(hit)[1]);
}

function readNested(lines, parent, key) {
  const pIdx = lines.findIndex((l) => new RegExp(`^  ${esc(parent)}:[ \\t]*$`).test(l));
  if (pIdx === -1) return null;
  const { end } = childRange(lines, pIdx);
  const re = new RegExp(`^    ${esc(key)}:[ \\t]*(.*)$`);
  for (let i = pIdx + 1; i < end; i += 1) {
    if (re.test(lines[i])) return readValue(re.exec(lines[i])[1]);
  }
  return null;
}

/** 父键行 [start, end) 覆盖的子行区间；缩进 4 空格或 2 空格短横线的行属于它 */
function childRange(lines, start) {
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l === '' || /^[ \t]{4,}\S/.test(l) || /^  - \S/.test(l)) { end += 1; continue; }
    break;
  }
  while (end - 1 > start && lines[end - 1] === '') end -= 1;
  return { start, end };
}

function itemOf(lines) {
  return {
    uid: readField(lines, 'uid'),
    type: readField(lines, 'type'),
    name: readField(lines, 'name'),
    file: readField(lines, 'file'),
    url: readField(lines, 'url'),
    updated: readField(lines, 'updated'),
    selected: (() => {
      const name = readSelectedName(lines);
      return name === null ? undefined : { name, now: readField(lines, 'now') };
    })(),
    extra: ['upload', 'download', 'total', 'expire'].reduce((a, k) => ({ ...a, [k]: readNested(lines, 'extra', k) }), {}),
    option: ['update_interval', 'allow_auto_update', 'merge', 'script', 'rules', 'proxies', 'groups']
      .reduce((a, k) => ({ ...a, [k]: readNested(lines, 'option', k) }), {}),
  };
}

function readSelectedName(lines) {
  const pIdx = lines.findIndex((l) => /^  selected:[ \t]*$/.test(l));
  if (pIdx === -1) return null;
  const { end } = childRange(lines, pIdx);
  const re = /^  - name:[ \t]*(.*)$/;
  for (let i = pIdx + 1; i < end; i += 1) if (re.test(lines[i])) return readValue(re.exec(lines[i])[1]);
  return null;
}

function setCurrent(text, uid) {
  const model = parse(text);
  findBlock(model, uid);
  return render({
    ...model,
    headLines: model.headLines.map((l) => (/^current:[ \t]*(.*)$/.test(l) ? `current: ${uid}` : l)),
  });
}

function setField(text, uid, key, value) {
  const model = parse(text);
  const block = findBlock(model, uid);
  const re = fieldRe(key);
  const next = [...block.lines];
  const idx = next.findIndex((l) => re.test(l));
  const dashForm = `- ${key}: ${yamlScalar(value)}`;
  const line = `  ${key}: ${yamlScalar(value)}`;
  if (idx === -1) next.push(key === 'uid' ? dashForm : line);
  else next[idx] = next[idx].startsWith('- ') ? dashForm : line;
  return replaceBlock(model, block, next);
}

function setNested(text, uid, parent, key, value) {
  const model = parse(text);
  const block = findBlock(model, uid);
  const lines = [...block.lines];
  const pIdx = lines.findIndex((l) => new RegExp(`^  ${esc(parent)}:[ \\t]*$`).test(l));
  const childLine = `    ${key}: ${yamlScalar(value)}`;
  if (pIdx === -1) {
    lines.push(`  ${parent}:`, childLine);
  } else {
    const { end } = childRange(lines, pIdx);
    const re = new RegExp(`^    ${esc(key)}:[ \\t]*(.*)$`);
    const hit = lines.findIndex((l, i) => i > pIdx && i < end && re.test(l));
    if (hit === -1) lines.splice(end, 0, childLine);
    else lines[hit] = childLine;
  }
  return replaceBlock(model, block, lines);
}

function setSelected(text, uid, { name, now }) {
  const model = parse(text);
  const block = findBlock(model, uid);
  const lines = [...block.lines];
  const replacement = ['  selected:', `  - name: ${yamlScalar(name)}`, `    now: ${yamlScalar(now)}`];
  const pIdx = lines.findIndex((l) => /^  selected:[ \t]*$/.test(l));
  if (pIdx === -1) lines.push(...replacement);
  else {
    const { end } = childRange(lines, pIdx);
    lines.splice(pIdx, end - pIdx, ...replacement);
  }
  return replaceBlock(model, block, lines);
}

function itemToLines(item) {
  const lines = [
    `- uid: ${yamlScalar(item.uid)}`,
    `  type: ${yamlScalar(item.type || 'remote')}`,
    `  name: ${yamlScalar(item.name ?? null)}`,
    `  file: ${yamlScalar(item.file)}`,
  ];
  if (item.url !== undefined && item.url !== null) lines.push(`  url: ${yamlScalar(item.url)}`);
  if (item.selected) {
    lines.push('  selected:', `  - name: ${yamlScalar(item.selected.name)}`, `    now: ${yamlScalar(item.selected.now)}`);
  }
  if (item.extra) {
    lines.push('  extra:');
    for (const [k, v] of Object.entries(item.extra)) lines.push(`    ${k}: ${yamlScalar(v)}`);
  }
  lines.push(`  updated: ${yamlScalar(item.updated)}`);
  if (item.option) {
    lines.push('  option:');
    for (const [k, v] of Object.entries(item.option)) lines.push(`    ${k}: ${yamlScalar(v)}`);
  }
  return lines;
}

function appendItem(text, item) {
  const model = parse(text);
  if (!model.hasItems) {
    throw new ApiError('malformed_config', 'profiles.yaml 中没有 items: 段，无法追加', '该文件形态异常，先用 proxy_restore_config 还原备份');
  }
  if (findBlock(model, item.uid, { required: false })) {
    throw new ApiError('malformed_config', `uid ${item.uid} 已存在`, '重新生成 uid 后再试');
  }
  const blocks = [...model.blocks.map((b) => ({ ...b })), { uid: item.uid, lines: itemToLines(item) }];
  return render({ ...model, blocks });
}

function removeItem(text, uid) {
  const model = parse(text);
  const block = findBlock(model, uid);
  const blocks = model.blocks.filter((b) => b !== block).map((b) => ({ ...b }));
  return render({ ...model, blocks });
}

function getItem(text, uid) {
  const model = parse(text);
  const block = findBlock(model, uid, { required: false });
  return block ? itemOf(block.lines) : null;
}

function listItems(text) {
  return parse(text).blocks.map((b) => itemOf(b.lines));
}

function replaceBlock(model, block, lines) {
  return render({ ...model, blocks: model.blocks.map((b) => (b === block ? { ...b, lines } : b)) });
}

module.exports = {
  parse, render, readField, readNested, yamlScalar, setCurrent, setField, setNested,
  setSelected, appendItem, removeItem, getItem, listItems, itemToLines,
};
