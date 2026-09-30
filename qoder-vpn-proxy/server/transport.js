'use strict';
const http = require('node:http');
const { ApiError } = require('./envelope');

const DEFAULT_TIMEOUT_MS = 8000;
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOENT', 'EADDRNOTAVAIL', 'EPIPE', 'ECONNRESET', 'ENOTFOUND', 'EPERM', 'EACCES',
]);

function parseTarget(target) {
  if (typeof target !== 'string') return null;
  const s = target.trim();
  const i = s.lastIndexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  const host = s.slice(0, i).replace(/^\[|\]$/g, '');
  const port = Number(s.slice(i + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

// Node 的 ClientRequest 拒绝 path 里的非 ASCII（ERR_UNESCAPED_CHARACTERS），而 mihomo 的
// 组名/节点名经常就是中文。已编码的 %XX 不在替换范围内，所以对同一字符串重复调用是安全的。
function encodePath(p) {
  return String(p).replace(/[^\x21-\x7E]+/g, encodeURIComponent);
}

function authHeaders(secret, extra = {}) {
  const h = { Host: 'localhost', Accept: 'application/json', ...extra };
  if (secret) h.Authorization = `Bearer ${secret}`;
  return h;
}

function send(connectOpts, method, path, { body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null
      ? undefined
      : typeof body === 'string' ? body : JSON.stringify(body);
    const finalHeaders = { ...connectOpts.headers, ...headers };
    if (payload !== undefined) {
      finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
      finalHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { ...connectOpts, method, path: encodePath(path), headers: finalHeaders, timeout: timeoutMs, agent: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new ApiError('timeout', `${method} ${path} 响应超过 ${timeoutMs}ms`, '控制器可能正在重启，或节点全部不可达')));
    req.on('error', (err) => {
      if (err instanceof ApiError) return reject(err);
      if (UNAVAILABLE_CODES.has(err.code)) return reject(new ApiError('channel_unavailable', `${method} ${path} 连接失败: ${err.code}`, ''));
      reject(err);
    });
    req.end(payload);
  });
}

class PipeTransport {
  constructor({ pipeName, secret = '', timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.kind = 'pipe';
    this.pipeName = pipeName;
    this.secret = secret;
    this.timeoutMs = timeoutMs;
  }
  request(method, path, opts = {}) {
    const { headers, ...rest } = opts;
    return send({ socketPath: this.pipeName, headers: authHeaders(this.secret, headers) }, method, path, {
      ...rest, timeoutMs: opts.timeoutMs || this.timeoutMs,
    });
  }
  close() {}
}

class TcpTransport {
  constructor({ host = '127.0.0.1', port, secret = '', timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.kind = 'tcp';
    this.host = host;
    this.port = port;
    this.secret = secret;
    this.timeoutMs = timeoutMs;
  }
  request(method, path, opts = {}) {
    const { headers, ...rest } = opts;
    return send({ host: this.host, port: this.port, headers: authHeaders(this.secret, headers) }, method, path, {
      ...rest, timeoutMs: opts.timeoutMs || this.timeoutMs,
    });
  }
  close() {}
}

const ORDER = ['pipe', 'tcp'];

async function createTransport(runtime, { timeoutMs = 3000 } = {}) {
  const controller = (runtime && runtime.controller) || {};
  const secret = (runtime && runtime.secret) || '';
  const attempts = [];
  let authDenied = false;

  for (const kind of ORDER) {
    let transport = null;
    let label = '';
    if (kind === 'pipe') {
      if (!controller.pipe) continue;
      label = `命名管道 ${controller.pipe}`;
      transport = new PipeTransport({ pipeName: controller.pipe, secret, timeoutMs });
    } else {
      const target = parseTarget(controller.tcp);
      if (!target) continue;
      label = `TCP ${controller.tcp}`;
      transport = new TcpTransport({ ...target, secret, timeoutMs });
    }
    try {
      const res = await transport.request('GET', '/version');
      if (res.status === 401) {
        authDenied = true;
        transport.close();
        attempts.push(`${label}: 401 密钥不符`);
        continue;
      }
      if (res.status >= 200 && res.status < 300) return transport;
      transport.close();
      attempts.push(`${label}: HTTP ${res.status}`);
    } catch (err) {
      transport.close();
      attempts.push(`${label}: ${err.kind === 'timeout' ? '握手超时' : err.message}`);
    }
  }

  if (authDenied) {
    throw new ApiError(
      'auth_failed',
      `控制通道可达但密钥不匹配（${attempts.join('；')}）`,
      '在 Clash Verge 的设置界面读取实际的外部控制密钥，或检查 config.yaml 的 secret 字段'
    );
  }
  throw new ApiError(
    'channel_unavailable',
    `mihomo 控制器不可达（${attempts.join('；') || '未发现任何通道'}）`,
    (runtime && runtime.channelHint) || '先 proxy_core_start 启动 Clash Verge；若仍不可用，需向用户确认后改调 proxy_core_start(enableExternalControl: true) 开启 enable_external_controller（会改动 verge.yaml，插件会先备份并可回滚）'
  );
}

module.exports = { DEFAULT_TIMEOUT_MS, parseTarget, PipeTransport, TcpTransport, createTransport };
