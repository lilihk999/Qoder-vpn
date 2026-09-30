'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const P = require('./profilesYaml');
const { ApiError } = require('./envelope');
const { redactUrl } = require('./redact');
const defaultFetch = require('./subscription').fetchSubscription;

const UID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const REGISTRY = 'profiles.yaml';

function newUid(len = 12) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += UID_ALPHABET[bytes[i] % UID_ALPHABET.length];
  return out;
}

const isUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim());

class SubscriptionRepo {
  constructor({
    configDir, dirs, client = null, fetchImpl = defaultFetch,
    now = () => Math.floor(Date.now() / 1000), fsImpl = fs,
  } = {}) {
    if (!configDir || !dirs) throw new ApiError('config_write_failed', 'SubscriptionRepo 需要 configDir 与 dirs', '');
    this.configDir = configDir;
    this.dirs = dirs;
    this.client = client;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.fs = fsImpl;
    this.registryPath = path.join(configDir, REGISTRY);
    this.profilesDir = path.join(configDir, 'profiles');
    this.metaPath = path.join(dirs.root, 'subscriptions.json');
  }

  registryText() {
    if (!this.fs.existsSync(this.registryPath)) {
      throw new ApiError('not_installed', `找不到 ${this.registryPath}`, 'Clash Verge 配置目录不完整');
    }
    return this.fs.readFileSync(this.registryPath, 'utf8');
  }

  items() { return P.listItems(this.registryText()); }

  current() {
    const m = /^current:[ \t]*(.*)$/m.exec(this.registryText());
    return m ? m[1].trim() : null;
  }

  meta() { return store.readJson(this.metaPath, {}) || {}; }

  saveMeta(m) { store.writeJsonAtomic(this.metaPath, m); }

  toEntry(item, currentUid, metaById) {
    const meta = metaById[item.uid] || {};
    return {
      uid: item.uid,
      name: item.name || meta.name || item.uid,
      url: item.url ? redactUrl(item.url) : null,
      urlPathOnly: item.url ? item.url.replace(/[?#].*$/, '') : null,
      file: item.file,
      type: item.type,
      active: item.uid === currentUid,
      nodes: meta.nodes ?? null,
      userInfo: meta.userInfo ?? null,
      updated: item.updated ? Number(item.updated) : null,
      autoUpdate: meta.autoUpdate ?? (item.option && item.option.allow_auto_update ? item.option.allow_auto_update === 'true' : undefined),
      updateInterval: meta.updateInterval ?? (item.option && item.option.update_interval ? Number(item.option.update_interval) : undefined),
      remark: meta.remark ?? '',
      addedAt: meta.addedAt ?? null,
      source: meta.source || 'cvr',
    };
  }

  async list() {
    const currentUid = this.current();
    const metaById = this.meta();
    return this.items()
      .filter((i) => i.type === 'remote' || (metaById[i.uid] && metaById[i.uid].managed))
      .map((i) => this.toEntry(i, currentUid, metaById));
  }

  remoteByUrl(url) { return this.items().find((i) => i.url && i.url === url) || null; }

  mustFind(uid) {
    const items = this.items();
    const item = items.find((i) => i.uid === uid);
    if (item) return item;
    // hint 用 uid(名字) 而不是 uid(脱敏 url)：用户认的是名字
    const known = items.filter((i) => i.type === 'remote').map((i) => `${i.uid}(${i.name || redactUrl(i.url || '')})`).join(' / ');
    throw new ApiError('subscription_not_found', `清单里没有 uid ${uid}`, `现有订阅：${known || '（空）'}`);
  }

  inlineBackup(name) {
    const src = path.join(this.configDir, name);
    if (!this.fs.existsSync(src)) return null;
    this.fs.mkdirSync(this.dirs.backups, { recursive: true });
    const dest = path.join(this.dirs.backups, `${name}.${store.stamp()}.bak`);
    this.fs.copyFileSync(src, dest);
    return dest;
  }

  /** 备份 -> 写 -> 立即重读校验 -> 不一致回滚。CVR 运行时会把内存态回写这个文件 */
  writeRegistry(nextText, { expect } = {}) {
    const backupPath = this.inlineBackup(REGISTRY);
    const backups = backupPath ? [{ name: REGISTRY, backupPath, ts: store.stamp() }] : [];
    const rollback = () => {
      for (const b of backups) {
        try { this.fs.copyFileSync(b.backupPath, this.registryPath); } catch { /* 回滚失败也照样报 desync */ }
      }
    };
    this.fs.writeFileSync(this.registryPath, nextText, 'utf8');
    const reread = this.fs.readFileSync(this.registryPath, 'utf8');
    if (reread !== nextText) {
      rollback();
      throw new ApiError(
        'profile_registry_desync',
        `写入 ${REGISTRY} 后重读不一致，已回滚`,
        'Clash Verge 在运行时会把内存里的订阅状态回写该文件。请让 CVR 处于停止状态后重试（proxy_core_stop），或在 GUI 里改动'
      );
    }
    if (expect) {
      for (const [uid, url] of Object.entries(expect)) {
        const it = P.getItem(reread, uid);
        if (!it || (url !== undefined && it.url !== url)) {
          rollback();
          throw new ApiError('profile_registry_desync', `重读 profiles.yaml 时 uid ${uid} 与预期不符，已回滚`, '写入被外部状态覆盖；建议在 CVR 停止时操作');
        }
      }
    }
    return backups;
  }

  writeProfileFile(uid, yamlText) {
    this.fs.mkdirSync(this.profilesDir, { recursive: true });
    const file = path.join(this.profilesDir, `${uid}.yaml`);
    this.fs.writeFileSync(file, yamlText, 'utf8');
    return file;
  }

  async add({ url, name, remark = '', activate = false, autoUpdate = true, updateInterval = 1440 }) {
    if (!isUrl(url)) throw new ApiError('subscription_url_invalid', '订阅地址必须是完整的 http(s) 链接', '示例：https://机场域名/路径?token=xxx');
    const clean = String(url).trim();
    const dup = this.remoteByUrl(clean);
    if (dup) throw new ApiError('subscription_duplicate', `该链接已存在（uid ${dup.uid}）`, '如要刷新内容用 proxy_subscription_update，如要换地址用 proxy_subscription_edit');

    // 先抓再写：抓不到就一个字节都不动
    const fetched = await this.fetchImpl(clean);
    const uid = newUid();
    const entryName = name || fetched.name || uid;
    const text = this.registryText();
    const item = {
      uid, type: 'remote', name: entryName, file: `${uid}.yaml`, url: clean,
      selected: { name: entryName, now: '' },
      extra: {
        upload: fetched.userInfo ? fetched.userInfo.upload : 0,
        download: fetched.userInfo ? fetched.userInfo.download : 0,
        total: fetched.userInfo ? fetched.userInfo.total : 0,
        expire: fetched.userInfo ? fetched.userInfo.expire || 0 : 0,
      },
      updated: this.now(),
      option: { update_interval: updateInterval, allow_auto_update: Boolean(autoUpdate) },
    };
    if (fetched.yaml) this.writeProfileFile(uid, fetched.yaml);
    else this.writeProfileFile(uid, '# base64 订阅：节点串由 CVR 抓取时展开\n# added-by: qoder-vpn-proxy\n');

    let next = P.appendItem(text, item);
    if (activate) next = P.setCurrent(next, uid);
    this.writeRegistry(next, { expect: { [uid]: clean } });

    const meta = this.meta();
    meta[uid] = {
      uid, name: entryName, remark, source: 'plugin', managed: true,
      addedAt: new Date().toISOString(), lastUpdated: new Date().toISOString(),
      autoUpdate, updateInterval, nodes: fetched.nodes, userInfo: fetched.userInfo,
    };
    this.saveMeta(meta);
    if (activate && this.client) await this.client.reload({ proxyProviders: false }).catch(() => {});
    return this.toEntry(this.mustFind(uid), this.current(), meta);
  }

  async edit(uid, { url, name, remark, autoUpdate, updateInterval } = {}) {
    this.mustFind(uid);
    const text = this.registryText();
    let next = text;
    let fetched = null;

    if (url !== undefined) {
      if (!isUrl(url)) throw new ApiError('subscription_url_invalid', '订阅地址必须是完整的 http(s) 链接', '示例：https://机场域名/路径?token=xxx');
      const clean = String(url).trim();
      const dup = this.remoteByUrl(clean);
      if (dup && dup.uid !== uid) throw new ApiError('subscription_duplicate', `该链接已被 ${dup.uid} 使用`, '若要复用请先删除原订阅');
      fetched = await this.fetchImpl(clean); // 换链接先确认抓得到，否则不改任何文件
      next = P.setField(next, uid, 'url', clean);
    }
    if (name !== undefined) next = P.setField(next, uid, 'name', name);
    if (updateInterval !== undefined) next = P.setNested(next, uid, 'option', 'update_interval', Number(updateInterval));
    if (autoUpdate !== undefined) next = P.setNested(next, uid, 'option', 'allow_auto_update', Boolean(autoUpdate));
    if (next !== text) this.writeRegistry(next, { expect: url !== undefined ? { [uid]: String(url).trim() } : undefined });

    const prev = this.meta()[uid];
    const meta = this.meta();
    meta[uid] = {
      ...(prev || { uid, source: 'cvr', addedAt: new Date().toISOString() }),
      managed: true,
      name: name ?? prev?.name,
      remark: remark ?? prev?.remark ?? '',
      autoUpdate: autoUpdate ?? prev?.autoUpdate,
      updateInterval: updateInterval ?? prev?.updateInterval,
      editedAt: new Date().toISOString(),
    };
    if (fetched) { meta[uid].nodes = fetched.nodes; meta[uid].userInfo = fetched.userInfo; }
    this.saveMeta(meta);
    return this.toEntry(this.mustFind(uid), this.current(), meta);
  }

  async update(uid, { fetchImpl } = {}) {
    const item = this.mustFind(uid);
    if (!item.url) throw new ApiError('subscription_url_invalid', `订阅 ${uid} 没有 url 字段，无法更新`, '这是本地覆盖型 profile，不需要更新');
    const fetched = await (fetchImpl || this.fetchImpl)(item.url); // 抓取失败时后面的写入一行都不执行

    const text = this.registryText();
    const meta = this.meta();
    const ui = fetched.userInfo || {};
    let next = P.setNested(text, uid, 'extra', 'upload', ui.upload ?? 0);
    next = P.setNested(next, uid, 'extra', 'download', ui.download ?? 0);
    next = P.setNested(next, uid, 'extra', 'total', ui.total ?? 0);
    next = P.setNested(next, uid, 'extra', 'expire', ui.expire ?? 0);
    next = P.setField(next, uid, 'updated', this.now());
    // 只有 CVR 里本来就没名字时才用机场名补齐；用户改过的名字不能被每次更新冲掉
    if (fetched.name && item.name === null && !(meta[uid] && meta[uid].name)) next = P.setField(next, uid, 'name', fetched.name);
    this.writeRegistry(next, { expect: { [uid]: item.url } });
    if (fetched.yaml) this.writeProfileFile(uid, fetched.yaml);

    meta[uid] = {
      ...(meta[uid] || { uid, source: 'cvr' }),
      managed: true,
      name: (meta[uid] && meta[uid].name) ?? (item.name === null ? fetched.name : undefined),
      lastUpdated: new Date().toISOString(),
      nodes: fetched.nodes,
      userInfo: fetched.userInfo,
      format: fetched.format,
    };
    this.saveMeta(meta);
    if (this.client && uid === this.current()) await this.client.reload({}).catch(() => {});
    return this.toEntry(this.mustFind(uid), this.current(), meta);
  }

  async updateAll({ fetchImpl } = {}) {
    const entries = await this.list();
    const results = [];
    for (const e of entries) {
      if (e.autoUpdate === false) { results.push({ uid: e.uid, ok: false, kind: 'skipped', message: 'autoUpdate 已关闭' }); continue; }
      try {
        const r = await this.update(e.uid, { fetchImpl });
        results.push({ uid: e.uid, ok: true, nodes: r.nodes, userInfo: r.userInfo });
      } catch (err) {
        results.push({ uid: e.uid, ok: false, kind: err.kind || 'channel_unavailable', message: err.message });
      }
    }
    return { results };
  }

  async activate(uid) {
    this.mustFind(uid);
    const next = P.setCurrent(this.registryText(), uid);
    this.writeRegistry(next);
    if (this.client) await this.client.reload({ proxyProviders: false });
    const groups = this.client ? (await this.client.getProxies()).groups : [];
    const after = this.current();
    if (after !== uid) throw new ApiError('profile_registry_desync', `切换 current 后回读为 ${after}`, 'CVR 可能正在回写该文件');
    return { current: after, groups };
  }

  async remove(uid, { force = false } = {}) {
    const item = this.mustFind(uid);
    if (uid === this.current() && !force) {
      throw new ApiError('subscription_active_protected', `${uid} 是当前激活订阅，删除会让 mihomo 没有配置可用`, '先 activate 到别的订阅，或确认后再传 force: true');
    }
    const backups = this.writeRegistry(P.removeItem(this.registryText(), uid));
    const trashed = backups.map((b) => path.basename(b.backupPath));
    const contentFile = path.join(this.profilesDir, item.file || `${uid}.yaml`);
    if (this.fs.existsSync(contentFile)) trashed.push(path.basename(store.moveToTrash(this.dirs, contentFile)));
    const meta = this.meta();
    delete meta[uid];
    this.saveMeta(meta);
    if (this.client) await this.client.reload({}).catch(() => {});
    return { removed: uid, trashed, undo: `注册表备份在 ${this.dirs.backups}，内容文件在 ${this.dirs.trash}；放回 ${this.profilesDir} 并重新 add 即可撤销` };
  }
}

module.exports = { SubscriptionRepo, newUid, UID_ALPHABET, REGISTRY };
