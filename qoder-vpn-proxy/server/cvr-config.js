'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn: childSpawn, execFile: childExecFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ApiError } = require('./envelope');
const { discover: defaultDiscover, FALLBACK_PIPE } = require('./discovery');
const { createTransport } = require('./transport');
const { backupOrderKey } = require('./store');

const execFileAsync = promisify(childExecFile);
const SUPPRESS_KEYS = ['enable_system_proxy', 'enable_proxy_guard'];
const DEFAULT_BACKUP_NAMES = ['verge.yaml', 'profiles.yaml'];
// stop() 只回滚会话级压制；profiles.yaml 属持久用户数据，还原它要用 proxy_restore_config
const SESSION_RESTORE_NAMES = ['verge.yaml'];
const STOP_IMAGES = ['clash-verge.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe'];
const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const MARKER_VERSION = 1;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 读 verge.yaml 里某个行首标量键的当前值（原样字符串）；键不存在返回 null。 */
function readScalar(text, key) {
  const m = new RegExp(`^${escapeRe(key)}:[ \\t]*(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

/**
 * 只替换列 0 的 `key: value`。正则按 `^key:` 锚定，所以 `my_enable_system_proxy:`
 * 这类同后缀的键不会被误改。保留原行尾风格；键缺失时在末尾追加。
 */
function patchScalar(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^${escapeRe(key)}:([ \\t]*)(.*)$`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx === -1) {
    const body = text === '' || text.endsWith('\n') ? text : text + eol;
    return { text: `${body}${key}: ${value}${eol}`, changed: true, before: null, after: String(value) };
  }
  const before = re.exec(lines[idx])[2].trim();
  if (before === String(value)) return { text, changed: false, before, after: String(value) };
  lines[idx] = `${key}: ${value}`;
  return { text: lines.join(eol), changed: true, before, after: String(value) };
}

async function defaultWaitForChannel({ timeoutMs, pollMs = 700, discoverImpl = defaultDiscover } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    const runtime = await discoverImpl();
    const candidate = {
      ...runtime,
      controller: { pipe: runtime.controller.pipe || FALLBACK_PIPE, tcp: runtime.controller.tcp },
    };
    try {
      const tr = await createTransport(candidate, { timeoutMs: 1500 });
      const kind = tr.kind;
      tr.close();
      return { kind, ports: runtime.ports };
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new ApiError(
    'core_not_running',
    `Clash Verge 在 ${timeoutMs}ms 内未就绪${lastErr ? `（${lastErr.message}）` : ''}`,
    '若 GUI 已打开但控制器不通，需要在 GUI 中开启外部控制，或检查是否被安全软件拦截'
  );
}

class CvrConfig {
  constructor({
    configDir, backupDir, exePath,
    markerPath = null,
    fsImpl = fs,
    spawn = childSpawn,
    execFile = execFileAsync,
    discover = defaultDiscover,
    waitForChannel,
  } = {}) {
    if (!configDir) throw new ApiError('not_installed', '未找到 Clash Verge 配置目录', '先运行 proxy_detect 确认安装位置');
    if (!backupDir) throw new ApiError('config_write_failed', '调用 cvr-config 必须提供 backupDir（由 store 层给出）', '');
    this.configDir = configDir;
    this.backupDir = backupDir;
    this.exePath = exePath;
    // 压制凭证的落点。没注入时整套 marker 机制休眠：start/stop 行为与从前一致，
    // 只是 proxy_status 只能说"无从判断"，不能说"没压制过"。
    this.markerPath = markerPath;
    this.fs = fsImpl;
    this.spawn = spawn;
    this.execFile = execFile;
    this.backupSeq = 0;
    this.waitForChannel = waitForChannel
      || ((opts) => defaultWaitForChannel({ ...opts, discoverImpl: discover }));
  }

  file(name) { return path.join(this.configDir, name); }

  stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  }

  async backup(names = DEFAULT_BACKUP_NAMES) {
    // 毫秒不够：start() 里 patchVerge 会再次 backup，同毫秒会写到同一个文件名，
    // 把入口备份覆盖成中途状态，回滚就等于没回滚。序号补在时间戳末尾。
    const ts = `${this.stamp()}-${String(this.backupSeq += 1).padStart(3, '0')}`;
    try { this.fs.mkdirSync(this.backupDir, { recursive: true }); }
    catch (e) { throw new ApiError('config_write_failed', `无法创建备份目录 ${this.backupDir}: ${e.code || e.message}`, '磁盘或权限问题，插件不会在未备份的情况下改动配置'); }

    const made = [];
    for (const name of names) {
      const src = this.file(name);
      if (!this.fs.existsSync(src)) { made.push({ name, skipped: true, ts }); continue; }
      const dest = path.join(this.backupDir, `${name}.${ts}.bak`);
      try {
        this.fs.copyFileSync(src, dest);
        if (!this.fs.existsSync(dest) || this.fs.readFileSync(dest, 'utf8') !== this.fs.readFileSync(src, 'utf8')) {
          throw new ApiError('config_write_failed', `备份 ${name} 落盘后校验不一致`, '中止写入，配置未发生改动');
        }
        made.push({ name, backupPath: dest, ts, skipped: false });
      } catch (e) {
        throw e instanceof ApiError ? e : new ApiError('config_write_failed', `备份 ${name} 失败: ${e.code || e.message}`, '中止写入，配置未发生改动');
      }
    }
    return made;
  }

  listBackups() {
    if (!this.fs.existsSync(this.backupDir)) return [];
    const entries = this.fs.readdirSync(this.backupDir)
      // readdirSync 给的是裸文件名，所以这里必须从行首匹配 `verge.yaml.<ts>.bak`
      .filter((f) => /^(?:verge|profiles|config)\.yaml\.[\d-]+\.bak$/.test(f))
      .map((f) => {
        const m = /^(.*)\.([\d-]+)\.bak$/.exec(f);
        return { name: m[1], ts: m[2], backupPath: path.join(this.backupDir, f) };
      });
    const mtime = new Map(entries.map((e) => [e.backupPath, this.mtimeOf(e.backupPath)]));
    // ts 主键、mtime 兜底（与 store.listBackupsIn 同一口径）：以前反过来，而
    // fs.copyFileSync 在 Windows 上会保留源文件 mtime，"把旧基座备成新备份"就会
    // 得到一个 mtime 比昨天还老的新备份，mtime 主键于是让 restore 挑到过期那份。
    // 两种时间戳写法（带横杠 / 不带）归一成纯数字后可直接比，'-' 不再参与字典序。
    return entries.sort((a, b) => {
      const ka = backupOrderKey(path.basename(a.backupPath));
      const kb = backupOrderKey(path.basename(b.backupPath));
      if (ka !== kb) return ka > kb ? -1 : 1;
      const ma = mtime.get(a.backupPath) - mtime.get(b.backupPath);
      if (ma !== 0) return ma > 0 ? -1 : 1;
      return a.backupPath < b.backupPath ? -1 : 1;
    });
  }

  mtimeOf(p) {
    try { return this.fs.statSync(p).mtimeMs; } catch { return 0; }
  }

  latestBackupFor(name) {
    return this.listBackups().find((b) => b.name === name) || null;
  }

  writeText(name, text, backups) {
    try {
      this.fs.writeFileSync(this.file(name), text, 'utf8');
      return true;
    } catch (e) {
      // 写入失败时尽力回滚到刚做的备份，绝不留下半改状态
      for (const b of backups) {
        if (b.name !== name || b.skipped) continue;
        try { this.fs.copyFileSync(b.backupPath, this.file(name)); } catch { /* 回滚失败只能原样抛出 */ }
      }
      throw new ApiError('config_write_failed', `写入 ${name} 失败: ${e.code || e.message}`, '已尝试回滚到本次备份，请核对 proxy_restore_config 列出的备份时间');
    }
  }

  async patchVerge(patches) {
    const name = 'verge.yaml';
    const src = this.file(name);
    if (!this.fs.existsSync(src)) throw new ApiError('not_installed', `${src} 不存在`, '配置目录不完整');
    const backups = await this.backup([name]);
    let text = this.fs.readFileSync(src, 'utf8');
    const changed = [];
    for (const [key, value] of Object.entries(patches)) {
      const r = patchScalar(text, key, value);
      if (r.changed) changed.push({ key, before: r.before, after: r.after });
      text = r.text;
    }
    if (changed.length) this.writeText(name, text, backups);
    return { changed, backups };
  }

  async suppressSystemProxy() {
    const { changed } = await this.patchVerge(Object.fromEntries(SUPPRESS_KEYS.map((k) => [k, false])));
    return { changed };
  }

  async setExternalController(enabled) {
    const { changed } = await this.patchVerge({ enable_external_controller: Boolean(enabled) });
    return { changed };
  }

  /* ---------- 压制凭证（marker）：跨进程说清"插件欠着还原" ---------- */

  /**
   * 现读 SUPPRESS_KEYS 在 verge.yaml 里的当前值。文件读不到时全记 null，
   * 宁可在还原阶段报"没有原值可依"，也不要凭猜测写回一个 true。
   */
  currentSuppressValues() {
    let text = null;
    try { text = this.fs.existsSync(this.file('verge.yaml')) ? this.fs.readFileSync(this.file('verge.yaml'), 'utf8') : null; }
    catch { text = null; }
    return Object.fromEntries(SUPPRESS_KEYS.map((k) => [k, text === null ? null : readScalar(text, k)]));
  }

  /** 盘上的压制凭证；没有 markerPath 或文件不存在返回 null。读不懂的文件交给 readSuppression 如实上报。 */
  readMarker() {
    if (!this.markerPath) return null;
    let parsed;
    try {
      if (!this.fs.existsSync(this.markerPath)) return null;
      parsed = JSON.parse(this.fs.readFileSync(this.markerPath, 'utf8'));
    } catch { return null; }
    if (!parsed || parsed.version !== MARKER_VERSION || !Array.isArray(parsed.entries)) return null;
    return parsed;
  }

  /**
   * 记下"压制前的原值"。已有记录时同键保留更早那份 before —— 第二轮 start 看到的"前值"
   * 是第一轮压制后的 false，直接覆盖就等于把用户的 true 从账上洗掉了。
   */
  recordSuppression() {
    if (!this.markerPath) return null;
    const cur = this.currentSuppressValues();
    const prev = this.readMarker();
    const before = new Map((prev && prev.entries || []).map((e) => [e.key, e.before]));
    const now = new Date().toISOString();
    // 先读后改：before 取的是压制前的盘上值，所以本方法必须在 suppressSystemProxy 之前调用
    const entries = SUPPRESS_KEYS.map((key) => ({
      key,
      before: before.has(key) ? before.get(key) : (cur[key] ?? null),
      after: 'false',
    }));
    const payload = { version: MARKER_VERSION, created: (prev && prev.created) || now, updated: now, entries };
    try {
      this.fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
      this.fs.writeFileSync(this.markerPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      return { path: this.markerPath, entries, error: e.code || e.message };
    }
    return { path: this.markerPath, created: payload.created, updated: payload.updated, entries };
  }

  clearMarker() {
    if (!this.markerPath) return false;
    try {
      if (!this.fs.existsSync(this.markerPath)) return true;
      this.fs.unlinkSync(this.markerPath);
      return true;
    } catch { return false; }
  }

  /**
   * 按 marker 记的 before 把键补回去，只在"当前值 != 原值"时才写（写本身走 patchVerge，照例先备份）。
   * 全部对齐后才删 marker；没对齐就留着，下一轮 stop 还会再试。
   */
  async repairSuppression() {
    const m = this.readMarker();
    if (!m) {
      const stale = Boolean(this.markerPath) && this.fs.existsSync(this.markerPath);
      return {
        present: stale, repaired: [],
        skipped: stale ? [{ reason: 'unreadable' }] : [],
        cleared: false,
        ...(stale ? { error: 'unreadable', path: this.markerPath } : {}),
      };
    }
    const cur = this.currentSuppressValues();
    const patches = {};
    const repaired = [];
    const skipped = [];
    for (const e of m.entries) {
      if (typeof e.before !== 'string') { skipped.push({ key: e.key, reason: 'no-before' }); continue; }
      if (cur[e.key] === e.before) continue;
      patches[e.key] = e.before;
      repaired.push({ key: e.key, from: cur[e.key] ?? null, to: e.before });
    }
    if (Object.keys(patches).length) await this.patchVerge(patches);
    const after = this.currentSuppressValues();
    const aligned = m.entries.every((e) => typeof e.before !== 'string' || after[e.key] === e.before);
    return { present: true, repaired, skipped, cleared: aligned && this.clearMarker(), error: aligned ? undefined : 'still-suppressed' };
  }

  /** 给 proxy_status 用：把盘上的凭证整理成一块能自解释的输出，读不到就说明读不到。 */
  readSuppression() {
    if (!this.markerPath) {
      return { available: false, present: false, entries: [], note: '没有注入压制凭证路径（markerPath），压制状态无法判断 —— 这是"读不到"，别当成结论。' };
    }
    const m = this.readMarker();
    if (m) {
      return {
        available: true, present: true, path: this.markerPath,
        created: m.created, updated: m.updated, entries: m.entries,
        note: '这是插件自己记下的"压制前原值"。存在就说明 enable_system_proxy / enable_proxy_guard 被本插件改过且尚未确认还原。',
      };
    }
    if (this.fs.existsSync(this.markerPath)) {
      return {
        available: true, present: true, path: this.markerPath, entries: [], error: 'unreadable',
        note: `凭证文件在 ${this.markerPath} 但读不懂（版本不符或 JSON 坏了），无法判断该还原成什么。插件不猜、也不删——删了就没有现场证据；确认无需保留后手工删掉该文件即可。`,
      };
    }
    return { available: true, present: false, entries: [], note: '没有压制凭证：本插件没有把系统代理压下去过，或已确认还原到位。' };
  }

  async start({ scope = 'session', timeoutMs = 25000, enableExternalControl = false } = {}) {
    if (scope !== 'session' && scope !== 'global') {
      throw new ApiError('config_write_failed', `未知 scope: ${scope}`, '只支持 "session" 或 "global"');
    }
    // 先确认再动手：exe 不存在时如果等到 waitForChannel 超时才报，用户要白等 25 秒
    if (!this.exePath || !this.fs.existsSync(this.exePath)) {
      throw new ApiError('not_installed', `找不到可执行文件 ${this.exePath}`, '用 proxy_detect 确认安装目录，或设置 QVP_INSTALL_DIR');
    }
    const backups = await this.backup(DEFAULT_BACKUP_NAMES);
    let suppressed = false;
    let externalControl = false;
    let marker = null;
    try {
      if (scope === 'session') {
        // 先落凭证再动手：一旦压制生效而进程随后被打断（真机踩过 SIGPIPE），
        // "该改回什么"就只剩这份记录知道，下一次 stop / proxy_status 才有依据。
        marker = this.recordSuppression();
        await this.suppressSystemProxy();
        suppressed = true;
      }
      // 必须在 spawn 之前改：CVR 只在启动时读 verge.yaml，进程起来之后再改就无效了
      if (enableExternalControl) {
        const r = await this.setExternalController(true);
        externalControl = r.changed.length > 0;
      }
      const child = this.spawn(this.exePath, [], { detached: true, stdio: 'ignore', windowsHide: true });
      if (child && typeof child.unref === 'function') child.unref();

      const waited = Date.now();
      const channel = await this.waitForChannel({ timeoutMs });
      return {
        scope,
        systemProxySuppressed: suppressed,
        suppressionMarker: suppressed ? marker : null,
        externalControlEnabled: externalControl,
        channel,
        ports: channel.ports,
        waitedMs: Date.now() - waited,
        backups,
      };
    } catch (err) {
      // 启动失败必须还原：用户看到 core_not_running 时机器状态应与调用前一致。
      // 条件是"动过任何一个键"，只看 suppressed 会漏掉 scope=global + enableExternalControl 这条路径。
      // 还原用入口那一批备份，不用"最近一次备份"：中途每次 patchVerge 都又备了一份，
      // 最近那份已经带着压制后的值，拿它还原等于没还原（session + enableExternalControl 组合下尤其明显）。
      if (suppressed || externalControl) await this.restoreFrom(backups).catch(() => {});
      // 入口备份本身可能就是压制态（上一轮没还原就再来一轮），只 restoreFrom 回不到用户的原值，
      // 所以这里还要按 marker 补写一次；补写成功后凭证一并作废。
      if (suppressed) await this.repairSuppression().catch(() => {});
      throw err.kind === 'channel_unavailable' ? new ApiError('core_not_running', err.message, 'CVR 已启动但控制器不可达；可能需要在 GUI 开启外部控制') : err;
    }
  }

  async taskkill(image) {
    try { await this.execFile('taskkill', ['/IM', image, '/F'], { windowsHide: true, timeout: 8000, maxBuffer: 1 << 20 }); return true; }
    catch { return false; }
  }

  /**
   * tasklist 的"没有匹配任务"提示是本地语言 + 本地码页（这台机器是 GBK），会读成乱码；
   * 而表头行一定含镜像名本身，所以只按镜像名子串判活，天然绕开码页问题。
   */
  async runningImages(images = STOP_IMAGES) {
    const alive = [];
    for (const image of images) {
      try {
        const { stdout } = await this.execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 1 << 20 });
        if (String(stdout || '').includes(image)) alive.push(image);
      } catch { /* 探测失败当作没在跑：stop 不能被自己的检查卡住 */ }
    }
    return alive;
  }

  async waitForExit(images = STOP_IMAGES, { timeoutMs = 4000, pollMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let pending = await this.runningImages(images);
    while (pending.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      pending = await this.runningImages(pending);
    }
    return pending;
  }

  /** 只读复查系统代理开关。插件按设计绝不写注册表，读不到就返回 null。 */
  async systemProxyEnabled() {
    try {
      const { stdout } = await this.execFile('reg', ['query', INTERNET_SETTINGS_KEY, '/v', 'ProxyEnable'], { windowsHide: true, timeout: 5000, maxBuffer: 1 << 20 });
      const m = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout || ''));
      return m ? Number.parseInt(m[1], 16) !== 0 : null;
    } catch { return null; }
  }

  async stop({ restore = true, exitTimeoutMs = 4000, pollMs = 250 } = {}) {
    const killed = [];
    for (const image of STOP_IMAGES) {
      if (await this.taskkill(image)) killed.push(image);
    }
    // 必须等进程真的没了再还原：verge.yaml 里 enable_system_proxy 本来就是 true，
    // CVR 还在拆除时读到还原后的配置会把系统代理重新打开，而核心已经停了 ——
    // 浏览器于是全部"连接被拒绝"。真机上就是这么踩到的（缺陷 8）。
    const stillRunning = await this.waitForExit(STOP_IMAGES, { timeoutMs: exitTimeoutMs, pollMs });
    const warnings = [];
    if (stillRunning.length) {
      warnings.push(`taskkill 后等了 ${exitTimeoutMs}ms，${stillRunning.join(', ')} 仍在运行：配置可能被 CVR 再次回写，稍后用 proxy_status 复查`);
    }
    if (!restore) {
      const s = this.readSuppression();
      if (s.present) warnings.push(`restore=false：压制凭证仍在盘上，${SUPPRESS_KEYS.join(' / ')} 仍是被本插件压制的状态，交还前请再跑一次 proxy_core_stop restore=true`);
      return { killed, restored: false, stillRunning, warnings, suppression: { ...s, repaired: [], cleared: false } };
    }
    // 只回滚会话级改动（系统代理压制 / 外部控制开关）。profiles.yaml 里的订阅切换与增删
    // 是用户主动的持久意图，撤销它得靠 proxy_restore_config，不能藏在 stop 的副作用里。
    const r = await this.restore(SESSION_RESTORE_NAMES);
    // 备份链本身可能就是压制态：会话 A 的 start 之后调用方被打断（没走到 stop），
    // 会话 B 的 start 又把已经是压制态的 verge.yaml 备份了一遍 —— 此时"还原最近一份备份"
    // 修不好无主压制，必须按 marker 记的原值补写（缺陷 ⑧）。
    const supp = await this.repairSuppression();
    if (supp.repaired.length) {
      warnings.push(`最近一份 verge.yaml 备份本身就带着压制值，已按压制凭证补回原值：${supp.repaired.map((x) => `${x.key}=${x.to}`).join(', ')}`);
    }
    if (supp.error === 'unreadable') {
      warnings.push(`压制凭证读不懂（${supp.path}），本次无法判断该还原成什么；确认无需保留后手工删除该文件`);
    }
    const systemProxyEnabled = await this.systemProxyEnabled();
    if (systemProxyEnabled === true) {
      warnings.push(
        '核心已停止但系统代理仍开启（ProxyEnable=1），浏览器会出现"连接被拒绝"。'
        + `插件按设计不写注册表，需要时请自行执行：reg add "${INTERNET_SETTINGS_KEY}" /v ProxyEnable /t REG_DWORD /d 0 /f`
      );
    }
    return { killed, restored: r.restored.length > 0, restoredList: r.restored, stillRunning, systemProxyEnabled, suppression: supp, warnings };
  }

  async restoreFrom(list) {
    const restored = [];
    for (const b of list || []) {
      if (!b || b.skipped || !b.backupPath) continue;
      try { this.fs.copyFileSync(b.backupPath, this.file(b.name)); restored.push({ name: b.name, backupPath: b.backupPath, ts: b.ts }); }
      catch (e) { throw new ApiError('config_write_failed', `还原 ${b.name} 失败: ${e.code || e.message}`, `备份文件 ${b.backupPath} 可能被占用`); }
    }
    return { restored };
  }

  async restore(names = DEFAULT_BACKUP_NAMES) {
    return this.restoreFrom(names.map((name) => this.latestBackupFor(name)).filter(Boolean));
  }

  modifiedSinceBackup(names = DEFAULT_BACKUP_NAMES) {
    const modified = [];
    const clean = [];
    const noBackup = [];
    for (const name of names) {
      const b = this.latestBackupFor(name);
      // 没有插件备份时"当前内容 == 基线"这句话根本无从判断。以前直接 continue，
      // 于是 proxy_status 报出来的一片干净 —— 那是"没得比"伪装成"没问题"。
      if (!b) { noBackup.push(name); continue; }
      let cur, old;
      try { cur = this.fs.existsSync(this.file(name)) ? this.fs.readFileSync(this.file(name), 'utf8') : null; } catch { cur = null; }
      try { old = this.fs.readFileSync(b.backupPath, 'utf8'); } catch { noBackup.push(name); continue; }
      // 只在"当前内容 != 备份内容"时报告改过：还原之后备份仍在，但已不该报脏
      // 文件整个不见了是最严重的一种偏离，不能算"没得比"：建议的是还原，不是 diff
      if (cur === null) modified.push({ name, backupTs: b.ts, backupPath: b.backupPath, missing: true });
      else if (cur !== old) modified.push({ name, backupTs: b.ts, backupPath: b.backupPath });
      else clean.push(name);
    }
    return { modified, clean, noBackup };
  }
}

module.exports = { CvrConfig, patchScalar, SUPPRESS_KEYS, DEFAULT_BACKUP_NAMES, SESSION_RESTORE_NAMES, STOP_IMAGES, ApiError, defaultWaitForChannel };
