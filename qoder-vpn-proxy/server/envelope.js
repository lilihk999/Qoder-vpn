'use strict';

const ENVELOPE_KINDS = [
  'not_installed', 'core_not_running', 'channel_unavailable', 'auth_failed', 'timeout',
  'subscription_format_unexpected', 'subscription_url_invalid', 'subscription_duplicate',
  'subscription_not_found', 'subscription_active_protected', 'profile_registry_desync',
  'config_write_failed', 'malformed_config',
];

class ApiError extends Error {
  constructor(kind, message, hint) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.hint = hint || '';
  }
}

const ok = (data) => ({ ok: true, data });
const fail = (kind, message, hint) => ({ ok: false, kind, message, hint: hint || '' });

function toEnvelope(err) {
  if (err instanceof ApiError) return fail(err.kind, err.message, err.hint);
  if (err && (err.code === 'ETIMEDOUT' || /timeout/i.test(String(err.message)))) {
    return fail('timeout', String(err.message || err), '控制器或节点响应超时，可缩短 timeout 或换节点');
  }
  return fail('channel_unavailable', String((err && err.message) || err), '未预期的错误，详见插件日志');
}

module.exports = { ok, fail, ApiError, ENVELOPE_KINDS, toEnvelope };
