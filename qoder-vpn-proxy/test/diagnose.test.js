'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/diagnose');

const PX = 'http://127.0.0.1:7897';

test('curlArgs 直连轮必须显式 --noproxy *，否则结果不可信', () => {
  const direct = D.curlArgs({ url: 'https://github.com', proxy: null, timeoutMs: 8000 });
  assert.ok(direct.includes('--noproxy'), JSON.stringify(direct));
  assert.equal(direct[direct.indexOf('--noproxy') + 1], '*');
  assert.ok(!direct.includes('--proxy'));
  assert.ok(direct.includes('--connect-timeout'), '必须有 connect-timeout，否则死主机要等到 max-time 才失败');
});

test('curlArgs 经代理轮用 --proxy 而不是环境变量', () => {
  const via = D.curlArgs({ url: 'https://github.com', proxy: PX, timeoutMs: 8000 });
  assert.equal(via[via.indexOf('--proxy') + 1], PX);
  assert.ok(!via.includes('--noproxy'));
  assert.match(via.join(' '), /--max-time 8/);
  assert.ok(via.includes('-o'), '丢弃响应体');
  assert.ok(via.includes('-sS'));
});

test('parseCurlOut 解 4 元组', () => {
  assert.deepEqual(
    D.parseCurlOut('200 0.081 1.234 20.205.243.166'),
    { status: 200, connectMs: 81, totalMs: 1234, remoteIp: '20.205.243.166' }
  );
  assert.deepEqual(D.parseCurlOut('000 0.000 8.001 0.0.0.0'), { status: 0, connectMs: 0, totalMs: 8001, remoteIp: '0.0.0.0' });
  assert.equal(D.parseCurlOut('乱码').status, null);
});

test('parseCurlOut 保住失败时的耗时：真机 curl 在连接失败时不输出 remote_ip', () => {
  // 真机 curl 8.17.0 失败时 -w 打的是 "000 0.000000 4.004966 "（第 4 字段为空）
  assert.deepEqual(D.parseCurlOut('000 0.000000 4.004966 '), { status: 0, connectMs: 0, totalMs: 4005, remoteIp: null });
  assert.deepEqual(D.parseCurlOut('000 0.000000 8.001000'), { status: 0, connectMs: 0, totalMs: 8001, remoteIp: null });
});

test('summarize：失败行也带耗时，结论能说清是超时还是拒连', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [{ label: 'GitHub', url: 'https://github.com', expectDirect: false }],
    curlRunner: runner({
      'direct:https://github.com': { code: 28, out: '000 0.000000 8.001000', err: 'curl: (28) Connection timed out' },
      'proxy:https://github.com': { code: 0, out: '200 0.081 1.234 20.205.243.166' },
    }),
  });
  const r = rows.rows[0];
  assert.equal(r.direct.ok, false);
  assert.equal(r.direct.totalMs, 8001, '直连超时的 8 秒必须留在证据里');
  assert.equal(r.direct.remoteIp, null);
  assert.match(r.conclusion, /需要代理/);
});

const runner = (table) => async (args) => {
  const url = args[args.length - 1];
  const proxied = args.includes('--proxy');
  const hit = table[`${proxied ? 'proxy' : 'direct'}:${url}`];
  if (!hit) return { code: 7, stdout: '000 0.000000 8.001000', stderr: `curl: (7) failed for ${url}` };
  return { code: hit.code ?? 0, stdout: hit.out, stderr: hit.err || '' };
};

test('summarize：github 直连超时、经代理 200 -> 判定需要代理', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [
      { label: 'GitHub', url: 'https://github.com', expectDirect: false },
      { label: 'Qoder', url: 'https://qoder.com', expectDirect: true },
    ],
    curlRunner: runner({
      'direct:https://github.com': { code: 28, out: '000 0.000000 8.001000', err: 'Connection timed out' },
      'proxy:https://github.com': { out: '200 0.090 0.880 20.205.243.166' },
      'direct:https://qoder.com': { out: '200 0.300 0.520 1.2.3.4' },
      'proxy:https://qoder.com': { out: '200 1.800 3.720 5.6.7.8' },
    }),
    timeoutMs: 8000,
  });
  const gh = rows.rows.find((r) => r.label === 'GitHub');
  assert.equal(gh.direct.ok, false);
  assert.equal(gh.proxied.ok, true);
  assert.match(gh.conclusion, /需要代理/);
  assert.ok(rows.advice.some((a) => /--proxy|proxy_toolconfig|HTTP_PROXY/.test(a)));

  const qd = rows.rows.find((r) => r.label === 'Qoder');
  assert.equal(qd.direct.ok, true);
  assert.match(qd.conclusion, /直连更快/, 'Qoder 自己不该走代理');
  assert.ok(rows.advice.some((a) => /不要设置全局 HTTPS_PROXY|Qoder 直连/.test(a)));
});

test('summarize：代理也不通 -> 指向 proxy_test / core_start', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [{ label: 'GitHub', url: 'https://github.com', expectDirect: false }],
    curlRunner: runner({
      'direct:https://github.com': { code: 28, out: '000 0.000000 8.001000' },
      'proxy:https://github.com': { code: 7, out: '000 0.000000 8.001000', err: 'Connection refused' },
    }),
    timeoutMs: 8000,
  });
  assert.match(rows.verdict, /代理本身不通/);
  assert.ok(rows.advice.some((a) => /proxy_test|proxy_core_start/.test(a)));
});

test('代理端口未监听时跳过经代理轮，不产生误导性的"代理不通"', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    portAlive: false,
    targets: [{ label: 'GitHub', url: 'https://github.com', expectDirect: false }],
    curlRunner: runner({ 'direct:https://github.com': { code: 28, out: '000 0.000000 8.001000' } }),
    timeoutMs: 8000,
  });
  assert.equal(rows.rows[0].proxied, 'skipped');
  assert.match(rows.verdict, /代理未运行/);
});

test('订阅形状的目标整条脱敏：域名与路径段也不能出现在探测结果里', async () => {
  // proxy_diagnose 的 targets 是用户自己传的，把订阅链接贴进来完全合理；
  // 这一面若只红 token，就等于给用户一条"把凭据原样打印回来"的通道。
  const U = 'https://sub.example.test/Quir7aMockQwsxNcgv1234?token=SECRET123';
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [{ label: '订阅站', url: U, expectDirect: true }],
    curlRunner: runner({ [`direct:${U}`]: { out: '200 0.2 2.1 1.1.1.1' }, [`proxy:${U}`]: { out: '200 0.2 2.1 1.1.1.1' } }),
    timeoutMs: 8000,
  });
  const dump = JSON.stringify(rows);
  assert.doesNotMatch(dump, /SECRET123/);
  assert.doesNotMatch(dump, /sub\.example\.test/);
  assert.doesNotMatch(dump, /Quir7aMockQwsxNcgv1234/);
  assert.equal(rows.rows[0].url, 'https://<masked-host>/<masked-path>?<masked-query>');
});

test('公共目标在探测结果里保持原样：全量脱敏只针对订阅形状', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [{ label: 'PyPI', url: 'https://pypi.org/simple/requests/', expectDirect: true }],
    curlRunner: runner({
      'direct:https://pypi.org/simple/requests/': { out: '200 0.2 2.1 1.1.1.1' },
      'proxy:https://pypi.org/simple/requests/': { out: '200 0.2 2.1 1.1.1.1' },
    }),
    timeoutMs: 8000,
  });
  assert.equal(rows.rows[0].url, 'https://pypi.org/simple/requests/', '把公共探测地址也掩掉会让这张表没法读');
});

test('curl 不在 PATH 时报"无法执行"而不是假装超时', async () => {
  const r = await D.probe({
    url: 'https://github.com', proxy: null, timeoutMs: 8000,
    curlRunner: async () => { const e = new Error('spawn curl ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.error, /curl 无法执行/);
});

test('DEFAULT_TARGETS 只列公开站点，不做附带外发', () => {
  // 白名单比"排除订阅域名"更硬：任何一次把订阅地址塞进探测目标的改动都会被这里拦住，
  // 而负向 grep 只认识写死的那一个域名。
  const ALLOW = /^(?:github\.com|raw\.githubusercontent\.com|registry\.npmjs\.org|pypi\.org|qoder\.com)$/;
  for (const t of D.DEFAULT_TARGETS) {
    assert.match(t.url, /^https:\/\//, t.url);
    assert.doesNotMatch(t.url, /[?&]token=/, t.url);
    assert.ok(ALLOW.test(new URL(t.url).hostname), t.url);
  }
  assert.ok(D.DEFAULT_TARGETS.some((t) => /github\.com/.test(t.url)));
  assert.equal(D.DEFAULT_TARGETS.length, 5);
});

test('probe：HTTP 200 但 curl exit 28 是"通但被 max-time 截断"，不是通道故障', async () => {
  // 真机现象：--max-time 到点时 curl 退 28，而 -w 里的 %{http_code} 已经是 200 ——
  // 连接、TLS、请求、响应头全部成功，只是响应体没收完。
  const r = await D.probe({
    url: 'https://github.com', proxy: PX, timeoutMs: 8000,
    curlRunner: async () => ({
      code: 28,
      stdout: '200 0.090 8.001 20.205.243.166',
      stderr: 'curl: (28) Operation timed out after 8001 milliseconds',
    }),
  });
  assert.equal(r.ok, true, '拿到 2xx 就已经回答了"能不能通"');
  assert.equal(r.truncated, true);
  assert.equal(r.status, 200);
  assert.equal(r.totalMs, 8001);
  assert.equal(r.error, null, 'ok 的行不该再挂着一条看起来像失败的 error');
});

test('probe：连接阶段就超时（000 + exit 28）仍然算失败', async () => {
  const r = await D.probe({
    url: 'https://github.com', proxy: null, timeoutMs: 8000,
    curlRunner: async () => ({ code: 28, stdout: '000 0.000000 8.001000', stderr: 'curl: (28) Connection timed out' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.truncated, false, '没有响应就没有"截断"可言，别把死主机洗成慢');
  assert.match(r.error, /curl exit 28/);
});

test('probe：4xx/5xx + exit 0 仍是失败，截断不能把状态码洗白', async () => {
  const r = await D.probe({
    url: 'https://github.com', proxy: PX, timeoutMs: 8000,
    curlRunner: async () => ({ code: 0, stdout: '403 0.090 1.200 20.205.243.166', stderr: '' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.truncated, false);
  assert.match(r.error, /HTTP 403/);
});

test('rowConclusion：经代理 200 但截断 -> 判"需要代理"并说明截断，不说代理不通', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [{ label: 'GitHub', url: 'https://github.com', expectDirect: false }],
    curlRunner: runner({
      'direct:https://github.com': { code: 28, out: '000 0.000000 8.001000' },
      'proxy:https://github.com': { code: 28, out: '200 0.090 8.001 20.205.243.166' },
    }),
    timeoutMs: 8000,
  });
  const r = rows.rows[0];
  assert.equal(r.proxied.ok, true);
  assert.match(r.conclusion, /需要代理/);
  assert.match(r.conclusion, /截断/, '结论要如实说明响应体没收完');
  assert.doesNotMatch(rows.verdict, /代理本身不通/);
});

test('summarize：有截断行时 advice 教的是调大 timeoutMs 而不是换节点', async () => {
  const rows = await D.runDiagnose({
    proxyUrl: PX,
    targets: [{ label: 'GitHub', url: 'https://github.com', expectDirect: false }],
    curlRunner: runner({
      'direct:https://github.com': { code: 28, out: '000 0.000000 8.001000' },
      'proxy:https://github.com': { code: 28, out: '200 0.090 8.001 20.205.243.166' },
    }),
    timeoutMs: 8000,
  });
  assert.ok(rows.advice.some((a) => /timeoutMs/.test(a) && /截断|未收完/.test(a)), JSON.stringify(rows.advice));
  assert.ok(rows.truncatedCount >= 1);
});
