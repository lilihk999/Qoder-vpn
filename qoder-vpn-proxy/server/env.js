'use strict';

const GIT_PROXY_HOSTS = ['github.com', 'objects.githubusercontent.com', 'api.github.com'];
const BASE_NO_PROXY = ['127.0.0.1', 'localhost', '::1', '*.cn', '*.com.cn', '*.localhost', '169.254.169.254'];
const NPM_NO_PROXY = ['localhost', '127.0.0.1'];

function buildProxyEnv({ mixedPort, socksPort, noProxyExtra = [] }) {
  if (!Number.isInteger(mixedPort) || mixedPort < 1 || mixedPort > 65535) {
    throw new RangeError(`mixedPort 非法: ${mixedPort}`);
  }
  const proxyUrl = `http://127.0.0.1:${mixedPort}`;
  const socksUrl = `socks5://127.0.0.1:${mixedPort}`;
  const noProxy = [...BASE_NO_PROXY, ...noProxyExtra].join(',');

  return {
    proxyUrl,
    socksUrl,
    mixedPort,
    socksPort,
    vars: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: socksUrl, NO_PROXY: noProxy },
    shell: [
      `export HTTP_PROXY=${proxyUrl}`,
      `export HTTPS_PROXY=${proxyUrl}`,
      `export ALL_PROXY=${socksUrl}`,
      `export NO_PROXY="${noProxy}"`,
    ],
    npm: [`proxy=${proxyUrl}`, `https-proxy=${proxyUrl}`, `noproxy=${NPM_NO_PROXY.join(',')}`],
    git: GIT_PROXY_HOSTS.map((h) => `git config --global http.https://${h}/.proxy ${proxyUrl}`),
    pip: [`python -m pip config set global.proxy ${proxyUrl}`, `python -m pip config set global.trusted_host ""`],
  };
}

function inlinePrefix(e) {
  return `HTTP_PROXY=${e.proxyUrl} HTTPS_PROXY=${e.proxyUrl} NO_PROXY=${JSON.stringify(e.vars.NO_PROXY)}`;
}

module.exports = { buildProxyEnv, inlinePrefix, GIT_PROXY_HOSTS };
