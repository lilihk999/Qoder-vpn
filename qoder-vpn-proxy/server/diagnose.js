'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { redactUrl, redactText } = require('./redact');

const execFileAsync = promisify(execFile);

const DEFAULT_TARGETS = [
  { label: 'GitHub 站点', url: 'https://github.com', expectDirect: false },
  { label: 'GitHub raw', url: 'https://raw.githubusercontent.com/sindresorhus/got/main/readme.md', expectDirect: false },
  { label: 'npm registry', url: 'https://registry.npmjs.org/react', expectDirect: true },
  { label: 'PyPI', url: 'https://pypi.org/simple/requests/', expectDirect: true },
  { label: 'Qoder', url: 'https://qoder.com', expectDirect: true },
];

const WRITE_OUT = '%{http_code} %{time_connect} %{time_total} %{remote_ip}';

function curlArgs({ url, proxy, timeoutMs = 8000 }) {
  const args = [
    '-sS', '-L', '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--connect-timeout', String(Math.max(2, Math.ceil(timeoutMs / 1000 / 2))),
    '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '-w', WRITE_OUT,
  ];
  // 直连轮必须屏蔽环境变量里的代理，否则"直连"结论不可信
  if (proxy) args.splice(args.indexOf('-w'), 0, '--proxy', proxy);
  else args.splice(args.indexOf('-w'), 0, '--noproxy', '*');
  args.push(url);
  return args;
}

function parseCurlOut(stdout) {
  // 连接失败时真机 curl 的 %{remote_ip} 是空串，第 4 段必须可选，否则整行解析失败、耗时一起丢掉
  const m = /^(\d{3})\s+([\d.]+)\s+([\d.]+)(?:\s+(\S+))?$/.exec(String(stdout || '').trim());
  if (!m) return { status: null, connectMs: null, totalMs: null, remoteIp: null };
  return {
    status: Number(m[1]) === 0 ? 0 : Number(m[1]),
    connectMs: Math.round(Number(m[2]) * 1000),
    totalMs: Math.round(Number(m[3]) * 1000),
    remoteIp: m[4] ?? null,
  };
}

async function probe({ url, proxy, curlRunner, timeoutMs }) {
  const args = curlArgs({ url, proxy, timeoutMs });
  let r;
  try { r = await curlRunner(args); }
  catch (e) { return { ok: false, ...parseCurlOut(''), error: redactText(`curl 无法执行: ${e.code || e.message}`) }; }
  const parsed = parseCurlOut(r.stdout);
  const ok = r.code === 0 && parsed.status >= 200 && parsed.status < 400;
  return {
    ok,
    ...parsed,
    error: ok ? null : redactText(parsed.status === null
      ? `curl exit ${r.code}: ${(r.stderr || '').slice(0, 140)}`
      : `HTTP ${parsed.status}${r.code ? ` (curl exit ${r.code})` : ''}`),
  };
}

function rowConclusion(row) {
  const { direct, proxied } = row;
  if (proxied === 'skipped') {
    if (!direct.ok) return row.expectDirect ? '直连失败且代理未运行' : '直连失败（该域名通常需要代理），但代理未运行';
    return '直连正常，代理未运行';
  }
  if (!direct.ok && proxied.ok) return '需要代理：直连不通，经代理正常';
  if (direct.ok && proxied.ok) {
    if (proxied.totalMs != null && direct.totalMs != null && proxied.totalMs > direct.totalMs * 1.5) {
      return `直连更快（${direct.totalMs}ms vs 经代理 ${proxied.totalMs}ms），此项不该走代理`;
    }
    return '两种路径都通';
  }
  if (direct.ok && !proxied.ok) return '经代理反而失败：该节点或规则可能有问题';
  return '直连与代理均失败';
}

function summarize(rows) {
  const advice = [];
  const needsProxy = rows.filter((r) => /需要代理/.test(r.conclusion));
  const allProxiedDead = rows.length > 0 && rows.every((r) => r.proxied !== 'skipped' && !r.proxied.ok);
  const skippedAll = rows.length > 0 && rows.every((r) => r.proxied === 'skipped');
  const fasterDirect = rows.filter((r) => /直连更快/.test(r.conclusion));

  let verdict;
  if (skippedAll) verdict = '代理未运行，只完成直连探测';
  else if (allProxiedDead) verdict = '代理本身不通';
  else if (needsProxy.length) verdict = `代理对 ${needsProxy.length} 项目前是必需的`;
  else verdict = '直连全部正常，代理可选';

  if (skippedAll) advice.push('先 proxy_core_start（scope 默认 session，不会影响其他应用），再重跑 proxy_diagnose');
  if (allProxiedDead) advice.push('代理端口在监听但出不了网：先 proxy_test 看节点延迟，再 proxy_select 换组内其他节点');
  if (needsProxy.length) {
    advice.push(`需要代理的目标：${needsProxy.map((r) => r.label).join('、')}`);
    advice.push('单次命令：内联 HTTP_PROXY/HTTPS_PROXY 前缀（proxy_env target=shell 给出）；长期：proxy_toolconfig action=apply');
  }
  if (fasterDirect.length) {
    advice.push(`${fasterDirect.map((r) => r.label).join('、')} 直连更快，不要设置全局 HTTPS_PROXY，否则 Qoder 自身请求会被拖慢并可能断连`);
  }
  if (rows.some((r) => r.expectDirect && r.proxied !== 'skipped' && !r.proxied.ok && r.direct.ok)) {
    advice.push('有预期可直连的目标经代理后失败，说明出口 IP 被对方站拒绝（常见于 pypi/npm 的国内镜像策略）');
  }
  return { verdict, advice };
}

async function runDiagnose({
  proxyUrl,
  targets = DEFAULT_TARGETS,
  curlRunner,
  timeoutMs = 8000,
  portAlive = true,
}) {
  const runner = curlRunner || (async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync('curl', args, { windowsHide: true, timeout: timeoutMs + 4000, maxBuffer: 1 << 20 });
      return { code: 0, stdout, stderr };
    } catch (e) {
      return { code: typeof e.code === 'number' ? e.code : 7, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
  });

  const rows = [];
  for (const t of targets) {
    const safeUrl = redactUrl(t.url);
    const direct = await probe({ url: t.url, proxy: null, curlRunner: runner, timeoutMs });
    const proxied = portAlive ? await probe({ url: t.url, proxy: proxyUrl, curlRunner: runner, timeoutMs }) : 'skipped';
    const row = { label: t.label, url: safeUrl, expectDirect: Boolean(t.expectDirect), direct, proxied };
    row.conclusion = rowConclusion(row);
    rows.push(row);
  }
  const { verdict, advice } = summarize(rows);
  return {
    proxyUrl: proxyUrl || null,
    proxyPortAlive: portAlive,
    rows,
    verdict,
    advice,
    note: 'curl 的 --noproxy/--proxy 决定了每一轮是否真的绕过环境变量；本表两列均在同一时刻各跑一次，网络抖动可能让单行结论不稳，重要结论请重复一次',
  };
}

module.exports = { DEFAULT_TARGETS, WRITE_OUT, curlArgs, parseCurlOut, probe, rowConclusion, summarize, runDiagnose };
