'use strict';
/*
 * Schreiben und Senden.
 *   build(draft)      Entwurf → Rohtext (nodemailer MailComposer): Text + HTML, Anhänge, Antwort-Kette, Absender/Alias
 *   Outbox            Senden mit Rückgängig-Frist (Standard 10 s): erst nach Ablauf geht die Mail per SMTP raus. Die
 *                     Warteschlange liegt auf der Platte – ein Neustart von Hostwerk verliert nichts. Fehlgeschlagene
 *                     Mails bleiben im Postausgang (erneut versuchen, bearbeiten, verwerfen). Offline: wartet.
 *   smtpSend(...)     über nodemailer, STARTTLS/SSL, Passwort oder XOAUTH2, gemerktes Zertifikat wie bei IMAP
 */
const path = require('path');
const { MailComposer, nodemailer } = require('./libs');
const { tlsOptions, classify, isLocal } = require('./netutil');
const { readJson, writeJson, newId } = require('./store');

const fmt = (a) => (a && a.address ? (a.name ? { name: a.name, address: a.address } : a.address) : a);
const list = (v) => [].concat(v || []).map((x) => (typeof x === 'string' ? { address: x.trim() } : x)).filter((x) => x && x.address && /^[^@\s]+@[^@\s]+$/.test(x.address));

/** Entwurf → { raw, envelope, messageId } */
function build(d, { hostname = 'hostwerk.local' } = {}) {
  const to = list(d.to); const cc = list(d.cc); const bcc = list(d.bcc);
  if (!d.from || !d.from.address) throw Object.assign(new Error('No sender address.'), { status: 400 });
  const mail = {
    from: fmt(d.from), to: to.map(fmt), cc: cc.map(fmt), bcc: bcc.map(fmt), subject: String(d.subject || ''),
    text: d.text != null ? String(d.text) : undefined, html: d.html ? String(d.html) : undefined,
    inReplyTo: d.inReplyTo || undefined, references: d.references && d.references.length ? [].concat(d.references).join(' ') : undefined,
    replyTo: d.replyTo ? fmt(d.replyTo) : undefined, date: d.date ? new Date(d.date) : new Date(),
    headers: { ...(d.receipt ? { 'Disposition-Notification-To': d.from.address } : {}), ...(d.priority ? { 'X-Priority': '1 (Highest)', Importance: 'high' } : {}) },
    attachments: (d.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.data || ''), 'base64'), cid: a.cid || undefined, contentDisposition: a.cid ? 'inline' : 'attachment' })),
    keepBcc: !!d.keepBcc, // nur für Entwürfe: Bcc soll beim Weiterbearbeiten erhalten bleiben
    messageId: d.messageId || `<${newId(12)}@${hostname}>`,
  };
  const c = new MailComposer(mail);
  return new Promise((resolve, reject) => {
    c.compile().build((err, raw) => {
      if (err) return reject(err);
      resolve({ raw, envelope: { from: d.from.address, to: [...to, ...cc, ...bcc].map((x) => x.address) }, messageId: mail.messageId });
    });
  });
}

/** SMTP-Versand. server = { host, port, security, trust }, auth = { user, pass } | { user, accessToken } */
async function smtpSend(server, auth, { raw, envelope }, { offline } = {}) {
  if (offline && offline()) throw Object.assign(new Error('offline'), { code: 'OFFLINE' });
  if (server.security === 'none' && !isLocal(server.host)) throw Object.assign(new Error('insecure'), { code: 'INSECURE' });
  const t = nodemailer.createTransport({
    host: server.host, port: Number(server.port), secure: server.security === 'tls', requireTLS: server.security === 'starttls', ignoreTLS: server.security === 'none',
    auth: auth && auth.accessToken ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : auth && auth.user ? { user: auth.user, pass: auth.pass } : undefined,
    tls: tlsOptions(server, server.trust), connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 60000, name: 'hostwerk.local', logger: false, debug: false,
  });
  try { return await t.sendMail({ envelope, raw }); } finally { t.close(); }
}

class Outbox {
  /** deps: { dir, now, send: async (item) => void, onEvent(type, item) } */
  constructor(deps) {
    this.deps = deps;
    this.file = path.join(deps.dir, 'outbox.json');
    this.items = readJson(this.file, () => []);
    this.timers = new Map();
    this.now = deps.now || (() => Date.now());
  }
  save() { writeJson(this.file, this.items.map(({ busy, ...x }) => x)); } // eslint-disable-line no-unused-vars
  list() { return this.items.map(({ raw, draft, ...x }) => ({ ...x, subject: draft && draft.subject, to: draft && list(draft.to).map((a) => a.address) })); } // eslint-disable-line no-unused-vars
  /** In die Warteschlange; delay in ms (Rückgängig-Frist) */
  add({ account, raw, envelope, draft, delay = 10000, meta = {} }) {
    const item = { id: newId(6), account, raw: Buffer.isBuffer(raw) ? raw.toString('base64') : raw, envelope, draft, sendAt: this.now() + Math.max(0, delay), tries: 0, error: null, state: 'waiting', meta };
    this.items.push(item);
    this.save();
    this.schedule(item);
    return item;
  }
  schedule(item) {
    clearTimeout(this.timers.get(item.id));
    const ms = Math.max(0, item.sendAt - this.now());
    const t = setTimeout(() => this.run(item.id), ms);
    if (t.unref) t.unref();
    this.timers.set(item.id, t);
  }
  /** Nach dem Start: wartende Mails wieder einplanen */
  resume() { for (const it of this.items) if (it.state === 'waiting') this.schedule(it); }
  /** Rückgängig: nur solange noch nicht gesendet → gibt den Entwurf zurück */
  undo(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.state === 'sending') return null;
    clearTimeout(this.timers.get(id));
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
    return it.draft || null;
  }
  retry(id) { const it = this.items.find((x) => x.id === id); if (!it || it.state === 'sending') return false; it.state = 'waiting'; it.error = null; it.sendAt = this.now(); this.save(); this.schedule(it); return true; }
  async run(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it || it.state !== 'waiting') return;
    it.state = 'sending'; it.tries++;
    try {
      await this.deps.send({ ...it, raw: Buffer.from(it.raw, 'base64') });
      this.items = this.items.filter((x) => x.id !== id);
      this.timers.delete(id);
      this.save();
      if (this.deps.onEvent) this.deps.onEvent('sent', it);
    } catch (e) {
      const err = classify(e);
      // Offline/Netz: still weiter versuchen (1, 2, 4 … bis 30 min); Anmeldung/Zertifikat/abgelehnt: anhalten und melden
      if (['offline', 'network', 'timeout', 'dns', 'refused'].includes(err.code) && it.tries < 12) {
        it.state = 'waiting'; it.error = err; it.sendAt = this.now() + Math.min(30 * 60000, 60000 * 2 ** (it.tries - 1));
        this.save(); this.schedule(it);
        if (this.deps.onEvent) this.deps.onEvent('delayed', it);
      } else {
        it.state = 'failed'; it.error = { ...err, detail: err.detail || String(e.message || '').slice(0, 200) };
        this.save();
        if (this.deps.onEvent) this.deps.onEvent('failed', it);
      }
    }
  }
  remove(id) { clearTimeout(this.timers.get(id)); const it = this.items.find((x) => x.id === id); this.items = this.items.filter((x) => x.id !== id); this.save(); return it || null; }
  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}

module.exports = { build, smtpSend, Outbox, list };
