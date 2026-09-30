'use strict';
const http = require('node:http');
const net = require('node:net');

const PROXIES = {
  节点选择: { now: 'TW 2 | v4', all: ['TW 2 | v4', 'HK 3 | v4', 'JP 1 | v3', 'dead-node'], history: {} },
  漏网之鱼: { now: '节点选择', all: ['节点选择', 'DIRECT'], history: {} },
};

function renderProxies(state) {
  const out = { DIRECT: { name: 'DIRECT', type: 'Direct', now: 'DIRECT' }, REJECT: { name: 'REJECT', type: 'Reject', now: 'REJECT' } };
  for (const [g, v] of Object.entries(state.proxies)) out[g] = { name: g, type: 'Selector', now: v.now, all: v.all, history: v.history };
  for (const n of state.proxies['节点选择'].all) out[n] = { name: n, type: 'SS', udp: true };
  return out;
}

function makeHandlers(state) {
  return function handle(method, url, headers, body) {
    const p = decodeURIComponent(url.split('?')[0]);
    if (headers.authorization !== `Bearer ${state.secret}`) return { status: 401, json: { message: 'unauthorized' } };
    if (p === '/version') return { status: 200, json: { meta: { version: '1.19.0', meta: true } } };
    if (p === '/configs' && method === 'GET') {
      return {
        status: 200,
        json: {
          mode: state.mode,
          'mixed-port': state.mixedPort,
          tun: { enable: state.tunEnabled },
          'external-controller': state.tcpEnabled ? `127.0.0.1:${state.controllerPort}` : '',
        },
      };
    }
    if (p === '/configs' && method === 'PUT') {
      const patch = body ? JSON.parse(body) : {};
      if (patch.mode) state.mode = patch.mode;
      if (patch.tun) state.tunEnabled = !!patch.tun.enable;
      return { status: 204 };
    }
    if (p === '/proxies') return { status: 200, json: { proxies: renderProxies(state) } };
    if (/^\/proxies\/.+\/delay$/.test(p)) {
      const name = p.split('/')[2];
      if (name === 'dead-node') return { status: 503, json: { message: `Test ${name} error: context deadline exceeded` } };
      return { status: 200, json: { delay: 120 + name.length } };
    }
    if (/^\/proxies\//.test(p)) {
      const g = decodeURIComponent(p.split('/')[2]);
      const all = renderProxies(state);
      if (method === 'GET') return all[g] ? { status: 200, json: all[g] } : { status: 404, json: { message: 'proxy not found' } };
      if (method === 'PUT') {
        if (!state.proxies[g]) return { status: 404, json: { message: 'proxy group not found' } };
        const t = JSON.parse(body).target;
        if (!state.proxies[g].all.includes(t)) return { status: 503, json: { message: 'bad target' } };
        state.proxies[g].now = t;
        return { status: 204 };
      }
    }
    if (/^\/profiles\/[^/]+\/update$/.test(p) && method === 'POST') {
      return { status: 200, json: { name: p.split('/')[2], updated: true, proxies: renderProxies(state) } };
    }
    return { status: 404, json: { message: 'not found' } };
  };
}

async function startFake({ pipeName, port = 0, secret = 'set-your-secret', mixedPort = 7897, tcpEnabled = false } = {}) {
  const fullPipe = `\\\\.\\pipe\\${pipeName}`;
  const state = { secret, mode: 'rule', mixedPort, tunEnabled: false, tcpEnabled, controllerPort: port, proxies: JSON.parse(JSON.stringify(PROXIES)), hits: [] };
  const handler = makeHandlers(state);

  const dispatch = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits.push(`${req.method} ${req.url}`);
      const r = handler(req.method, req.url, req.headers, body);
      if (r.status === 204) { res.writeHead(204); return res.end(); }
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  };

  // port=0 时先占位探得一个空闲端口并立即释放，保证"TCP 默认关"时连接稳定得到 ECONNREFUSED
  let chosen = port;
  if (!chosen) {
    const probe = net.createServer();
    await new Promise((res) => probe.listen(0, '127.0.0.1', res));
    chosen = probe.address().port;
    await new Promise((res) => probe.close(res));
  }

  const servers = [];
  // 命名管道同样要跑 HTTP 语义：必须是 http.Server，net.Server 拿不到 req.url/res.writeHead
  const tcpSrv = http.createServer(dispatch);
  const pipeSrv = http.createServer(dispatch);
  if (tcpEnabled) await new Promise((res) => tcpSrv.listen(chosen, '127.0.0.1', res));
  await new Promise((res, rej) => { pipeSrv.once('error', rej); pipeSrv.listen(fullPipe, res); });
  servers.push(pipeSrv);

  return {
    pipeName: fullPipe,
    port: chosen,
    state,
    hits: state.hits,
    async setTcpEnabled(v) {
      state.tcpEnabled = v;
      if (v && !tcpSrv.listening) await new Promise((res) => tcpSrv.listen(chosen, '127.0.0.1', res));
      if (!v && tcpSrv.listening) await new Promise((res) => tcpSrv.close(res));
    },
    async close() {
      for (const s of servers) await new Promise((r) => s.close(r));
      if (tcpSrv.listening) await new Promise((r) => tcpSrv.close(r));
    },
  };
}

module.exports = { startFake };
