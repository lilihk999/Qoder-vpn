'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'server', 'index.js');

/**
 * 沙箱：数据目录、APPDATA、HOME、安装候选全部指向空的临时目录。
 * 少了这一层，子进程会去连本机真实管道，测试结论随用户此刻开没开 Clash Verge 而变。
 */
function sandboxEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvp-index-'));
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
