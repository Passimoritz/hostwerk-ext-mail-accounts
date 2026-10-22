'use strict';
/*
 * E-Mail-Konten: Herzstück ohne Express – Konten, Verbindungen, Zwischenspeicher, Postausgang, Regeln, Kontakte,
 * Benachrichtigungen, Sicherung. index.js hängt nur die Routen davor; die Tests nutzen den Dienst direkt.
 *
 * Daten (data/mail-accounts/): accounts.json (Konten, Geheimnisse verschlüsselt) · prefs.json · rules.json ·
 * templates.json · state.json (letzte bekannte UID je Posteingang) · contacts.json · outbox.json · cache/ · backups/
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { readJson, writeJson, newId } = require('./store');
const { AccountClient } = require('./imap');
const { Cache } = require('./cache');
const { Contacts } = require('./contacts');
const { Notifier } = require('./notify');
const { OAuth } = require('./oauth');
const { Outbox, build, smtpSend } = require('./send');
const { parseMessage, attachment, threads, baseSubject } = require('./message');
const { evaluate, clean: cleanRule } = require('./rules');
const { discover, oidcEndpoints } = require('./discover');
const { classify, peekCertificate, isLocal } = require('./netutil');
const { textToHtml } = require('./sanitize');

const SECURITY = ['tls', 'starttls', 'none'];
const COLORS = ['#2563eb', '#0d9488', '#d97706', '#db2777', '#7c3aed', '#059669', '#dc2626', '#0891b2'];
const DEFAULT_PREFS = {
  notify: true, quiet: { on: false, from: '22:00', to: '07:00' }, cacheMB: 300, markReadOnOpen: true, undoSeconds: 10, threads: true,
  trustedSenders: [], aiConsent: false, prefetch: true, composeFormat: 'html', density: 'normal', saveSent: 'auto',
};
const err = (status, text, extra = {}) => Object.assign(new Error(text), { status, ...extra });
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class MailService extends EventEmitter {
  /**
   * deps: { dir, secrets, now, offline(), fetch, notify({ title, text }), broadcast(msg), t(text, vars), lang(), ai: { ready(), run() } | null,
   *         local: () => [{ id, name, imap, smtp, auth }] (Mail-Fänger, eigener Mailserver), resolveMx/resolveSrv/probe (Tests) }
   */
  constructor(deps) {
    super();
    this.deps = deps;
    this.dir = deps.dir;
    this.now = deps.now || (() => Date.now());
    this.t = deps.t || ((s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s));
    fs.mkdirSync(this.dir, { recursive: true });
    this.secrets = deps.secrets;
    this.f = (n) => path.join(this.dir, n);
    this.accountsCfg = readJson(this.f('accounts.json'), () => []);
    this.prefsCfg = { ...DEFAULT_PREFS, ...readJson(this.f('prefs.json'), () => ({})) };
    this.rulesCfg = readJson(this.f('rules.json'), () => []);
    this.templatesCfg = readJson(this.f('templates.json'), () => []);
    this.stateCfg = readJson(this.f('state.json'), () => ({}));
    this.cache = new Cache(this.f('cache'), { limitMB: this.prefsCfg.cacheMB, now: this.now });
    this.contacts = new Contacts(this.dir, { now: this.now });
    this.oauth = new OAuth({ fetch: deps.fetch, now: this.now });
    this.tokens = new Map(); // Konto → { accessToken, expires } (nur im Speicher)
    this.clients = new Map();
    this.live = new Map(); // Konto → { status, error, unread }
    this.folderCache = new Map(); // Konto → { at, list }
    this.uidValidity = new Map(); // konto|ordner → uidValidity
    this.notifier = new Notifier({ send: (m) => deps.notify && deps.notify(m), prefs: () => this.prefsCfg, t: this.t, now: this.now, delay: deps.notifyDelay });
    this.outbox = new Outbox({ dir: this.dir, now: this.now, send: (it) => this.deliver(it), onEvent: (type, it) => this.onOutbox(type, it) });
    this.prefetchQueue = [];
    this.prefetching = false;
    this.started = false;
  }

  /* ---------- Ablage ---------- */
  saveAccounts() { writeJson(this.f('accounts.json'), this.accountsCfg); }
  saveState() { writeJson(this.f('state.json'), this.stateCfg); }
  broadcast(msg) { try { if (this.deps.broadcast) this.deps.broadcast({ type: 'mail-accounts', ...msg }); } catch { /* egal */ } this.emit('event', msg); }
  account(id) { const a = this.accountsCfg.find((x) => x.id === id); if (!a) throw err(404, 'This account doesn’t exist (any more).'); return a; }
  offline() { try { return !!(this.deps.offline && this.deps.offline()); } catch { return false; } }

  /** Konto für die Oberfläche – ohne Geheimnisse */
  publicAccount(a) {
    const live = this.live.get(a.id) || {};
    const au = a.auth || {};
    return {
      id: a.id, email: a.email, name: a.name, displayName: a.displayName || '', color: a.color, local: a.local || null, enabled: a.enabled !== false,
      imap: { host: a.imap.host, port: a.imap.port, security: a.imap.security, trusted: !!(a.imap.trust && a.imap.trust.fingerprint256) },
      smtp: a.smtp ? { host: a.smtp.host, port: a.smtp.port, security: a.smtp.security, trusted: !!(a.smtp.trust && a.smtp.trust.fingerprint256) } : null,
      auth: { type: au.type || 'password', user: au.user || a.email, hasPass: !!au.pass, oauth: au.oauth ? { clientId: au.oauth.clientId, issuer: au.oauth.issuer || '', hasToken: !!au.oauth.refreshToken } : null },
      aliases: a.aliases || [], signature: a.signature || '', notify: a.notify !== false, provider: a.provider || null, docs: a.docs || [], enable: a.enable || null,
      saveSent: a.saveSent || 'auto', status: live.status || (a.enabled === false ? 'off' : 'connecting'), error: live.error || null, unread: live.unread ?? null,
      gmail: !!live.gmail, createdAt: a.createdAt,
    };
  }

  overview() {
    const local = this.localServers();
    return {
      accounts: this.accountsCfg.map((a) => this.publicAccount(a)), prefs: this.prefsCfg, outbox: this.outbox.list(), cache: this.cache.stats(),
      offline: this.offline(), local, rules: this.rulesCfg.length, templates: this.templatesCfg.length,
    };
  }
  localServers() { try { return (this.deps.local && this.deps.local()) || []; } catch { return []; } }

  /* ---------- Anmeldung ---------- */
  async authFor(cfg) {
    const a = cfg.auth || {};
    if (a.type === 'oauth2') return { user: a.user || cfg.email, accessToken: await this.oauthToken(cfg) };
    const pass = this.secrets.open(a.pass);
    if (!pass && a.pass) throw err(401, 'The stored password can’t be decrypted on this PC – enter it again.', { code: 'auth' });
    return { user: a.user || cfg.email, pass };
  }
  async oauthToken(cfg) {
    const o = cfg.auth.oauth || {};
    const mem = this.tokens.get(cfg.id) || {};
    const r = await this.oauth.refresh({ clientId: o.clientId, clientSecret: this.secrets.open(o.clientSecret), tokenURL: o.tokenURL, scope: o.scope, refreshToken: this.secrets.open(o.refreshToken), accessToken: mem.accessToken, expires: mem.expires });
    this.tokens.set(cfg.id, { accessToken: r.accessToken, expires: r.expires });
    if (r.changed && r.refreshToken && r.refreshToken !== this.secrets.open(o.refreshToken)) { o.refreshToken = this.secrets.seal(r.refreshToken); this.saveAccounts(); }
    return r.accessToken;
  }

  /* ---------- Verbindungen ---------- */
  client(id) {
    let c = this.clients.get(id);
    if (c) return c;
    const cfg = this.account(id);
    c = new AccountClient(cfg, { auth: (x) => this.authFor(x), offline: () => this.offline() });
    c.on('state', ({ status, error }) => {
      const l = this.live.get(id) || {};
      this.live.set(id, { ...l, status, error, gmail: c.gmail });
      this.broadcast({ event: 'state', account: id, status, error });
    });
    c.on('ready', (d) => this.onReady(id, d).catch(() => { /* nächste Runde */ }));
    c.on('exists', (d) => this.onExists(id, d).catch(() => { /* nächste Runde */ }));
    let t = null;
    c.on('changed', () => { clearTimeout(t); t = setTimeout(() => { this.refreshUnread(id).catch(() => {}); this.broadcast({ event: 'changed', account: id, folder: 'INBOX' }); }, 800); if (t.unref) t.unref(); });
    this.clients.set(id, c);
    return c;
  }
  start() {
    if (this.started) return;
    this.started = true;
    for (const a of this.accountsCfg) if (a.enabled !== false) this.client(a.id).startWatch('INBOX');
    this.outbox.resume();
  }
  async stop() {
    this.started = false;
    this.notifier.stop();
    this.outbox.stop();
    this.cache.flush();
    this.contacts.flush();
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
  }
  /** Offline-Modus aus / Netz zurück: alle sofort neu versuchen */
  wakeAll() { for (const c of this.clients.values()) c.poke(); }

  async onReady(id, { client, uidNext, uidValidity }) {
    const st = this.stateCfg[id] || {};
    const lastNow = Math.max(0, Number(uidNext || 1) - 1);
    if (st.uidValidity !== uidValidity || st.lastUid == null) {
      this.stateCfg[id] = { uidValidity, lastUid: lastNow };
      this.saveState();
    } else if (lastNow > st.lastUid) {
      // Was während einer Unterbrechung kam: Regeln anwenden, gebündelt melden
      await this.onExists(id, { client });
    }
    await this.refreshUnread(id, client);
    this.broadcast({ event: 'changed', account: id, folder: 'INBOX' });
    this.queuePrefetch(id);
  }
  async refreshUnread(id, client = null) {
    const c = this.clients.get(id);
    const cl = client || (c && c.watchClient);
    if (!cl) return;
    const u = (await cl.search({ seen: false }, { uid: true })) || [];
    const l = this.live.get(id) || {};
    this.live.set(id, { ...l, unread: u.length });
    this.broadcast({ event: 'unread', account: id, unread: u.length, total: this.totalUnread() });
  }
  totalUnread() { return [...this.live.values()].reduce((n, l) => n + (l.unread || 0), 0); }

  /** Neue Mails nacheinander verarbeiten (mehrere EXISTS kurz hintereinander dürfen nichts doppelt melden) */
  onExists(id, d) {
    this.existsChain = this.existsChain || new Map();
    const next = (this.existsChain.get(id) || Promise.resolve()).then(() => this.processNew(id, d)).catch(() => {});
    this.existsChain.set(id, next);
    return next;
  }
  async processNew(id, { client }) {
    const st = this.stateCfg[id];
    if (!st) return;
    const c = this.client(id);
    const items = await c.since('INBOX', st.lastUid, { client });
    if (!items.length) return;
    st.lastUid = Math.max(st.lastUid, ...items.map((x) => x.uid));
    this.saveState();
    const cfg = this.account(id);
    const notifyList = [];
    for (const it of items) {
      this.contacts.add(it.from ? [it.from] : [], { at: it.date });
      let muted = cfg.notify === false || it.seen;
      for (const { actions } of evaluate(this.rulesCfg, it)) {
        for (const a of actions) {
          try {
            if (a.type === 'mute') muted = true;
            else if (a.type === 'read') { await c.flags('INBOX', [it.uid], { add: ['\\Seen'] }); muted = true; }
            else if (a.type === 'flag') await c.flags('INBOX', [it.uid], { add: ['\\Flagged'] });
            else if (a.type === 'move') { await c.move('INBOX', [it.uid], a.folder); muted = true; }
            else if (a.type === 'archive') { await this.moveRole(id, 'INBOX', [it.uid], 'archive'); muted = true; }
            else if (a.type === 'trash') { await this.moveRole(id, 'INBOX', [it.uid], 'trash'); muted = true; }
          } catch { /* eine Regel scheitert – die Mail bleibt im Posteingang */ }
        }
      }
      if (!muted) notifyList.push(it);
    }
    if (notifyList.length) this.notifier.push(notifyList);
    await this.refreshUnread(id, client).catch(() => {});
    this.broadcast({ event: 'new', account: id, count: items.length, folder: 'INBOX' });
    this.queuePrefetch(id);
  }

  /** Offline-Lesen: die neuesten Mails des Posteingangs im Hintergrund in den Zwischenspeicher holen */
  queuePrefetch(id) {
    if (!this.prefsCfg.prefetch || this.prefsCfg.cacheMB < 20) return;
    if (!this.prefetchQueue.includes(id)) this.prefetchQueue.push(id);
    if (this.prefetching) return;
    this.prefetching = true;
    const t = setTimeout(async () => {
      try {
        while (this.prefetchQueue.length && this.started) {
          const acc = this.prefetchQueue.shift();
          const page = await this.client(acc).list('INBOX', { size: 30 });
          this.storeList(acc, 'INBOX', page);
          for (const it of page.items) {
            if (!this.started) break;
            if (it.size > 2 * 1024 * 1024 || this.cache.has(it.key)) continue;
            await this.message(acc, 'INBOX', it.uid, { markRead: false }).catch(() => {});
          }
        }
      } catch { /* später erneut */ } finally { this.prefetching = false; }
    }, this.deps.prefetchDelay ?? 15000);
    if (t.unref) t.unref();
  }

  /* ---------- Konten einrichten ---------- */
  async discover(email) {
    return discover(email, { fetch: this.deps.fetch, offline: () => this.offline(), lang: this.deps.lang ? this.deps.lang() : 'de', resolveMx: this.deps.resolveMx, resolveSrv: this.deps.resolveSrv, probe: this.deps.probe, guess: this.deps.guess });
  }
  /** Eingaben prüfen und in ein Konto übersetzen (ohne zu speichern). existing = bisheriges Konto (Passwort behalten) */
  normalize(d, existing = null) {
    const email = String(d.email || (existing && existing.email) || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw err(400, 'That doesn’t look like an e-mail address.');
    const server = (s, kind, keep) => {
      if (!s) return keep || null;
      const host = String(s.host || '').trim().toLowerCase();
      const port = Number(s.port);
      const security = SECURITY.includes(s.security) ? s.security : 'tls';
      if (!/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/i.test(host)) throw err(400, kind === 'imap' ? 'The incoming server name isn’t valid.' : 'The outgoing server name isn’t valid.');
      if (!(port > 0 && port < 65536)) throw err(400, 'The port must be a number between 1 and 65535.');
      if (security === 'none' && !isLocal(host)) throw err(400, 'Without encryption Hostwerk only connects to mail servers on this PC or in your home network.');
      const sameServer = keep && keep.host === host && Number(keep.port) === port;
      return { host, port, security, trust: sameServer ? keep.trust || null : s.trust || null };
    };
    const a = d.auth || {};
    const type = a.type === 'oauth2' ? 'oauth2' : 'password';
    const prev = (existing && existing.auth) || {};
    const auth = { type, user: String(a.user || prev.user || email).trim() };
    if (type === 'password') auth.pass = a.pass ? this.secrets.seal(String(a.pass)) : prev.type === 'password' ? prev.pass : '';
    return {
      email, name: String(d.name || (existing && existing.name) || email).slice(0, 80), displayName: String(d.displayName ?? (existing && existing.displayName) ?? '').slice(0, 120),
      imap: server(d.imap, 'imap', existing && existing.imap), smtp: server(d.smtp, 'smtp', existing && existing.smtp), auth,
      prevOauth: type === 'oauth2' && prev.type === 'oauth2' ? prev.oauth : null,
    };
  }
  /** Zugang prüfen: IMAP anmelden und Ordner zählen; SMTP verbinden und anmelden (ohne zu senden) */
  async test(cfg) {
    const out = { imap: null, smtp: null };
    const ac = new AccountClient(cfg, { auth: (x) => this.authFor(x), offline: () => this.offline() });
    try { out.imap = await ac.verify(); } catch (e) { out.imap = { ok: false, error: classify(e) }; }
    if (cfg.smtp) {
      try {
        const { nodemailer } = require('./libs');
        const { tlsOptions } = require('./netutil');
        const auth = await this.authFor(cfg);
        const s = cfg.smtp;
        if (s.security === 'none' && !isLocal(s.host)) throw Object.assign(new Error('insecure'), { code: 'INSECURE' });
        const tr = nodemailer.createTransport({ host: s.host, port: Number(s.port), secure: s.security === 'tls', requireTLS: s.security === 'starttls', ignoreTLS: s.security === 'none', tls: tlsOptions(s, s.trust), connectionTimeout: 20000, greetingTimeout: 15000, name: 'hostwerk.local',
          auth: auth.accessToken ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : { user: auth.user, pass: auth.pass } });
        await tr.verify();
        tr.close();
        out.smtp = { ok: true };
      } catch (e) { out.smtp = { ok: false, error: classify(e) }; }
    }
    return out;
  }
  async addAccount(d) {
    const n = this.normalize(d);
    if (this.accountsCfg.some((a) => a.email === n.email && a.imap && n.imap && a.imap.host === n.imap.host)) throw err(409, 'This account is already connected.');
    if (!n.imap) throw err(400, 'The incoming server (IMAP) is missing.');
    await this.applyTrust(n, d);
    const cfg = { id: newId(6), ...n, color: d.color || COLORS[this.accountsCfg.length % COLORS.length], aliases: [], signature: '', notify: true, enabled: true, local: d.local || null,
      provider: d.provider || null, docs: Array.isArray(d.docs) ? d.docs.slice(0, 5) : [], enable: d.enable || null, createdAt: this.now() };
    delete cfg.prevOauth;
    if (n.auth.type === 'oauth2') {
      const r = d.oauthState ? this.oauth.take(d.oauthState) : null;
      if (!r || !r.ok) throw err(400, 'Sign in with the provider first.');
      cfg.auth.oauth = { clientId: r.cfg.clientId, clientSecret: r.cfg.clientSecret ? this.secrets.seal(r.cfg.clientSecret) : '', tokenURL: r.cfg.tokenURL, authURL: r.cfg.authURL, scope: r.cfg.scope, issuer: r.cfg.issuer || '', refreshToken: this.secrets.seal(r.tokens.refreshToken) };
      this.tokens.set(cfg.id, { accessToken: r.tokens.accessToken, expires: r.tokens.expires });
    }
    if (!d.skipTest) {
      const t = await this.test(cfg);
      if (!t.imap || !t.imap.ok) { const e = (t.imap && t.imap.error) || {}; throw err(400, e.text || 'The login didn’t work.', { result: t, code: e.code || 'auth', hint: e.detail || undefined }); }
      cfg.smtpChecked = !!(t.smtp && t.smtp.ok);
    }
    this.accountsCfg.push(cfg);
    this.saveAccounts();
    if (this.started) this.client(cfg.id).startWatch('INBOX');
    this.broadcast({ event: 'accounts' });
    return this.publicAccount(cfg);
  }
  async updateAccount(id, d) {
    const a = this.account(id);
    if (d.imap || d.smtp || d.auth || d.email) {
      const n = this.normalize({ ...d, email: d.email || a.email, auth: d.auth || { type: a.auth.type } }, a);
      a.email = n.email; a.imap = n.imap; a.smtp = n.smtp;
      if (n.auth.type === 'password') a.auth = n.auth;
      else if (d.oauthState) {
        const r = this.oauth.take(d.oauthState);
        if (!r || !r.ok) throw err(400, 'Sign in with the provider first.');
        a.auth = { type: 'oauth2', user: n.auth.user, oauth: { clientId: r.cfg.clientId, clientSecret: r.cfg.clientSecret ? this.secrets.seal(r.cfg.clientSecret) : '', tokenURL: r.cfg.tokenURL, authURL: r.cfg.authURL, scope: r.cfg.scope, issuer: r.cfg.issuer || '', refreshToken: this.secrets.seal(r.tokens.refreshToken) } };
        this.tokens.set(id, { accessToken: r.tokens.accessToken, expires: r.tokens.expires });
      }
    }
    for (const k of ['name', 'displayName', 'color', 'signature', 'saveSent']) if (d[k] !== undefined) a[k] = String(d[k]).slice(0, k === 'signature' ? 20000 : 120);
    if (d.notify !== undefined) a.notify = !!d.notify;
    if (d.aliases) a.aliases = [].concat(d.aliases).filter((x) => x && /^[^@\s]+@[^@\s]+$/.test(x.address || '')).map((x) => ({ name: String(x.name || '').slice(0, 120), address: String(x.address).toLowerCase() })).slice(0, 20);
    const was = a.enabled !== false;
    if (d.enabled !== undefined) a.enabled = !!d.enabled;
    this.saveAccounts();
    const c = this.clients.get(id);
    if (c) { c.setConfig(a); if (d.imap || d.auth || d.enabled === false || (was && d.enabled === false)) await c.close(); }
    if (d.imap || d.auth || d.enabled !== undefined) { this.clients.delete(id); this.live.delete(id); if (this.started && a.enabled !== false) this.client(id).startWatch('INBOX'); }
    this.folderCache.delete(id);
    this.broadcast({ event: 'accounts' });
    return this.publicAccount(a);
  }
  /** Konto in Hostwerk vergessen – auf dem Mail-Server wird NICHTS gelöscht */
  async removeAccount(id) {
    this.account(id);
    const c = this.clients.get(id);
    if (c) await c.close();
    this.clients.delete(id); this.live.delete(id); this.tokens.delete(id); this.folderCache.delete(id);
    this.accountsCfg = this.accountsCfg.filter((a) => a.id !== id);
    delete this.stateCfg[id];
    this.saveAccounts(); this.saveState();
    this.cache.dropAccount(id);
    this.rulesCfg = this.rulesCfg.map((r) => (r.account === id ? { ...r, on: false, account: '*' } : r));
    writeJson(this.f('rules.json'), this.rulesCfg);
    this.broadcast({ event: 'accounts' });
    return { ok: true };
  }
  reorder(ids) {
    const pos = new Map([].concat(ids || []).map((x, i) => [x, i]));
    this.accountsCfg.sort((a, b) => (pos.get(a.id) ?? 999) - (pos.get(b.id) ?? 999));
    this.saveAccounts();
    return { ok: true };
  }
  reconnect(id) { const c = this.client(id); c.poke(); if (!c.watching && this.started) c.startWatch('INBOX'); return { ok: true }; }

  /** Zertifikat ansehen (für die Rückfrage) */
  async certificate(id, kind) {
    const a = this.account(id);
    const s = kind === 'smtp' ? a.smtp : a.imap;
    if (!s) throw err(400, 'No server.');
    return peekCertificate(s, kind === 'smtp' ? 'smtp' : 'imap');
  }
  /** Genau diesem Zertifikat vertrauen – nur, wenn der Fingerabdruck dem entspricht, den der Mensch gesehen hat */
  async trust(id, kind, fingerprint256) {
    const a = this.account(id);
    const s = kind === 'smtp' ? a.smtp : a.imap;
    const c = await peekCertificate(s, kind === 'smtp' ? 'smtp' : 'imap');
    if (!fingerprint256 || c.fingerprint256 !== fingerprint256) throw err(409, 'The certificate changed in the meantime – look at it again.');
    s.trust = { fingerprint256: c.fingerprint256, pem: c.pem, at: this.now() };
    this.saveAccounts();
    if (kind !== 'smtp') { const cl = this.clients.get(id); if (cl) { cl.setConfig(a); await cl.close(); this.clients.delete(id); if (this.started) this.client(id).startWatch('INBOX'); } }
    return { ok: true };
  }
  untrust(id, kind) { const a = this.account(id); const s = kind === 'smtp' ? a.smtp : a.imap; if (s) s.trust = null; this.saveAccounts(); return { ok: true }; }

  /** OAuth starten: Endpunkte aus dem Ergebnis der Suche (ISPDB) oder vom Aussteller (OpenID) */
  async oauthStart({ email, clientId, clientSecret, authURL, tokenURL, scope, issuer, redirectUri }) {
    let a = authURL; let t = tokenURL;
    if ((!a || !t) && issuer) { const o = await oidcEndpoints(issuer, { fetch: this.deps.fetch }); if (o) { a = a || o.authURL; t = t || o.tokenURL; } }
    if (!a || !t) throw err(400, 'The sign-in addresses (OAuth) of this provider are unknown – enter them under “Advanced”.');
    return this.oauth.start({ email, clientId: String(clientId || '').trim(), clientSecret: String(clientSecret || '').trim(), authURL: a, tokenURL: t, scope, issuer, redirectUri });
  }

  /** Beim Einrichten bewusst vertrautes Zertifikat übernehmen – nur, wenn es noch genau das gesehene ist */
  async applyTrust(n, d) {
    for (const kind of ['imap', 'smtp']) {
      const fp = d[kind] && d[kind].trustFingerprint;
      if (!fp || !n[kind]) continue;
      const c = await peekCertificate(n[kind], kind);
      if (c.fingerprint256 !== fp) throw err(409, 'The certificate changed in the meantime – look at it again.');
      n[kind].trust = { fingerprint256: c.fingerprint256, pem: c.pem, at: this.now() };
    }
  }
  /** Zertifikat eines Servers ansehen, bevor es ein Konto gibt (Einrichtung) */
  async peek({ host, port, security, kind }) {
    const s = this.normalize({ email: 'x@x.x', imap: { host, port, security } }).imap;
    return peekCertificate(s, kind === 'smtp' ? 'smtp' : 'imap');
  }

  /* ---------- Ordner ---------- */
  async folders(id, { fresh = false } = {}) {
    const hit = this.folderCache.get(id);
    if (hit && !fresh && this.now() - hit.at < 60000) return hit.list;
    try {
      const list = await this.client(id).folders();
      this.folderCache.set(id, { at: this.now(), list });
      this.cache.putList(id, '\u0000folders', { list });
      return list;
    } catch (e) {
      const c = this.cache.getList(id, '\u0000folders');
      if (c && c.list) return c.list;
      throw e;
    }
  }
  async roleFolder(id, role) {
    const list = await this.folders(id);
    if (role === 'inbox') return 'INBOX';
    const hit = list.find((f) => f.role === role) || (role === 'archive' ? list.find((f) => f.role === 'all') : null);
    return hit ? hit.path : null;
  }
  async folderAction(id, { action, path: p, to }) {
    const c = this.client(id);
    if (action === 'create') await c.createFolder(String(p));
    else if (action === 'rename') await c.renameFolder(String(p), String(to));
    else if (action === 'delete') {
      const f = (await this.folders(id)).find((x) => x.path === p);
      if (f && f.role) throw err(400, 'Hostwerk doesn’t delete special folders (inbox, sent, trash …).');
      await c.deleteFolder(String(p));
    } else throw err(400, 'Unknown action.');
    this.folderCache.delete(id);
    return this.folders(id, { fresh: true });
  }

  /* ---------- Listen ---------- */
  storeList(id, folder, page) {
    if (page.uidValidity) {
      const k = `${id}|${folder}`;
      const before = this.uidValidity.get(k);
      if (before && before !== page.uidValidity) for (const [key, e] of Object.entries(this.cache.index)) if (e.account === id && e.folder === folder) this.cache.drop(key);
      this.uidValidity.set(k, page.uidValidity);
    }
    this.cache.putList(id, folder, { total: page.total, items: page.items, uidValidity: page.uidValidity });
  }
  /** Snippets aus dem Zwischenspeicher dazulegen (Vorschauzeile) */
  withSnippets(items) {
    return items.map((it) => { const e = this.cache.index[it.key]; return e && e.text ? { ...it, snippet: e.text.replace(/\s+/g, ' ').slice(0, 140), cached: true } : it; });
  }
  async messages({ account, folder = 'INBOX', page = 0, size = 50, filter = {}, q = '' }) {
    size = Math.max(10, Math.min(200, Number(size) || 50));
    page = Math.max(0, Number(page) || 0);
    if (account === 'all') return this.unified({ page, size, filter, q });
    this.account(account);
    const plain = !q && !Object.values(filter).some(Boolean);
    try {
      const r = await this.client(account).list(folder, { page, size, filter, q });
      if (plain && page === 0) this.storeList(account, folder, r);
      const local = q ? this.cache.search(q, { account, folder }).filter((x) => !r.items.some((y) => y.key === x.key)) : [];
      return { total: r.total, items: this.withSnippets(r.items), threads: this.prefsCfg.threads ? this.threadList(r.items) : null, local, page, size };
    } catch (e) {
      const c = this.cache.getList(account, folder);
      if (c && (e.code === 'offline' || e.code === 'network' || e.code === 'timeout' || e.code === 'dns' || this.offline())) {
        let items = c.items || [];
        if (q) { const hits = new Set(this.cache.search(q, { account, folder }).map((x) => x.key)); items = items.filter((x) => hits.has(x.key) || String(x.subject).toLowerCase().includes(String(q).toLowerCase())); }
        if (filter.unread) items = items.filter((x) => !x.seen);
        if (filter.flagged) items = items.filter((x) => x.flagged);
        if (filter.attachments) items = items.filter((x) => x.attachment);
        return { total: items.length, items: this.withSnippets(items), threads: this.prefsCfg.threads ? this.threadList(items) : null, offline: true, at: c.at, error: classify(e), page, size };
      }
      throw e;
    }
  }
  threadList(items) {
    return threads(items).filter((g) => g.items.length > 1).map((g) => ({ key: g.key, keys: g.items.map((x) => x.key) }));
  }
  /** Alle Posteingänge zusammen (neueste zuerst) – je Konto die gleiche Seite, dann gemischt */
  async unified({ page, size, filter, q }) {
    const accs = this.accountsCfg.filter((a) => a.enabled !== false);
    const res = await Promise.allSettled(accs.map((a) => this.messages({ account: a.id, folder: 'INBOX', page: 0, size: size * (page + 1), filter, q })));
    let items = []; let total = 0; const errors = []; let local = [];
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') { items.push(...r.value.items); total += r.value.total; local = local.concat(r.value.local || []); if (r.value.offline) errors.push({ account: accs[i].id, ...(r.value.error || {}), offline: true }); }
      else errors.push({ account: accs[i].id, ...classify(r.reason), text: r.reason.message });
    });
    items.sort((a, b) => (b.date || 0) - (a.date || 0));
    items = items.slice(page * size, (page + 1) * size);
    return { total, items, threads: this.prefsCfg.threads ? this.threadList(items) : null, errors, local: local.slice(0, 50), page, size, unified: true };
  }

  /* ---------- Lesen ---------- */
  async message(account, folder, uid, { images = false, markRead = this.prefsCfg.markReadOnOpen } = {}) {
    const key = `${account}|${folder}|${uid}`;
    let view = images ? null : this.cache.get(key);
    let raw = null;
    let flags = null;
    if (!view) {
      try {
        const r = await this.client(account).source(folder, uid);
        raw = r.raw; flags = r.flags;
        const trusted = images || this.isTrustedSender(raw);
        view = await parseMessage(raw, { remote: trusted, lang: this.deps.lang ? this.deps.lang() : 'de' });
        view.imagesLoaded = trusted && view.remoteImages > 0;
        if (!images || !this.cache.has(key)) this.cache.put(key, raw, view, { account, folder, uid: Number(uid), subject: view.subject, from: view.from ? `${view.from.name} ${view.from.address}` : '', date: view.date });
      } catch (e) {
        const cached = this.cache.get(key);
        if (cached) return { ...cached, key, account, folder, uid: Number(uid), offline: true };
        throw e;
      }
    }
    if (markRead && !(flags && flags.includes('\\Seen'))) {
      this.client(account).flags(folder, [uid], { add: ['\\Seen'] }).then(() => { if (folder === 'INBOX') this.refreshUnread(account).catch(() => {}); }).catch(() => { /* offline: bleibt ungelesen */ });
    }
    return { ...view, key, account, folder, uid: Number(uid), flags };
  }
  isTrustedSender(raw) {
    const list = this.prefsCfg.trustedSenders || [];
    if (!list.length) return false;
    const m = /^from:.*?([\w.+-]+@[\w.-]+)/im.exec(String(raw.slice(0, 16384)));
    const addr = m ? m[1].toLowerCase() : '';
    return !!addr && list.some((x) => x === addr || (x.startsWith('@') && addr.endsWith(x)));
  }
  async rawOf(account, folder, uid) {
    const key = `${account}|${folder}|${uid}`;
    const c = this.cache.raw(key);
    if (c) return c;
    return (await this.client(account).source(folder, uid)).raw;
  }
  async attachment(account, folder, uid, i) {
    const a = await attachment(await this.rawOf(account, folder, uid), i);
    if (!a) throw err(404, 'This attachment doesn’t exist.');
    return a;
  }

  /* ---------- Ändern ---------- */
  /** items: [{ account, folder, uid }] → nach Konto+Ordner gruppiert */
  groups(items) {
    const g = new Map();
    for (const it of [].concat(items || [])) {
      if (!it || !it.account || !it.folder || !(Number(it.uid) > 0)) continue;
      const k = `${it.account}\u0000${it.folder}`;
      if (!g.has(k)) g.set(k, { account: it.account, folder: it.folder, uids: [] });
      g.get(k).uids.push(Number(it.uid));
    }
    if (!g.size) throw err(400, 'No mails selected.');
    return [...g.values()];
  }
  async setFlags(items, { add = [], remove = [] }) {
    const ok = (f) => /^(\\(Seen|Flagged|Answered|Draft)|\$Forwarded|\$Junk|\$NotJunk)$/.test(f);
    add = [].concat(add).filter(ok); remove = [].concat(remove).filter(ok);
    for (const g of this.groups(items)) {
      await this.client(g.account).flags(g.folder, g.uids, { add, remove });
      if (g.folder === 'INBOX') this.refreshUnread(g.account).catch(() => {});
    }
    return { ok: true };
  }
  async moveRole(account, folder, uids, role) {
    let dest = await this.roleFolder(account, role);
    if (!dest && role === 'archive') {
      // Kein Archiv-Ordner: einmal anlegen („Archive“ ist der Name, den die meisten Programme erkennen)
      dest = 'Archive';
      try { await this.client(account).createFolder(dest); } catch { /* gibt es schon */ }
      this.folderCache.delete(account);
    }
    if (!dest) throw err(409, role === 'trash' ? 'This account has no trash folder.' : role === 'junk' ? 'This account has no spam folder.' : 'Folder not found.');
    if (dest === folder) return { ok: true, same: true };
    await this.client(account).move(folder, uids, dest);
    for (const u of uids) this.cache.drop(`${account}|${folder}|${u}`);
    return { ok: true, dest };
  }
  async move(items, { folder, role }) {
    const out = [];
    for (const g of this.groups(items)) {
      if (role) out.push(await this.moveRole(g.account, g.folder, g.uids, role));
      else { await this.client(g.account).move(g.folder, g.uids, String(folder)); for (const u of g.uids) this.cache.drop(`${g.account}|${g.folder}|${u}`); out.push({ ok: true, dest: folder }); }
      if (g.folder === 'INBOX') this.refreshUnread(g.account).catch(() => {});
    }
    this.broadcast({ event: 'changed' });
    return { ok: true, results: out };
  }
  /** Löschen: in den Papierkorb – liegt die Mail schon dort (oder im Spam) oder permanent=true, endgültig */
  async remove(items, { permanent = false } = {}) {
    for (const g of this.groups(items)) {
      const trash = await this.roleFolder(g.account, 'trash');
      const junk = await this.roleFolder(g.account, 'junk');
      if (permanent || !trash || g.folder === trash || g.folder === junk) {
        if (!permanent && !trash) throw err(409, 'This account has no trash folder – delete permanently?', { code: 'NO_TRASH' });
        await this.client(g.account).expunge(g.folder, g.uids);
        for (const u of g.uids) this.cache.drop(`${g.account}|${g.folder}|${u}`);
      } else await this.moveRole(g.account, g.folder, g.uids, 'trash');
      if (g.folder === 'INBOX') this.refreshUnread(g.account).catch(() => {});
    }
    this.broadcast({ event: 'changed' });
    return { ok: true };
  }

  /* ---------- Schreiben ---------- */
  /** Vorbefüllter Entwurf für Antworten/Weiterleiten */
  async compose({ mode, account, folder, uid }) {
    const m = await this.message(account, folder, uid, { markRead: false });
    const a = this.account(account);
    const own = new Set([a.email, ...(a.aliases || []).map((x) => x.address)].map((x) => x.toLowerCase()));
    // Antwort-Absender: die eigene Adresse/Alias, an die die Mail ging
    const hitAlias = [...(m.to || []), ...(m.cc || [])].find((x) => own.has(x.address));
    const from = hitAlias ? { name: (a.aliases || []).find((x) => x.address === hitAlias.address)?.name || a.displayName || '', address: hitAlias.address } : { name: a.displayName || '', address: a.email };
    const who = m.from ? m.from.name || m.from.address : '';
    const date = m.date ? new Date(m.date) : null;
    const lang = this.deps.lang ? this.deps.lang() : 'de';
    const when = date ? date.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const strip = (s) => String(s || '').replace(/\sdata-hw-[a-z-]+="[^"]*"/g, '');
    const d = { account, from, to: [], cc: [], bcc: [], subject: '', html: '', text: '', attachments: [], inReplyTo: '', references: [], mode, origin: { account, folder, uid: Number(uid) } };
    if (mode === 'forward') {
      d.subject = /^(fwd?|wg):/i.test(m.subject) ? m.subject : `${lang === 'en' ? 'Fwd' : 'WG'}: ${m.subject}`;
      const head = `<p>${esc(this.t('-------- Forwarded message --------'))}<br>${esc(this.t('From'))}: ${esc(m.from ? `${m.from.name} <${m.from.address}>` : '')}<br>${esc(this.t('Date'))}: ${esc(when)}<br>${esc(this.t('Subject'))}: ${esc(m.subject)}<br>${esc(this.t('To'))}: ${esc((m.to || []).map((x) => x.address).join(', '))}</p>`;
      d.html = `<p></p>${head}<div>${strip(m.html)}</div>`;
      d.attachments = (m.attachments || []).map((x) => ({ ref: { account, folder, uid: Number(uid), i: x.i }, filename: x.filename, contentType: x.contentType, size: x.size }));
    } else {
      d.subject = /^(re|aw):/i.test(m.subject) ? m.subject : `${lang === 'en' ? 'Re' : 'AW'}: ${m.subject}`;
      const replyTo = m.replyTo && m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
      d.to = replyTo.filter((x) => !own.has(x.address));
      if (!d.to.length) d.to = m.to || [];
      if (mode === 'replyAll') {
        const seen = new Set(d.to.map((x) => x.address).concat([...own]));
        d.cc = [...(m.to || []), ...(m.cc || [])].filter((x) => x.address && !seen.has(x.address) && seen.add(x.address));
      }
      d.inReplyTo = m.messageId;
      d.references = [...(m.references || []), m.messageId].filter(Boolean).slice(-20);
      d.html = `<p></p><div class="hw-quote"><p>${esc(this.t('On {date}, {name} wrote:', { date: when, name: who }))}</p><blockquote type="cite">${strip(m.html)}</blockquote></div>`;
      d.text = `\n\n${this.t('On {date}, {name} wrote:', { date: when, name: who })}\n${String(m.text || '').split('\n').map((l) => `> ${l}`).join('\n')}`;
    }
    return d;
  }
  /** Anhänge aus anderen Mails (Weiterleiten) und hochgeladene auflösen */
  async resolveAttachments(list) {
    const out = [];
    let total = 0;
    for (const x of [].concat(list || [])) {
      if (x.ref) { const a = await this.attachment(x.ref.account, x.ref.folder, x.ref.uid, x.ref.i); total += a.content.length; out.push({ filename: a.filename, contentType: a.contentType, content: a.content }); }
      else if (x.data) { const buf = Buffer.from(String(x.data), 'base64'); total += buf.length; out.push({ filename: String(x.filename || 'attachment').slice(0, 200), contentType: String(x.contentType || 'application/octet-stream'), content: buf, cid: x.cid }); }
      if (total > 35 * 1024 * 1024) throw err(413, 'Attachments are too big together (at most 35 MB – most providers take 25 MB).');
    }
    return out;
  }
  prepDraft(d) {
    const a = this.account(d.account);
    const fromAddr = String((d.from && d.from.address) || a.email).toLowerCase();
    const allowed = [a.email, ...(a.aliases || []).map((x) => x.address)];
    if (!allowed.includes(fromAddr)) throw err(400, 'This sender address doesn’t belong to the account – add it as an alias first.');
    const html = d.format === 'text' ? null : String(d.html || '');
    const text = d.format === 'text' ? String(d.text || '') : undefined;
    return { a, draft: { ...d, from: { name: (d.from && d.from.name) || a.displayName || '', address: fromAddr }, html: html || (text ? null : ''), text } };
  }
  async send(d) {
    const { a, draft } = this.prepDraft(d);
    const rcpt = [...[].concat(draft.to || []), ...[].concat(draft.cc || []), ...[].concat(draft.bcc || [])];
    if (!rcpt.length) throw err(400, 'Add at least one recipient.');
    if (!a.smtp) throw err(400, 'This account has no outgoing server.');
    const attachments = await this.resolveAttachments(draft.attachments);
    const built = await build({ ...draft, html: draft.html || (draft.text != null ? textToHtml(draft.text) : ''), attachments }, { hostname: a.email.split('@')[1] });
    const delay = d.delay !== undefined ? Number(d.delay) : Math.max(0, Math.min(60, Number(this.prefsCfg.undoSeconds) || 0)) * 1000;
    const it = this.outbox.add({ account: a.id, raw: built.raw, envelope: built.envelope, draft: { ...d, attachments: (d.attachments || []).map((x) => (x.ref ? x : { ...x })) }, delay, meta: { origin: d.origin || null, mode: d.mode || null, draftRef: d.draftRef || null, messageId: built.messageId } });
    this.contacts.add(rcpt, { sent: true });
    this.broadcast({ event: 'outbox' });
    return { id: it.id, sendAt: it.sendAt };
  }
  async deliver(it) {
    const a = this.account(it.account);
    const auth = await this.authFor(a);
    await smtpSend(a.smtp, auth, { raw: it.raw, envelope: it.envelope }, { offline: () => this.offline() });
    // Gesendet ablegen (Gmail legt selbst ab), Original als beantwortet/weitergeleitet markieren, Entwurf löschen
    const live = this.live.get(a.id) || {};
    const selfSaves = a.saveSent === 'never' || (a.saveSent !== 'always' && live.gmail);
    if (!selfSaves) { try { const sent = await this.roleFolder(a.id, 'sent'); if (sent) await this.client(a.id).append(sent, it.raw, ['\\Seen']); } catch { /* Senden hat geklappt – Ablegen ist Zugabe */ } }
    const o = it.meta && it.meta.origin;
    if (o && o.account === a.id) await this.client(a.id).flags(o.folder, [o.uid], { add: [it.meta.mode === 'forward' ? '$Forwarded' : '\\Answered'] }).catch(() => {});
    const dr = it.meta && it.meta.draftRef;
    if (dr && dr.account === a.id) await this.client(a.id).expunge(dr.folder, [dr.uid]).catch(() => {});
  }
  onOutbox(type, it) {
    this.broadcast({ event: 'outbox', state: type, id: it.id });
    if (type === 'failed' && this.deps.notify) { try { this.deps.notify({ title: this.t('A mail couldn’t be sent'), text: `${(it.draft && it.draft.subject) || this.t('(no subject)')} – ${this.t(it.error.text)}`, kind: 'error' }); } catch { /* egal */ } }
  }
  /** Entwurf auf dem Server speichern (ersetzt den vorigen Stand) → { folder, uid } */
  async saveDraft(d) {
    const { a, draft } = this.prepDraft(d);
    const folder = await this.roleFolder(a.id, 'drafts');
    if (!folder) throw err(409, 'This account has no drafts folder.');
    const attachments = await this.resolveAttachments(draft.attachments);
    const built = await build({ ...draft, html: draft.html || (draft.text != null ? textToHtml(draft.text) : ''), attachments, keepBcc: true }, { hostname: a.email.split('@')[1] });
    const r = await this.client(a.id).append(folder, built.raw, ['\\Draft', '\\Seen']);
    const prev = d.draftRef;
    if (prev && prev.account === a.id && prev.uid) await this.client(a.id).expunge(prev.folder, [prev.uid]).catch(() => {});
    return { account: a.id, folder, uid: r && r.uid ? r.uid : null };
  }
  /** Gespeicherten Entwurf wieder öffnen */
  async openDraft(account, folder, uid) {
    const m = await this.message(account, folder, uid, { markRead: false });
    return {
      account, from: { name: '', address: (this.account(account).email) }, to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, html: m.plain ? '' : m.html, text: m.plain ? m.text : '',
      format: m.plain ? 'text' : 'html', inReplyTo: m.inReplyTo, references: m.references, attachments: (m.attachments || []).map((x) => ({ ref: { account, folder, uid: Number(uid), i: x.i }, filename: x.filename, contentType: x.contentType, size: x.size })),
      draftRef: { account, folder, uid: Number(uid) },
    };
  }

  /* ---------- Abmelden (List-Unsubscribe) ---------- */
  async unsubscribe(account, folder, uid) {
    const m = await this.message(account, folder, uid, { markRead: false });
    const u = m.unsubscribe;
    if (!u) throw err(404, 'This mail has no unsubscribe link.');
    if (u.oneClick && u.http) {
      if (this.offline()) throw err(409, 'Offline mode is on.');
      // RFC 8058: POST mit festem Inhalt, ohne Cookies – öffnet keine Seite und bestätigt nichts anderes
      const r = await (this.deps.fetch || globalThis.fetch)(u.http, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click', redirect: 'manual' });
      return { ok: r.status < 400, done: true, status: r.status };
    }
    return { ok: true, done: false, http: u.http, mailto: u.mailto };
  }

  /* ---------- KI (nur mit Zustimmung) ---------- */
  async ai(task, { account, folder, uid, lang }) {
    if (!this.prefsCfg.aiConsent) throw err(403, 'Allow the AI help in the settings first.');
    const ai = this.deps.ai;
    if (!ai || !(await ai.ready())) throw err(409, 'The AI assistant isn’t ready – set it up under AI in Hostwerk.');
    if (!['summarize', 'translate', 'explain'].includes(task)) throw err(400, 'Unknown task.');
    const m = await this.message(account, folder, uid, { markRead: false });
    const text = `${this.t('Subject')}: ${m.subject}\n${this.t('From')}: ${m.from ? m.from.name || m.from.address : ''}\n\n${String(m.text || '').slice(0, 5600)}`;
    const ctx = task === 'explain' ? 'An e-mail. Explain briefly what the sender wants from me and what I should do.' : 'An e-mail.';
    return ai.run(task, { text, lang: lang === 'en' ? 'en' : 'de', context: ctx });
  }

  /* ---------- Einstellungen, Regeln, Vorlagen ---------- */
  setPrefs(p) {
    const n = { ...this.prefsCfg };
    if (p.notify !== undefined) n.notify = !!p.notify;
    if (p.quiet) n.quiet = { on: !!p.quiet.on, from: /^\d{1,2}:\d{2}$/.test(p.quiet.from) ? p.quiet.from : n.quiet.from, to: /^\d{1,2}:\d{2}$/.test(p.quiet.to) ? p.quiet.to : n.quiet.to };
    if (p.cacheMB !== undefined) { n.cacheMB = Math.max(0, Math.min(20000, Number(p.cacheMB) || 0)); this.cache.setLimit(n.cacheMB || 1); }
    for (const k of ['markReadOnOpen', 'threads', 'aiConsent', 'prefetch']) if (p[k] !== undefined) n[k] = !!p[k];
    if (p.undoSeconds !== undefined) n.undoSeconds = Math.max(0, Math.min(60, Number(p.undoSeconds) || 0));
    if (p.composeFormat) n.composeFormat = p.composeFormat === 'text' ? 'text' : 'html';
    if (p.density) n.density = p.density === 'compact' ? 'compact' : 'normal';
    if (p.trustedSenders) n.trustedSenders = [].concat(p.trustedSenders).map((x) => String(x).toLowerCase().trim()).filter((x) => /^(@[\w.-]+|[^@\s]+@[\w.-]+)$/.test(x)).slice(0, 500);
    this.prefsCfg = n;
    writeJson(this.f('prefs.json'), n);
    return n;
  }
  trustSender(address) { const a = String(address || '').toLowerCase(); if (!a) return this.prefsCfg; return this.setPrefs({ trustedSenders: [...new Set([...(this.prefsCfg.trustedSenders || []), a])] }); }
  setRules(list) {
    const out = [].concat(list || []).slice(0, 100).map((r) => ({ ...cleanRule(r), id: r.id || newId(4) }));
    this.rulesCfg = out;
    writeJson(this.f('rules.json'), out);
    return out;
  }
  /** Regeln jetzt auf die letzten Mails im Posteingang anwenden → Anzahl Treffer */
  async runRules(account, { limit = 200 } = {}) {
    let hits = 0;
    for (const a of this.accountsCfg.filter((x) => (account ? x.id === account : x.enabled !== false))) {
      const page = await this.client(a.id).list('INBOX', { size: limit });
      for (const it of page.items) {
        for (const { actions } of evaluate(this.rulesCfg, it)) {
          hits++;
          for (const x of actions) {
            if (x.type === 'read') await this.client(a.id).flags('INBOX', [it.uid], { add: ['\\Seen'] });
            else if (x.type === 'flag') await this.client(a.id).flags('INBOX', [it.uid], { add: ['\\Flagged'] });
            else if (x.type === 'move') await this.client(a.id).move('INBOX', [it.uid], x.folder);
            else if (x.type === 'archive' || x.type === 'trash') await this.moveRole(a.id, 'INBOX', [it.uid], x.type);
          }
        }
      }
      await this.refreshUnread(a.id).catch(() => {});
    }
    this.broadcast({ event: 'changed' });
    return { hits };
  }
  setTemplates(list) {
    const out = [].concat(list || []).slice(0, 100).map((x) => ({ id: x.id || newId(4), name: String(x.name || '').slice(0, 80) || this.t('Template'), subject: String(x.subject || '').slice(0, 300), html: String(x.html || '').slice(0, 100000) }));
    this.templatesCfg = out;
    writeJson(this.f('templates.json'), out);
    return out;
  }

  /* ---------- Export ---------- */
  /** Ordner als mbox (mboxrd) in einen Strom schreiben */
  async exportMbox(account, folder, write) {
    const asctime = (d) => { const x = d ? new Date(d) : new Date(); return x.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4'); };
    return this.client(account).each(folder, async (raw, meta) => {
      const from = (meta.from && meta.from.address) || 'MAILER-DAEMON';
      const body = raw.toString('binary').replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1');
      await write(Buffer.from(`From ${from} ${asctime(meta.date)}\n${body}${body.endsWith('\n') ? '' : '\n'}\n`, 'binary'));
    });
  }

  /* ---------- Sicherung ---------- */
  backupDir() { return this.f('backups'); }
  /** Stand der Einstellungen (Konten mit verschlüsselten Geheimnissen, Regeln, Vorlagen, Signaturen) – höchstens einmal am Tag, 10 behalten */
  snapshot({ force = false } = {}) {
    const dir = this.backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const data = { v: 1, at: this.now(), accounts: this.accountsCfg, prefs: this.prefsCfg, rules: this.rulesCfg, templates: this.templatesCfg };
    const files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort();
    const last = files.length ? readJson(path.join(dir, files[files.length - 1]), null) : null;
    const same = last && JSON.stringify({ ...last, at: 0 }) === JSON.stringify({ ...data, at: 0 });
    if (!force && (same || (last && this.now() - last.at < 20 * 3600000))) return null;
    const id = String(this.now());
    writeJson(path.join(dir, `${id}.json`), data);
    for (const f of files.slice(0, Math.max(0, files.length + 1 - 10))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* egal */ } }
    return id;
  }
  backups() {
    const dir = this.backupDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => {
      const id = f.replace(/\.json$/, '');
      const st = fs.statSync(path.join(dir, f));
      const n = (readJson(path.join(dir, f), {}).accounts || []).length;
      return { id, t: Number(id), size: st.size, label: this.t('Accounts and settings ({n} accounts)', { n }), auto: true };
    }).sort((a, b) => b.t - a.t);
  }
  async restoreBackup(id) {
    const f = path.join(this.backupDir(), `${String(id).replace(/\D/g, '')}.json`);
    const data = readJson(f, null);
    if (!data || !Array.isArray(data.accounts)) throw err(404, 'This backup doesn’t exist.');
    this.snapshot({ force: true });
    const wasStarted = this.started;
    await this.stop();
    this.accountsCfg = data.accounts; this.prefsCfg = { ...DEFAULT_PREFS, ...(data.prefs || {}) }; this.rulesCfg = data.rules || []; this.templatesCfg = data.templates || [];
    this.saveAccounts(); writeJson(this.f('prefs.json'), this.prefsCfg); writeJson(this.f('rules.json'), this.rulesCfg); writeJson(this.f('templates.json'), this.templatesCfg);
    this.stateCfg = {}; this.saveState();
    this.live.clear(); this.folderCache.clear();
    this.outbox = new Outbox({ dir: this.dir, now: this.now, send: (it) => this.deliver(it), onEvent: (type, it) => this.onOutbox(type, it) });
    if (wasStarted) this.start();
    this.broadcast({ event: 'accounts' });
    return { ok: true };
  }
  removeBackup(id) { try { fs.unlinkSync(path.join(this.backupDir(), `${String(id).replace(/\D/g, '')}.json`)); } catch { /* weg */ } return { ok: true }; }
}

module.exports = { MailService, DEFAULT_PREFS, baseSubject };
