'use strict';
const { ApiError } = require('./envelope');
const { redactText } = require('./redact');
const { createTransport } = require('./transport');

const DEFAULT_DELAY_URL = 'https://www.gstatic.com/generate_204';
const BUILT_IN = new Set(['DIRECT', 'REJECT', 'PASS']);
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'LoadBalance', 'Fallback']);

function qs(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}`;
}

class ClashClient {
  constructor(transport) {
    this.transport = transport;
  }

  static async connect(runtime, opts) {
    return new ClashClient(await createTransport(runtime, opts));
  }

  get channelKind() { return this.transport.kind; }

  /** 401 -> auth_failed；404 -> malformed_config（名字/路径不对）；503/504 -> timeout；其余非 2xx 才算通道故障 */
  async request(method, path, { body, timeoutMs, expectEmpty = false } = {}) {
    const res = await this.transport.request(method, path, { body, timeoutMs });
    if (res.status === 401) {
      throw new ApiError('auth_failed', `${method} ${path} 返回 401`, '控制器密钥不匹配，请在 Clash Verge 设置中确认外部控制的密钥');
    }
    const good = res.status >= 200 && res.status < 300;
    if (good) {
      if (expectEmpty || !res.text) return {};
      try { return JSON.parse(res.text); }
      catch { throw new ApiError('malformed_config', `${method} ${path} 返回的不是合法 JSON`, redactText(res.text.slice(0, 160))); }
    }
    const detail = redactText((res.text || '').slice(0, 200));
    // 404 是控制器答了但这个名字/路径没有对应资源 —— 入参问题，不是通道问题。
    // 归 channel_unavailable 会让调用方按"先 proxy_core_start"去重启核心（真机 2026-10-01 踩过）。
    const kind = res.status === 503 || res.status === 504
      ? 'timeout'
      : res.status === 404 ? 'malformed_config' : 'channel_unavailable';
    throw new ApiError(
      kind,
      `${method} ${path} -> HTTP ${res.status} ${detail}`,
      res.status === 404
        ? '组名 / 节点名 / uid 可能拼错，先用 proxy_nodes 或 proxy_subscriptions 核对；若这个路径本身是核心没有的端点（如 v1.19.25 的 POST /configs/reload），404 说的是版本不支持，不是名字错了'
        : ''
    );
  }

  async version() {
    const j = await this.request('GET', '/version');
    return { version: j.version || (j.meta && j.meta.version) || null, revision: j.revision || null };
  }

  async getConfigs() {
    const j = await this.request('GET', '/configs');
    return {
      mode: j.mode ?? null,
      mixedPort: j['mixed-port'] ?? null,
      socksPort: j['socks-port'] ?? null,
      port: j.port ?? null,
      tunEnabled: Boolean(j.tun && j.tun.enable),
      externalController: j['external-controller'] || '',
    };
  }

  async setConfigs(patch) {
    const body = {};
    if (patch.mode !== undefined) body.mode = patch.mode;
    if (patch.tun !== undefined) body.tun = { enable: Boolean(patch.tun) };
    if (patch.port !== undefined) body.port = patch.port;
    if (patch.mixedPort !== undefined) body['mixed-port'] = patch.mixedPort;
    if (patch.proxies !== undefined) body.proxies = patch.proxies;
    if (patch['external-controller'] !== undefined) body['external-controller'] = patch['external-controller'];
    // 真机 v1.19.25：PUT /configs 也回 204，但只有 PATCH 会真的改 mode/tun。
    await this.request('PATCH', '/configs', { body, expectEmpty: true });
    return body;
  }

  async getProxies() {
    const j = await this.request('GET', '/proxies');
    const all = j.proxies || {};
    const groups = Object.values(all)
      .filter((p) => p && GROUP_TYPES.has(p.type))
      .map((p) => ({ name: p.name, type: p.type, now: p.now ?? null, all: p.all || [], history: p.history || [] }));
    const groupNames = new Set(groups.map((g) => g.name));
    const seen = new Set();
    const nodes = [];
    for (const g of groups) {
      for (const n of g.all) {
        if (BUILT_IN.has(n) || groupNames.has(n) || seen.has(n)) continue;
        seen.add(n);
        nodes.push(n);
      }
    }
    return { groups, nodes };
  }

  async getProxy(name) {
    const j = await this.request('GET', `/proxies/${encodeURIComponent(name)}`);
    return {
      name: j.name ?? name, type: j.type ?? null, now: j.now ?? null, all: j.all || [],
      udp: Boolean(j.udp), xudp: Boolean(j.xudp), history: j.history || [],
    };
  }

  async select(group, target) {
    await this.request('PUT', `/proxies/${encodeURIComponent(group)}`, { body: { name: target }, expectEmpty: true });
    const after = await this.getProxy(group);
    if (after.now !== target) {
      throw new ApiError('channel_unavailable', `切换 ${group} -> ${target} 之后回读为 ${after.now}`, 'mihomo 可能拒绝了该目标（节点不在组内或正在重建连接）');
    }
    return { group, now: after.now };
  }

  /** 测速失败是节点问题不是通道问题，一律归 timeout，让 proxy_test 能把坏节点标出来 */
  async delay(name, { url = DEFAULT_DELAY_URL, timeoutMs = 5000 } = {}) {
    const path = `/proxies/${encodeURIComponent(name)}/delay${qs({ url, timeout: timeoutMs })}`;
    const res = await this.transport.request('GET', path, { timeoutMs: timeoutMs + 2000 });
    if (res.status === 401) throw new ApiError('auth_failed', `测速 ${name} 返回 401`, '检查 secret');
    if (res.status !== 200) {
      throw new ApiError('timeout', redactText(`测速 ${name} 失败: HTTP ${res.status} ${(res.text || '').slice(0, 120)}`), '该节点不可达或超时，可跳过它换下一个');
    }
    let j;
    try { j = JSON.parse(res.text || '{}'); } catch { throw new ApiError('timeout', `测速 ${name} 返回不可解析内容`, ''); }
    return Number(j.delay);
  }

  async closeConnections() {
    await this.request('DELETE', '/connections', { expectEmpty: true });
    return { closed: true };
  }

  async reload({ proxyProviders = false } = {}) {
    await this.request('POST', `/configs/reload${qs({ 'proxy-providers': proxyProviders ? 'true' : '' })}`, { expectEmpty: true });
    return { reloaded: true };
  }

  async connections() {
    const j = await this.request('GET', '/connections');
    const list = j.connections || [];
    return {
      total: j.total ?? list.length,
      uplink: j.uplink ?? null,
      downlink: j.downlink ?? null,
      connections: list.map((c) => ({
        id: c.id,
        host: (c.metadata && (c.metadata.host || c.metadata.destinationIP)) || '',
        chains: c.chains || [],
        upload: c.upload,
        download: c.download,
      })),
    };
  }

  close() { this.transport.close(); }
}

module.exports = { ClashClient, DEFAULT_DELAY_URL, BUILT_IN: [...BUILT_IN], GROUP_TYPES: [...GROUP_TYPES] };
