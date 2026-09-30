'use strict';
const https = require('node:https');
const http = require('node:http');
const { ApiError } = require('./envelope');
const { redactUrl, redactText } = require('./redact');

const CLASH_UA = 'clash-verge/v2.3.0';

function sniffFormat(body) {
  if (!body || !body.trim()) return 'unknown';
  const head = body.slice(0, 400).toLowerCase();
  if (/^\s*(proxy|<!doctype html|<html|<!doctype)/.test(head)) {
    return /<!doctype html|<html|<head/.test(head) ? 'html' : 'yaml';
  }
  if (/^(mixed-port|port|socks-port|proxies|proxy-groups|dns|rules|mode|allow-lan):/m.test(body.slice(0, 4000))) return 'yaml';
  if (/^\s*(ss|vmess|trojan|vless|hy2|hysteria2|tuic):\/\//m.test(body.slice(0, 4000))) return 'base64';
  const oneLine = body.trim().replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(oneLine) && oneLine.length > 40) {
    try {
      const decoded = Buffer.from(oneLine, 'base64').toString('utf8');
      if (/(ss|vmess|trojan|vless):\/\//.test(decoded)) return 'base64';
    } catch { /* 落到 unknown */ }
  }
  if (/<\s*(html|!doctype)/i.test(body.slice(0, 2000))) return 'html';
  return 'unknown';
}

function parseUserInfo(header) {
  if (!header) return null;
  const num = (k) => {
    const m = new RegExp(`${k}\\s*=\\s*(\\d+)`, 'i').exec(header);
    return m ? Number(m[1]) : null;
  };
  const out = { upload: num('upload'), download: num('download'), total: num('total'), expire: num('expire') };
  return out.total === null && out.download === null ? null : out;
}

function parseSubscriptionName(contentDisposition) {
  if (!contentDisposition) return null;
  const star = /filename\*\s*=\s*([^;']*)'([^']*)'([^;]+)/i.exec(contentDisposition);
  if (star) { try { return decodeURIComponent(star[3].trim()); } catch { return star[3].trim(); } }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition);
  if (plain) { try { return decodeURIComponent(plain[1].trim()); } catch { return plain[1].trim(); } }
  return null;
}

function decodeBody(body, format) {
  if (format === 'yaml') {
    const m = /\nproxies:\s*\n([\s\S]*?)(?=\n[a-zA-Z_-]+:|\nproxy-groups:|$)/.exec(body);
    // 机场两种写法都有：`- name: x` 块式与 `- { name: x, ... }` 流式
    const nodes = m ? (m[1].match(/^\s*-\s*(?:\{\s*)?name:/gm) || []).length : 0;
    return { yaml: body, nodes };
  }
  if (format === 'base64') {
    const decoded = Buffer.from(body.trim().replace(/\s+/g, ''), 'base64').toString('utf8');
    const nodes = decoded.split(/[,\n]/).map((s) => s.trim()).filter((s) => /:\/\//.test(s)).length;
    if (!nodes) throw new ApiError('subscription_format_unexpected', 'base64 解码后没有可用节点', '订阅可能已过期或链接被重置');
    return { yaml: null, nodes };
  }
  throw new ApiError(
    'subscription_format_unexpected',
    redactText(`订阅返回格式为 ${format}，不是 Clash 配置`),
    '该机场按 User-Agent 分流：必须用 Clash 家族 UA 才返回完整 YAML；也可能链接已失效'
  );
}

function countNodes(parsed) { return parsed.nodes; }

function fetchSubscription(url, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return reject(new ApiError('subscription_url_invalid', `URL 无法解析: ${redactUrl(String(url))}`, '需要完整的 http(s) 订阅链接')); }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return reject(new ApiError('subscription_url_invalid', '只支持 http(s) 订阅链接', ''));
    }
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const req = mod.request(parsedUrl, {
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'User-Agent': CLASH_UA, Accept: '*/*' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchSubscription(new URL(res.headers.location, parsedUrl).href, { timeoutMs }).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new ApiError('subscription_format_unexpected',
            `HTTP ${res.statusCode}`, `订阅站返回非 200；${redactUrl(url)}`));
        }
        const format = sniffFormat(body);
        const decoded = decodeBody(body, format);
        resolve({
          format,
          userInfo: parseUserInfo(res.headers['subscription-userinfo']),
          name: parseSubscriptionName(res.headers['content-disposition']),
          yaml: decoded.yaml,
          nodes: decoded.nodes,
          bytes: Buffer.byteLength(body),
        });
      });
    });
    req.on('timeout', () => req.destroy(new ApiError('timeout', '抓取订阅超时', '订阅站可能被墙，需先开代理再更新')));
    req.on('error', (e) => reject(new ApiError('timeout', `抓取订阅失败: ${e.code || e.message}`, '确认该域名能否直连')));
    req.end();
  });
}

module.exports = { CLASH_UA, sniffFormat, parseUserInfo, parseSubscriptionName, decodeBody, countNodes, fetchSubscription };
