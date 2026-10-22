'use strict';
/*
 * IMAP je Konto (imapflow, gebündelt):
 *   ops    eine Verbindung für Aktionen (Liste, Lesen, Markieren, Verschieben …) – wird bei Bedarf geöffnet, nach
 *          5 Minuten ohne Arbeit geschlossen, bei Abbruch beim nächsten Aufruf neu aufgebaut
 *   watch  eine Verbindung, die den Posteingang mit IDLE beobachtet (Push statt Abfragen). Bricht sie ab, baut sie sich
 *          mit wachsendem Abstand neu auf (2 s … 5 min, mit Zufall); bei falschem Passwort erst nach 30 min oder auf Knopfdruck
 *          – sonst sperrt der Anbieter das Konto. Offline-Modus: wartet still.
 * Ereignisse: 'state' ({ status, error }), 'exists' (neue Mails im Posteingang), 'changed' (Flags/Löschungen).
 */
const { EventEmitter } = require('events');
const { ImapFlow } = require('./libs');
const { classify, tlsOptions, isLocal } = require('./netutil');
const { fromEnvelope } = require('./message');

const LIST_HEADERS = ['content-type', 'references', 'list-unsubscribe', 'list-id'];
const IDLE_CLOSE = 5 * 60 * 1000;
const MAX_SOURCE = 40 * 1024 * 1024;

/** Such-Bedingung aus Filtern → imapflow-Suchobjekt (oder null = alles) */
function criteria({ unread, flagged, attachments, from, since } = {}, q = '', gmail = false) {
  const c = {};
  if (unread) c.seen = false;
  if (flagged) c.flagged = true;
  if (from) c.from = String(from);
  if (attachments) c.header = { 'content-type': 'multipart/mixed' };
  if (since) c.since = new Date(since);
  const qs = String(q || '').trim();
  if (qs) { if (gmail) c.gmraw = qs; else c.or = [{ subject: qs }, { from: qs }, { to: qs }, { body: qs }]; }
  return Object.keys(c).length ? c : null;
}

class AccountClient extends EventEmitter {
  /**
   * cfg: Konto ({ id, imap: { host, port, security, trust }, … }) · deps: { auth: async () => imapflow-auth, offline, now, sleep, log }
   */
  constructor(cfg, deps = {}) {
    super();
    this.cfg = cfg;
    this.deps = deps;
    this.opsClient = null;
    this.opsConnecting = null;
    this.opsTimer = null;
    this.watchClient = null;
    this.watching = false;
    this.status = 'off';
    this.error = null;
    this.failures = 0;
    this.wake = null;
    this.capabilities = new Set();
    this.setMaxListeners(50);
  }
  setConfig(cfg) { this.cfg = cfg; }
  setState(status, error = null) {
    this.status = status; this.error = error;
    this.emit('state', { status, error });
  }
  get gmail() { return this.capabilities.has('X-GM-EXT-1'); }

  async options(purpose = 'ops') {
    const s = this.cfg.imap;
    if (s.security === 'none' && !isLocal(s.host)) throw Object.assign(new Error('insecure'), { code: 'INSECURE' });
    const o = {
      host: s.host, port: Number(s.port), secure: s.security === 'tls', logger: false, emitLogs: false,
      auth: await this.deps.auth(this.cfg), tls: tlsOptions(s, s.trust),
      connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 10 * 60 * 1000, maxIdleTime: 25 * 60 * 1000,
      clientInfo: { name: 'Hostwerk', vendor: 'Hostwerk' }, disableCompression: false,
    };
    // Beobachter geht nach 1 s Ruhe in IDLE (Standard wären 15 s) – neue Mails kommen sofort an
    if (purpose === 'watch') o.autoIdleDelay = 1000;
    if (s.security === 'starttls') o.doSTARTTLS = true;
    else if (s.security === 'none') o.doSTARTTLS = false;
    return o;
  }

  async connect(purpose = 'ops') {
    if (this.deps.offline && this.deps.offline()) throw Object.assign(new Error('offline'), { code: 'OFFLINE' });
    const c = new ImapFlow(await this.options(purpose));
    c.on('error', () => { /* Schließen folgt – wird dort behandelt */ });
    await c.connect();
    this.capabilities = new Set([...(c.capabilities ? c.capabilities.keys() : [])].map((k) => String(k).toUpperCase()));
    return c;
  }

  /** Verbindung für Aktionen (geteilt; imapflow reiht Befehle selbst ein) */
  async ops() {
    if (this.opsClient && this.opsClient.usable) { this.touch(); return this.opsClient; }
    if (this.opsConnecting) return this.opsConnecting;
    this.opsConnecting = (async () => {
      try {
        const c = await this.connect();
        c.on('close', () => { if (this.opsClient === c) this.opsClient = null; });
        this.opsClient = c;
        if (this.status !== 'online' && !this.watching) this.setState('online');
        this.touch();
        return c;
      } catch (e) {
        const err = classify(e);
        if (!this.watching) this.setState(err.code === 'offline' ? 'offline' : 'error', err);
        throw Object.assign(new Error(err.text), { status: err.code === 'auth' ? 401 : 502, code: err.code, detail: err.detail });
      } finally { this.opsConnecting = null; }
    })();
    return this.opsConnecting;
  }
  touch() {
    clearTimeout(this.opsTimer);
    this.opsTimer = setTimeout(() => { const c = this.opsClient; this.opsClient = null; if (c) c.logout().catch(() => c.close()); }, IDLE_CLOSE);
    if (this.opsTimer.unref) this.opsTimer.unref();
  }

  /** Mit einem Ordner arbeiten (Sperre, damit nicht zwei Aufrufe gleichzeitig den Ordner wechseln) */
  async withBox(path, fn, { readOnly = false } = {}) {
    const c = await this.ops();
    const lock = await c.getMailboxLock(path, { readOnly });
    try { return await fn(c, c.mailbox); } finally { lock.release(); }
  }

  /** Ordner mit Rolle (SPECIAL-USE oder von imapflow erkannt) und Zählern */
  async folders() {
    const c = await this.ops();
    const list = await c.list({ statusQuery: { messages: true, unseen: true } });
    return list.filter((f) => !(f.flags && f.flags.has('\\Noselect')) && !(f.flags && f.flags.has('\\NonExistent'))).map((f) => ({
      path: f.path, name: f.name, delimiter: f.delimiter, parent: f.parentPath || '',
      role: f.specialUse ? f.specialUse.replace(/^\\/, '').toLowerCase() : f.path.toUpperCase() === 'INBOX' ? 'inbox' : null,
      total: f.status ? f.status.messages : null, unseen: f.status ? f.status.unseen : null, subscribed: f.subscribed !== false,
    }));
  }

  /** Seite eines Ordners: neueste zuerst. Mit Filtern/Suche über IMAP SEARCH beim Server. */
  async list(path, { page = 0, size = 50, filter = {}, q = '' } = {}) {
    return this.withBox(path, async (c, mb) => {
      const crit = criteria(filter, q, this.gmail);
      let range; let opts = {}; let total = mb.exists;
      if (crit) {
        const uids = ((await c.search(crit, { uid: true })) || []).sort((a, b) => b - a);
        total = uids.length;
        const slice = uids.slice(page * size, (page + 1) * size);
        if (!slice.length) return { total, items: [], uidValidity: String(mb.uidValidity), exists: mb.exists };
        range = slice.join(','); opts = { uid: true };
      } else {
        const hi = mb.exists - page * size;
        if (hi < 1) return { total, items: [], uidValidity: String(mb.uidValidity), exists: mb.exists };
        range = `${Math.max(1, hi - size + 1)}:${hi}`;
      }
      const items = [];
      for await (const m of c.fetch(range, { uid: true, flags: true, envelope: true, internalDate: true, size: true, headers: LIST_HEADERS }, opts)) {
        items.push(fromEnvelope(m, { account: this.cfg.id, folder: path }));
      }
      items.sort((a, b) => b.uid - a.uid);
      return { total, items, uidValidity: String(mb.uidValidity), exists: mb.exists };
    });
  }

  /** Neue Mails seit uid (für Benachrichtigungen und Regeln) */
  async since(path, uid, { client = null } = {}) {
    const run = async (c) => {
      const out = [];
      for await (const m of c.fetch(`${Number(uid) + 1}:*`, { uid: true, flags: true, envelope: true, internalDate: true, size: true, headers: LIST_HEADERS }, { uid: true })) {
        if (m.uid > uid) out.push(fromEnvelope(m, { account: this.cfg.id, folder: path }));
      }
      return out;
    };
    if (client) return run(client);
    return this.withBox(path, (c) => run(c));
  }

  /** Rohtext einer Mail (ohne \Seen zu setzen) */
  async source(path, uid) {
    return this.withBox(path, async (c, mb) => {
      const m = await c.fetchOne(String(uid), { uid: true, source: { maxLength: MAX_SOURCE }, flags: true }, { uid: true });
      if (!m || !m.source) throw Object.assign(new Error('This mail no longer exists on the server.'), { status: 404 });
      return { raw: m.source, flags: [...(m.flags || [])], uidValidity: String(mb.uidValidity) };
    });
  }

  async flags(path, uids, { add = [], remove = [] }) {
    return this.withBox(path, async (c) => {
      const range = [].concat(uids).join(',');
      if (add.length) await c.messageFlagsAdd(range, add, { uid: true });
      if (remove.length) await c.messageFlagsRemove(range, remove, { uid: true });
      return true;
    });
  }
  async move(path, uids, dest) {
    return this.withBox(path, async (c) => { const r = await c.messageMove([].concat(uids).join(','), dest, { uid: true }); return r || true; });
  }
  async copy(path, uids, dest) {
    return this.withBox(path, async (c) => c.messageCopy([].concat(uids).join(','), dest, { uid: true }));
  }
  /** Endgültig löschen (nur aus Papierkorb/Spam oder auf ausdrücklichen Wunsch) */
  async expunge(path, uids) {
    return this.withBox(path, async (c) => c.messageDelete([].concat(uids).join(','), { uid: true }));
  }
  async append(path, raw, flags = []) {
    const c = await this.ops();
    return c.append(path, raw, flags);
  }
  async createFolder(path) { const c = await this.ops(); return c.mailboxCreate(path); }
  async renameFolder(path, to) { const c = await this.ops(); return c.mailboxRename(path, to); }
  async deleteFolder(path) { const c = await this.ops(); return c.mailboxDelete(path); }
  async status(path) { const c = await this.ops(); return c.status(path, { messages: true, unseen: true, uidNext: true, uidValidity: true }); }

  /** Alle Mails eines Ordners nacheinander (Export) – onMessage(raw, meta) */
  async each(path, onMessage, { batch = 50 } = {}) {
    return this.withBox(path, async (c, mb) => {
      let n = 0;
      for (let lo = 1; lo <= mb.exists; lo += batch) {
        const hi = Math.min(mb.exists, lo + batch - 1);
        for await (const m of c.fetch(`${lo}:${hi}`, { uid: true, source: { maxLength: MAX_SOURCE }, internalDate: true, envelope: true })) {
          if (m.source) { await onMessage(m.source, { uid: m.uid, date: m.internalDate, from: m.envelope && m.envelope.from && m.envelope.from[0] }); n++; }
        }
      }
      return n;
    }, { readOnly: true });
  }

  /** Anmeldung prüfen (Einrichtung): verbinden, Ordner zählen, abmelden */
  async verify() {
    const c = await this.connect();
    try { const l = await c.list(); return { ok: true, folders: l.length, capabilities: [...this.capabilities].slice(0, 40) }; } finally { await c.logout().catch(() => c.close()); }
  }

  /* ---------- Posteingang beobachten (IDLE) ---------- */
  startWatch(folder = 'INBOX') {
    if (this.watching) return;
    this.watching = true;
    this.watchFolder = folder;
    this.loop().catch(() => { /* Schleife fängt selbst */ });
  }
  async stopWatch() {
    this.watching = false;
    this.poke();
    const c = this.watchClient; this.watchClient = null;
    if (c) await c.logout().catch(() => c.close());
  }
  /** Sofort neu versuchen (Knopf „Neu verbinden“, Netz wieder da, Offline-Modus aus) */
  poke() { this.failures = 0; if (this.wake) this.wake(); }
  pause(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wake = null; resolve(); }, ms);
      if (t.unref) t.unref();
      this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
    });
  }
  async loop() {
    while (this.watching) {
      if (this.deps.offline && this.deps.offline()) { this.setState('offline', classify({ code: 'OFFLINE' })); await this.pause(60000); continue; }
      let authFail = false;
      try {
        this.setState('connecting', this.error);
        const c = await this.connect('watch');
        if (!this.watching) { await c.logout().catch(() => c.close()); break; }
        this.watchClient = c;
        const mb = await c.mailboxOpen(this.watchFolder);
        this.failures = 0;
        this.setState('online');
        this.emit('ready', { client: c, uidNext: mb.uidNext, uidValidity: String(mb.uidValidity), exists: mb.exists });
        c.on('exists', (d) => this.emit('exists', { client: c, path: d.path, count: d.count, prevCount: d.prevCount }));
        c.on('expunge', () => this.emit('changed', { path: this.watchFolder }));
        c.on('flags', () => this.emit('changed', { path: this.watchFolder }));
        await new Promise((resolve) => c.once('close', resolve));
        if (this.watchClient === c) this.watchClient = null;
        if (!this.watching) break;
        this.setState('connecting', { code: 'network', text: 'The connection broke off.' });
      } catch (e) {
        const err = classify(e);
        authFail = err.code === 'auth' || err.code === 'cert' || err.code === 'insecure';
        this.setState(err.code === 'offline' ? 'offline' : 'error', err);
      }
      if (!this.watching) break;
      this.failures++;
      const base = authFail ? 30 * 60 * 1000 : Math.min(5 * 60 * 1000, 2000 * 2 ** Math.min(this.failures - 1, 8));
      await this.pause(Math.round(base * (0.8 + Math.random() * 0.4)));
    }
    this.setState('off');
  }

  async close() {
    await this.stopWatch();
    clearTimeout(this.opsTimer);
    const c = this.opsClient; this.opsClient = null;
    if (c) await c.logout().catch(() => c.close());
  }
}

module.exports = { AccountClient, criteria };
