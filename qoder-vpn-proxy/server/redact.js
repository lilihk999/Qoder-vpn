'use strict';

const crypto = require('node:crypto');

const NODE_SCHEME = /\b(?:ss|vmess|trojan|vless|hysteria2|hy2|tuic|wireguard):\/\/\S+/g;
const SENSITIVE_KV = /^(\s*)(server|server_port|port|password|passwd|uuid|sni|client-fingerprint|public-key|private-key)(\s*[:=]\s*)(\S+)(\s*(?:#.*)?)$/gim;
const ANY_URL = /\bhttps?:\/\/[^\s"'<>\\]+/gi;
const TOKEN_KV = /([?&]token=)[^&#\s"']*/gi;

const MASK_HOST = '<masked-host>';
const MASK_PATH = '<masked-path>';
const MASK_QUERY = '<masked-query>';
const MASK_URL = '<masked-url>';

/**
 * 订阅链接的"形状判据"——与本机凭据审计同源，不看白名单：
 * 带 token= 查询参数，或路径首段是 16–24 位纯字母数字（机场换链接前的老式路径）。
 * 公共探测地址都不满足：pypi.org/simple/、www.gstatic.com/generate_204（12 位含下划线）、
 * raw.githubusercontent.com/a/b/main/x.js（首段 1 位）、cp.cloudflare.com/（无路径段）。
 */
function isSubscriptionShape(u) {
  if (/[?&]token=/i.test(u.search || '')) return true;
  const first = u.pathname.split('/').filter(Boolean)[0] || '';
  return /^[A-Za-z0-9]{16,24}$/.test(first);
}

function parseUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try { return new URL(url.trim()); } catch { return null; }
}

/**
 * 订阅 URL 的展示形态：只保留结构与指纹，主机名、路径段、query 一律不出边界。
 * token 只是凭据的一部分——机场域名与路径段本身同样能定位到"用的是哪家、哪条链接"，
 * 而且它可以被 CVR 直接复用发起请求。解析不了的输入整条替换，绝不回显原文。
 */
function maskSubscriptionUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  const u = parseUrl(url);
  if (!u) return MASK_URL;
  const protocol = /:$/i.test(u.protocol) ? u.protocol.slice(0, -1) : u.protocol;
  let out = `${protocol}://${MASK_HOST}`;
  if (u.pathname.split('/').filter(Boolean).length > 0) out += `/${MASK_PATH}`;
  if (u.search && u.search !== '?') out += `?${MASK_QUERY}`;
  return out;
}

/**
 * 同一条链接的稳定身份：sha256(host + pathname) 前 10 位。
 * token 不参与——用户拿指纹对的是"是不是同一家、同一条链接"，换 token 前后应当一致。
 */
function urlFingerprint(url) {
  const u = parseUrl(url);
  if (!u) return null;
  return crypto.createHash('sha256').update(`${u.host}/${u.pathname}`).digest('hex').slice(0, 10);
}

/**
 * 从任意文本里顶掉这条订阅的主机名/路径段。
 * Node 的网络错误消息（`getaddrinfo ENOTFOUND xxx`、TLS SNI 失败）会把裸主机名带进来，
 * 那不是 URL 形状，红掉整条 URL 的正则管不到，只能拿已知订阅地址逐词替换。
 */
function maskHosts(text, url) {
  const u = parseUrl(url);
  const out = text === undefined || text === null ? '' : String(text);
  if (!u) return out.replace(TOKEN_KV, '$1<redacted>');
  const parts = [];
  if (u.port) parts.push([u.host, MASK_HOST]);
  if (u.hostname) parts.push([u.hostname, MASK_HOST]);
  const firstSegment = u.pathname.split('/').filter(Boolean)[0] || '';
  if (firstSegment.length >= 6) parts.push([firstSegment, MASK_PATH]);
  let scrubbed = out;
  for (const [needle, mask] of parts.sort((a, b) => b[0].length - a[0].length)) {
    scrubbed = scrubbed.split(needle).join(mask);
  }
  return scrubbed.replace(TOKEN_KV, '$1<redacted>');
}

function redactUrl(url) {
  if (typeof url !== 'string') return '';
  return url.replace(TOKEN_KV, '$1<redacted>');
}

function redactText(value) {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s
    .replace(NODE_SCHEME, '<node-url-redacted>')
    .replace(SENSITIVE_KV, '$1$2$3<redacted>$5')
    .replace(ANY_URL, (m) => {
      const u = parseUrl(m);
      return u && isSubscriptionShape(u) ? maskSubscriptionUrl(m) : m;
    })
    .replace(TOKEN_KV, '$1<redacted>');
}

module.exports = { redactUrl, redactText, maskSubscriptionUrl, maskHosts, urlFingerprint };
