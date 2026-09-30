'use strict';

const { redactText } = require('./redact');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'qoder-vpn-proxy', version: '0.1.0' };

const INSTRUCTIONS = [
  '本插件复用本机 Clash Verge Rev / mihomo 作为代理内核，只做识别、控制与诊断，不自己转发流量。',
  '常用顺序：proxy_status 看现状 -> proxy_core_start 启动（默认 scope=session，不动系统代理）-> proxy_nodes/proxy_test/proxy_select 选节点 -> proxy_diagnose 验证直连与经代理差异。',
  '要让本会话的 npm/git 实际走代理用 proxy_toolconfig(action=apply)；只想单次命令用 proxy_env 拿前缀。',
  '订阅可自主维护：proxy_subscriptions 列清单，add/edit/update/activate/remove 管理，edit 用于机场换地址或轮换 token。',
  '代理端口一律来自返回值，不要凭记忆写 7897。',
  '订阅地址是凭据：工具输出与日志里主机名、路径段、token 全部掩掉，只剩结构与 urlFingerprint；原始链接只在插件内部用于抓取与写 profiles.yaml。',
].join(' ');

function framer() {
  let buf = '';
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const out = [];
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* 坏帧丢弃，继续服务 */ }
      }
      return out;
    },
  };
}

const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleMessage(msg, { tools, callTool, log = () => {} }) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    case 'ping':
      return isNotification ? null : { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
    case 'tools/call': {
      const name = params && params.name;
      if (!tools.some((t) => t.name === name)) return err(id, -32602, `未知工具: ${String(name)}`);
      let envelope;
      try {
        envelope = await callTool(name, (params && params.arguments) || {});
      } catch (e) {
        // 异常栈里可能带着调用方传进来的订阅链接，而这条 log 是落盘到 mcp.log 的
        log(redactText(`tools/call ${name} 内部异常: ${e && e.stack ? e.stack : e}`));
        return err(id, -32603, '工具执行内部异常，详情见插件日志');
      }
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], isError: !envelope.ok },
      };
    }
    default:
      if (String(method || '').startsWith('notifications/')) return null;
      return isNotification ? null : err(id, -32601, `方法不支持: ${String(method)}`);
  }
}

module.exports = { PROTOCOL_VERSION, SERVER_INFO, INSTRUCTIONS, framer, handleMessage };
