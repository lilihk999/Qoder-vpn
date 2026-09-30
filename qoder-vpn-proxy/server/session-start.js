'use strict';
const { discover, probeTcp } = require('./discovery');
const { buildProxyEnv, inlinePrefix } = require('./env');

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: additionalContext || '' },
  }));
}

async function main() {
  try {
    const rt = await discover();
    if (!rt.installed || !rt.ports.mixed) return emit('');
    const alive = await probeTcp({ host: '127.0.0.1', port: rt.ports.mixed, timeoutMs: 600 });
    if (!alive) return emit('');
    const env = buildProxyEnv({ mixedPort: rt.ports.mixed, socksPort: rt.ports.socks || undefined });
    const ctx = [
      `本机 Clash Verge 代理端口 127.0.0.1:${rt.ports.mixed} 当前可连通（插件 qoder-vpn-proxy 检测）。`,
      `直连失败时，联网命令请加前缀：${inlinePrefix(env)}`,
      `npm/git 想长期走代理用 mcp__vpn-proxy__proxy_toolconfig(action=apply)；哪些域名真需要代理用 mcp__vpn-proxy__proxy_diagnose 判定。`,
      `注意：系统代理未开启，本提示只影响命令行工具；Qoder 自身请求建议保持直连。`,
    ].join(' ');
    return emit(ctx);
  } catch {
    return emit('');
  }
}

main();
