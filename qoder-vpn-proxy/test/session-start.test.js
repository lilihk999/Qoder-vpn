'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'server', 'session-start.js');

/** 沙箱里造一个"装了 CVR 且 runtime 端口写在 config.yaml"的配置目录 */
function sandbox({ mixedPort }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvp-hook-'));
  const configDir = path.join(root, 'clash-verge');
  const installDir = path.join(root, 'program');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), `mixed-port: ${mixedPort}\nmode: rule\nsecret: set-your-secret\n`);
  fs.writeFileSync(path.join(configDir, 'verge.yaml'), `enable_system_proxy: false\nenable_tun_mode: false\nenable_external_controller: false\n`);
  fs.writeFileSync(path.join(configDir, 'profiles.yaml'), `# 空清单\n`);
  fs.writeFileSync(path.join(installDir, 'clash-verge.exe'), '');
  return {
    root,
    env: {
      ...process.env,
      APPDATA: root,
      appdata: root,
      HOME: path.join(root, 'Home'),
      USERPROFILE: path.join(root, 'Home'),
      QVP_CONFIG_DIR: configDir,
      QVP_INSTALL_CANDIDATES: installDir,
    },
  };
}

function runHook(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end('{}');
  });
}

/** 占住一个真实端口，返回端口号；stop() 释放 */
async function occupy() {
  const server = net.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  return { port, stop: () => new Promise((res) => server.close(res)) };
}

test('hook 契约：stdout 永远是单个带 hookEventName 的 JSON 对象，未安装时 additionalContext 为空串', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvp-hook-bare-'));
  const env = {
    ...process.env,
    APPDATA: root,
    appdata: root,
    HOME: path.join(root, 'Home'),
    USERPROFILE: path.join(root, 'Home'),
    QVP_INSTALL_CANDIDATES: path.join(root, 'no-such-dir'),
  };
  const { code, out } = await runHook(env);
  assert.equal(code, 0);
  const msg = JSON.parse(out);
  assert.equal(Object.keys(msg).join(), 'hookSpecificOutput');
  assert.equal(msg.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(msg.hookSpecificOutput.additionalContext, '', '验收 9：没装 CVR 时不注入任何文本');
});

test('端口可连通才提示，给出内联前缀与工具名而不是凭记忆写端口', async () => {
  const { port, stop } = await occupy();
  try {
    const { env } = sandbox({ mixedPort: port });
    const { out } = await runHook(env);
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.ok(ctx.length > 0, '端口在听，应该给出提示');
    assert.match(ctx, new RegExp(`127\\.0\\.0\\.1:${port}`), '端口来自探测结果');
    assert.match(ctx, /HTTP_PROXY=http:\/\/127\.0\.0\.1:/);
    assert.match(ctx, /mcp__vpn-proxy__proxy_diagnose/);
    assert.doesNotMatch(ctx, /7897/, '不能出现写死的默认端口');
  } finally {
    await stop();
  }
});

test('装了 CVR 但代理端口没在听时不提示（避免让用户照着前缀撞上拒绝）', async () => {
  const { port, stop } = await occupy();
  await stop();
  const { env } = sandbox({ mixedPort: port });
  const { out } = await runHook(env);
  assert.equal(JSON.parse(out).hookSpecificOutput.additionalContext, '');
});
