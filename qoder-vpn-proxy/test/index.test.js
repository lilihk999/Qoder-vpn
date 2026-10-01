'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../server/store');
const { makeLogger } = require('../server/index');
const T = require('./tmp');

const ENTRY = path.join(__dirname, '..', 'server', 'index.js');

/**
 * 沙箱：数据目录、APPDATA、HOME、安装候选全部指向空的临时目录。
 * 少了这一层，子进程会去连本机真实管道，测试结论随用户此刻开没开 Clash Verge 而变。
 */
function sandboxEnv() {
  const root = T.mkTmp('index');
  const empty = path.join(root, 'appdata');
  fs.mkdirSync(path.join(empty, 'Home'), { recursive: true });
  return {
    root,
    env: {
      ...process.env,
      QODER_VPN_PROXY_DATA: path.join(root, 'data'),
      APPDATA: empty,
      appdata: empty,
      HOME: path.join(root, 'appdata', 'Home'),
      USERPROFILE: path.join(root, 'appdata', 'Home'),
      QVP_INSTALL_CANDIDATES: path.join(root, 'no-such-install'),
    },
  };
}

function runServer(frames, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.write(frames.join('\n') + '\n');
    child.stdin.end();
  });
}

const FRAMES = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"proxy_status","arguments":{}}}',
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"proxy_subscriptions","arguments":{}}}',
];

test('stdio 冒烟：stdin 关闭后在途请求仍收尾，stdout 只有合法 JSON 帧', async () => {
  const { env } = sandboxEnv();
  const { code, out, err } = await runServer(FRAMES, env);
  assert.equal(code, 0, `退出码 ${code}，stderr: ${err}`);

  const lines = out.trim().split('\n');
  assert.equal(lines.length, 4, `stdout 应恰好 4 帧，实得 ${lines.length}：${out}`);
  // 响应不按请求顺序回来（proxy_status 比 proxy_subscriptions 多做两轮通道探测），
  // JSON-RPC 以 id 配对，客户端本来就该这么读
  const byId = new Map(lines.map((l) => { const m = JSON.parse(l); return [m.id, m]; }));
  assert.deepEqual([...byId.keys()].sort(), [1, 2, 3, 4]);
  assert.equal(byId.get(1).result.serverInfo.name, 'qoder-vpn-proxy');
  assert.equal(byId.get(2).result.tools.length, 17);

  const status = JSON.parse(byId.get(3).result.content[0].text);
  assert.equal(status.ok, true, 'proxy_status 报告状态，核心没跑也必须 ok');
  assert.equal(status.data.installed, false);
  assert.equal(status.data.core.reachable, false);

  const subs = JSON.parse(byId.get(4).result.content[0].text);
  assert.equal(subs.ok, false);
  assert.equal(subs.kind, 'not_installed');

  assert.match(err, /server 启动/);
});

test('每一行 stdout 都能独立解析，说明日志没有混进协议通道', async () => {
  const { env } = sandboxEnv();
  const { out } = await runServer(FRAMES.slice(0, 3), env);
  for (const line of out.trim().split('\n')) {
    assert.match(line, /^\{.*\}$/);
    JSON.parse(line);
  }
});

test('落盘日志这一行也先过脱敏：订阅链接不进 mcp.log', async () => {
  const root = T.mkTmp('logmask');
  const dirs = store.ensure(store.dirs({ QODER_VPN_PROXY_DATA: path.join(root, 'data') }));
  const log = makeLogger(dirs);
  // 同一行也会写 stderr（真进程里是给运维看的）；这里只验落盘那份，别让测试输出多一行噪音
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    log('tools/call proxy_subscription_add 内部异常: Error: 抓取 https://panel.example.invalid/SUBPATH?token=TOKEN_PLACEHOLDER 失败');
    // 等流真正落盘再读：close(cb) 在写完后才回调，否则这条断言会在缓冲未冲时偶然通过
    await new Promise((r) => log.close(r));
  } finally {
    process.stderr.write = realWrite;
  }
  const text = fs.readFileSync(path.join(dirs.logs, 'mcp.log'), 'utf8');
  assert.doesNotMatch(text, /panel\.example\.invalid|SUBPATH|TOKEN_PLACEHOLDER/, 'mcp.log 会留在磁盘上，比会话更持久');
  assert.match(text, /<masked-host>/, '抹过要留可见痕迹，否则只当日志坏了');
  fs.rmSync(root, { recursive: true, force: true });
});

test('真进程每次 tools/call 都落账：参数名进 logs/calls.jsonl，参数值不进', async () => {
  const { root, env } = sandboxEnv();
  const dirs = store.dirs({ QODER_VPN_PROXY_DATA: path.join(root, 'data') });
  const frames = [
    FRAMES[0],
    FRAMES[1],
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"proxy_nodes","arguments":{"group":"示例机场"}}}',
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"proxy_status","arguments":{}}}',
  ];
  const { out } = await runServer(frames, env);

  const file = path.join(dirs.logs, 'calls.jsonl');
  assert.ok(fs.existsSync(file), '没有接上真 deps 的账本等于没有账本');
  const dump = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(dump, /示例机场/, '组名是用户资产的一部分，不进永久磁盘');
  const byTool = new Map(dump.split('\n').filter(Boolean).map((l) => { const e = JSON.parse(l); return [e.tool, e]; }));
  // 两条并发处理，落账顺序不保证，所以按工具取而不是按下标取
  assert.deepEqual([...byTool.keys()].sort(), ['proxy_nodes', 'proxy_status']);
  assert.deepEqual(byTool.get('proxy_nodes').args, ['group']);
  assert.equal(byTool.get('proxy_nodes').ok, false, '沙箱里没有 CVR，proxy_nodes 必然失败');
  assert.equal(byTool.get('proxy_nodes').kind, 'not_installed');
  assert.equal(typeof byTool.get('proxy_status').ms, 'number');

  const status = JSON.parse(out.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 4).result.content[0].text);
  assert.equal(status.data.audit.enabled, true);
  assert.ok(status.data.audit.lines >= 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('QODER_VPN_PROXY_AUDIT=0 时真进程一个字节都不写，但工具照常返回', async () => {
  const { root, env } = sandboxEnv();
  env.QODER_VPN_PROXY_AUDIT = '0';
  const dirs = store.dirs({ QODER_VPN_PROXY_DATA: path.join(root, 'data') });
  const { out } = await runServer([FRAMES[0], FRAMES[1], FRAMES[3]], env);
  const status = JSON.parse(out.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 3).result.content[0].text);
  assert.equal(status.ok, true, '关账本不能把 proxy_status 一起关掉');
  assert.equal(status.data.audit.enabled, false, '必须如实标关闭，而不是假装没有日志这回事');
  assert.match(status.data.audit.note, /QODER_VPN_PROXY_AUDIT/);
  assert.equal(fs.existsSync(path.join(dirs.logs, 'calls.jsonl')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
