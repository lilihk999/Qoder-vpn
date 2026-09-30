'use strict';

const NODE_SCHEME = /\b(?:ss|vmess|trojan|vless|hysteria2|hy2|tuic|wireguard):\/\/\S+/g;
const SENSITIVE_KV = /^(\s*)(server|server_port|port|password|passwd|uuid|sni|client-fingerprint|public-key|private-key)(\s*[:=]\s*)(\S+)(\s*(?:#.*)?)$/gim;

function redactUrl(url) {
  if (typeof url !== 'string') return '';
  return url.replace(/([?&]token=)[^&#]*/gi, '$1<redacted>');
}

function redactText(value) {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s
    .replace(NODE_SCHEME, '<node-url-redacted>')
    .replace(SENSITIVE_KV, '$1$2$3<redacted>$5')
    .replace(/([?&]token=)[^&#\s"']*/gi, '$1<redacted>');
}

module.exports = { redactUrl, redactText };
