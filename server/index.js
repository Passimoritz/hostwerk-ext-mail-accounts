'use strict';
/*
 * E-Mail-Konten – Server-Teil (native Erweiterung). Externe Postfächer (Gmail, Outlook, web.de, GMX, eigene Domain …)
 * per IMAP/SMTP in Hostwerks Bereich „E-Mail“. Routen unter /api/mail-accounts (gleiche Anmeldung wie Hostwerk):
 *
 *   GET    /mail-accounts                      Überblick: Konten (ohne Geheimnisse) mit Zustand und Ungelesen, Einstellungen, Postausgang
 *   POST   /mail-accounts/discover             { email } → Einstellungen finden (Autoconfig, ISPDB, MX, SRV, Autodiscover)
 *   POST   /mail-accounts/test                 { Konto-Entwurf } → IMAP/SMTP-Anmeldung prüfen, nichts speichern
 *   POST   /mail-accounts/accounts             Konto anlegen (prüft vorher) · PUT …/accounts/:id ändern · DELETE …/accounts/:id vergessen
 *   POST   /mail-accounts/accounts/:id/reconnect · GET …/:id/cert?kind= · POST …/:id/trust { kind, fingerprint256 } · DELETE …/:id/trust?kind=
 *   POST   /mail-accounts/accounts/order       { ids } · POST /mail-accounts/cert { host, port, security, kind } (Zertifikat vor dem Einrichten ansehen)
 *   POST   /mail-accounts/oauth/start          → { url, state, redirectUri } · GET /mail-accounts/oauth/result?state=
 *          öffentlich: /api/x/mail-accounts/pub/oauth (Rücksprung vom Anbieter, prüft state)
 *   GET    /mail-accounts/folders?account= · POST /mail-accounts/folders { account, action, path, to }
 *   GET    /mail-accounts/messages?account=&folder=&page=&size=&q=&unread=&flagged=&attachments=&from=   (account=all: alle Posteingänge)
 *   GET    /mail-accounts/message?account=&folder=&uid=&images=1
 *   GET    /mail-accounts/attachment?account=&folder=&uid=&i=&download=1 · POST /mail-accounts/attachment/save { …, dir }
 *   GET    /mail-accounts/raw?… (.eml) · GET /mail-accounts/export?account=&folder= (.mbox)
 *   POST   /mail-accounts/flags { items, add, remove } · /move { items, folder | role } · /delete { items, permanent }
 *   GET    /mail-accounts/compose?mode=reply|replyAll|forward&… · GET /mail-accounts/draft?… (Entwurf öffnen)
 *   POST   /mail-accounts/send · /draft · /outbox/:id/undo · /outbox/:id/retry · DELETE /outbox/:id
 *   GET    /mail-accounts/contacts?q= · GET/PUT /mail-accounts/prefs · /rules (+ POST /rules/run) · /templates
 *   POST   /mail-accounts/trust-sender { address } · /unsubscribe { account, folder, uid } · /ai { task, … } · /cache/clear
 * Live-Meldungen an die Oberfläche: { type: 'mail-accounts', event: 'state'|'unread'|'new'|'changed'|'accounts'|'outbox', … }
 */
const fs = require('fs');
const path = require('path');
const { MailService } = require('./service');
const { makeSecrets } = require('./store');

const safeName = (s) => String(s || 'mail').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').slice(0, 150) || 'mail';
const disp = (name, inline) => `${inline ? 'inline' : 'attachment'}; filename="${safeName(name).replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safeName(name))}`;
/** Nur harmlose Arten direkt anzeigen – HTML, SVG, XML und Unbekanntes immer als Download */
const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|application\/pdf|text\/plain|audio\/(mpeg|ogg|wav|webm)|video\/(mp4|webm|ogg))$/i;

function createService(host, io = {}) {
  const { ctx } = host;
  const dir = path.join(ctx.paths.data, 'mail-accounts');
  const can = (name) => { try { return typeof host.supports === 'function' && host.supports(name) === true; } catch { return false; } };
  let coreSecrets = null;
  try { coreSecrets = host.core('secrets'); } catch { coreSecrets = null; }
  const offline = io.offline || (() => { try { return can('net.offline') ? host.net.offline() === true : host.core('download').isOffline() === true; } catch { return false; } });
  let ownEvent = false;
  try { if (host.notifications && typeof host.notifications.register === 'function') { host.notifications.register('new-mail', { de: 'Neue E-Mails in verbundenen Konten', en: 'New e-mails in connected accounts' }, { on: true }); ownEvent = true; } } catch { /* ältere Hostwerk-Fassung */ }
  const notify = (m) => {
    if (ownEvent) host.notifications.notify('new-mail', { title: m.title, text: m.text, kind: m.kind || 'info', url: '/mail/x-mail-accounts-inbox' });
    else host.broadcast({ type: 'toast', kind: m.kind || 'info', text: `${m.title}\n${m.text}` });
  };
  const ai = can('ai.quick') ? { ready: () => host.ai.quick.ready(), run: (task, o) => host.ai.quick.run(task, o) } : null;
  /** Postfächer auf diesem PC: Mail-Fänger (IMAP an) und Mailserver-Erweiterung */
  const local = () => {
    const out = [];
    try {
      const st = ctx.mail && ctx.mail.status ? ctx.mail.status() : null;
      if (st && st.imap) out.push({ id: 'catcher', kind: 'catcher', name: 'Mail catcher', running: !!st.imap.running, enabled: !!st.imap.enabled,
        imap: { host: '127.0.0.1', port: Number(st.imap.port) || 1143, security: 'none' }, smtp: { host: '127.0.0.1', port: Number((st.config && st.config.port) || 1025), security: 'none' } });
    } catch { /* kein Mail-Fänger */ }
    try {
      const ms = ctx.mailserver && typeof ctx.mailserver.list === 'function' ? ctx.mailserver.list() : [];
      for (const i of ms || []) {
        const c = i.cfg || i; const p = c.ports || {};
        if (!p.imap && !p.imaps) continue;
        out.push({ id: `mailserver:${i.id}`, kind: 'mailserver', name: i.name || c.hostname || 'Mail server', domain: c.domain || '', hostname: c.hostname || '',
          imap: p.imaps ? { host: 'localhost', port: Number(p.imaps), security: 'tls' } : { host: 'localhost', port: Number(p.imap), security: 'starttls' },
          smtp: p.submission ? { host: 'localhost', port: Number(p.submission), security: 'starttls' } : null });
      }
    } catch { /* keine Mailserver-Erweiterung */ }
    return out;
  };
  const svc = new MailService({
    dir, secrets: makeSecrets(coreSecrets, dir), offline, notify, broadcast: (m) => host.broadcast(m), t: (s, v) => host.t(s, v), lang: () => host.lang(), ai, local,
    fetch: io.fetch, now: io.now, resolveMx: io.resolveMx, resolveSrv: io.resolveSrv, probe: io.probe,
  });
  return svc;
}

function routes(host, svc) {
  const r = host.router;
  const q = (req) => ({ account: String(req.query.account || ''), folder: String(req.query.folder || 'INBOX'), uid: Number(req.query.uid) });
  const body = (req) => req.body || {};
  r.get('/mail-accounts', (req, res) => res.json(svc.overview()));
  r.post('/mail-accounts/discover', async (req, res) => res.json(await svc.discover(body(req).email)));
  r.post('/mail-accounts/test', async (req, res) => {
    const d = body(req);
    const n = svc.normalize(d, d.id ? svc.account(d.id) : null);
    res.json(await svc.test({ id: 'test', ...n }));
  });
  r.post('/mail-accounts/accounts', async (req, res) => {
    const d = body(req);
    // Postfach auf diesem PC (Mail-Fänger): Einstellungen kommen von Hostwerk, nicht aus der Eingabe
    if (d.local === 'catcher') {
      const l = svc.localServers().find((x) => x.id === 'catcher');
      if (!l) throw host.error(409, 'The mail catcher has no IMAP access – switch it on under E-mail → Mail catcher.');
      return res.json(await svc.addAccount({ email: d.email || 'catcher@hostwerk.local', name: host.t('Mail catcher'), imap: l.imap, smtp: l.smtp, auth: { type: 'password', user: 'hostwerk', pass: 'hostwerk' }, local: 'catcher', color: '#f59e0b' }));
    }
    res.json(await svc.addAccount(d));
  });
  r.post('/mail-accounts/cert', async (req, res) => res.json(await svc.peek(body(req))));
  r.post('/mail-accounts/accounts/order', (req, res) => res.json(svc.reorder(body(req).ids)));
  r.put('/mail-accounts/accounts/:id', async (req, res) => res.json(await svc.updateAccount(req.params.id, body(req))));
  r.delete('/mail-accounts/accounts/:id', async (req, res) => res.json(await svc.removeAccount(req.params.id)));
  r.post('/mail-accounts/accounts/:id/reconnect', (req, res) => res.json(svc.reconnect(req.params.id)));
  r.get('/mail-accounts/accounts/:id/cert', async (req, res) => res.json(await svc.certificate(req.params.id, String(req.query.kind || 'imap'))));
  r.post('/mail-accounts/accounts/:id/trust', async (req, res) => res.json(await svc.trust(req.params.id, body(req).kind, body(req).fingerprint256)));
  r.delete('/mail-accounts/accounts/:id/trust', (req, res) => res.json(svc.untrust(req.params.id, String(req.query.kind || 'imap'))));

  // OAuth: Rücksprung-Adresse = diese Hostwerk-Adresse (127.0.0.1/localhost – so verlangen es Google/Microsoft für Desktop-Apps)
  r.post('/mail-accounts/oauth/start', async (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${origin}/api/x/mail-accounts/pub/oauth`;
    const out = await svc.oauthStart({ ...body(req), redirectUri });
    res.json({ ...out, redirectUri });
  });
  r.get('/mail-accounts/oauth/result', (req, res) => {
    const p = svc.oauth.pending.get(String(req.query.state || ''));
    res.json(!p ? { gone: true } : !p.result ? { pending: true } : { ok: p.result.ok, error: p.result.error || null });
  });
  host.publicRouter.get('/pub/oauth', async (req, res) => {
    let out;
    try { out = await svc.oauth.callback(req.query || {}); } catch (e) { out = { ok: false, error: e.message }; }
    const ok = out && out.ok;
    const title = ok ? host.t('Signed in – you can close this window.') : host.t('Sign-in didn’t work');
    const text = ok ? host.t('Go back to Hostwerk to finish connecting the account.') : String((out && out.error) || '');
    const e = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").set('Cache-Control', 'no-store').type('html')
      .send(`<!doctype html><html lang="${host.lang()}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hostwerk</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:CanvasText;background:Canvas}main{max-width:32rem;padding:2rem;text-align:center}</style><main><h1>${e(title)}</h1><p>${e(text)}</p></main></html>`);
  });

  r.get('/mail-accounts/folders', async (req, res) => res.json(await svc.folders(String(req.query.account || ''), { fresh: req.query.fresh === '1' })));
  r.post('/mail-accounts/folders', async (req, res) => res.json(await svc.folderAction(body(req).account, body(req))));
  r.get('/mail-accounts/messages', async (req, res) => {
    const x = req.query;
    res.json(await svc.messages({ account: String(x.account || 'all'), folder: String(x.folder || 'INBOX'), page: x.page, size: x.size, q: String(x.q || ''),
      filter: { unread: x.unread === '1', flagged: x.flagged === '1', attachments: x.attachments === '1', from: x.from ? String(x.from) : '' } }));
  });
  r.get('/mail-accounts/message', async (req, res) => {
    const { account, folder, uid } = q(req);
    res.json(await svc.message(account, folder, uid, { images: req.query.images === '1', markRead: req.query.peek === '1' ? false : undefined }));
  });
  r.get('/mail-accounts/attachment', async (req, res) => {
    const { account, folder, uid } = q(req);
    const a = await svc.attachment(account, folder, uid, Number(req.query.i));
    const inline = req.query.download !== '1' && INLINE_OK.test(a.contentType);
    res.set('Content-Type', inline ? a.contentType : 'application/octet-stream').set('Content-Disposition', disp(a.filename, inline))
      .set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'private, no-store');
    // Abgeschottet ausliefern – außer PDF: Chromiums PDF-Ansicht startet in abgeschotteten Dokumenten nicht
    if (!/^application\/pdf$/i.test(a.contentType) || !inline) res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.send(a.content);
  });
  // In einen gewählten Ordner speichern (Ordner wählt der Mensch im Dialog; vorhandene Dateien werden nie überschrieben)
  r.post('/mail-accounts/attachment/save', async (req, res) => {
    const b = body(req);
    const target = path.resolve(String(b.dir || ''));
    if (!b.dir || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw host.error(400, 'Choose an existing folder.');
    const list = b.all ? (await svc.message(b.account, b.folder, Number(b.uid), { markRead: false })).attachments.map((x) => x.i) : [Number(b.i)];
    const saved = [];
    for (const i of list) {
      const a = await svc.attachment(b.account, b.folder, Number(b.uid), i);
      const ext = path.extname(safeName(a.filename)); const base = path.basename(safeName(a.filename), ext);
      let file = path.join(target, safeName(a.filename));
      for (let n = 2; fs.existsSync(file) && n < 1000; n++) file = path.join(target, `${base} (${n})${ext}`);
      fs.writeFileSync(file, a.content, { flag: 'wx' });
      saved.push(file);
    }
    res.json({ saved });
  });
  r.get('/mail-accounts/raw', async (req, res) => {
    const { account, folder, uid } = q(req);
    const raw = await svc.rawOf(account, folder, uid);
    res.set('Content-Type', 'message/rfc822').set('Content-Disposition', disp(`${String(req.query.name || `mail-${uid}`)}.eml`, false)).set('Cache-Control', 'private, no-store');
    res.send(raw);
  });
  r.get('/mail-accounts/export', async (req, res) => {
    const { account, folder } = q(req);
    svc.account(account);
    res.set('Content-Type', 'application/mbox').set('Content-Disposition', disp(`${folder.replace(/[/\\.]+/g, '-')}.mbox`, false)).set('Cache-Control', 'private, no-store');
    const write = (buf) => new Promise((resolve) => { if (res.write(buf)) resolve(); else res.once('drain', resolve); });
    try { await svc.exportMbox(account, folder, write); } catch (e) { host.log('export failed:', e.message); }
    res.end();
  });
  r.post('/mail-accounts/flags', async (req, res) => res.json(await svc.setFlags(body(req).items, body(req))));
  r.post('/mail-accounts/move', async (req, res) => res.json(await svc.move(body(req).items, body(req))));
  r.post('/mail-accounts/delete', async (req, res) => res.json(await svc.remove(body(req).items, { permanent: !!body(req).permanent })));
  r.get('/mail-accounts/compose', async (req, res) => { const { account, folder, uid } = q(req); res.json(await svc.compose({ mode: String(req.query.mode || 'reply'), account, folder, uid })); });
  r.get('/mail-accounts/draft', async (req, res) => { const { account, folder, uid } = q(req); res.json(await svc.openDraft(account, folder, uid)); });
  r.post('/mail-accounts/send', async (req, res) => res.json(await svc.send(body(req))));
  r.post('/mail-accounts/draft', async (req, res) => res.json(await svc.saveDraft(body(req))));
  r.post('/mail-accounts/outbox/:id/undo', (req, res) => { const d = svc.outbox.undo(req.params.id); if (!d) throw host.error(409, 'Too late – the mail is already on its way.'); svc.broadcast({ event: 'outbox' }); res.json({ draft: d }); });
  r.post('/mail-accounts/outbox/:id/retry', (req, res) => res.json({ ok: svc.outbox.retry(req.params.id) }));
  r.delete('/mail-accounts/outbox/:id', (req, res) => { const it = svc.outbox.remove(req.params.id); svc.broadcast({ event: 'outbox' }); res.json({ draft: it ? it.draft : null }); });
  r.get('/mail-accounts/contacts', (req, res) => res.json(svc.contacts.find(req.query.q, Number(req.query.limit) || 8)));
  r.delete('/mail-accounts/contacts', (req, res) => { svc.contacts.remove(String(req.query.address || '')); res.json({ ok: true }); });
  r.get('/mail-accounts/prefs', (req, res) => res.json(svc.prefsCfg));
  r.put('/mail-accounts/prefs', (req, res) => res.json(svc.setPrefs(body(req))));
  r.post('/mail-accounts/trust-sender', (req, res) => res.json(svc.trustSender(body(req).address)));
  r.get('/mail-accounts/rules', (req, res) => res.json(svc.rulesCfg));
  r.put('/mail-accounts/rules', (req, res) => res.json(svc.setRules(body(req).rules)));
  r.post('/mail-accounts/rules/run', async (req, res) => res.json(await svc.runRules(body(req).account || null)));
  r.get('/mail-accounts/templates', (req, res) => res.json(svc.templatesCfg));
  r.put('/mail-accounts/templates', (req, res) => res.json(svc.setTemplates(body(req).templates)));
  r.post('/mail-accounts/unsubscribe', async (req, res) => { const b = body(req); res.json(await svc.unsubscribe(b.account, b.folder, Number(b.uid))); });
  r.get('/mail-accounts/ai', async (req, res) => res.json({ ready: !!(svc.deps.ai && (await svc.deps.ai.ready().catch(() => false))), allowed: !!svc.prefsCfg.aiConsent }));
  r.post('/mail-accounts/ai', async (req, res) => { const b = body(req); res.json(await svc.ai(String(b.task || ''), { account: b.account, folder: b.folder, uid: Number(b.uid), lang: host.lang() })); });
  r.post('/mail-accounts/cache/clear', (req, res) => { svc.cache.clear(); res.json(svc.cache.stats()); });
}

function activate(host) {
  const svc = createService(host);
  routes(host, svc);
  host.provide('mailAccounts', { unread: () => svc.totalUnread(), accounts: () => svc.accountsCfg.map((a) => ({ id: a.id, email: a.email, name: a.name, status: (svc.live.get(a.id) || {}).status || 'off', unread: (svc.live.get(a.id) || {}).unread ?? null })) });
  // Sicherungs-Zentrale: Konten, Regeln, Vorlagen und Einstellungen (Mails liegen auf den Mail-Servern)
  if (host.backups && typeof host.backups.register === 'function') {
    host.backups.register({
      label: { de: 'E-Mail-Konten', en: 'E-mail accounts' },
      list: () => svc.backups(),
      restore: (id) => svc.restoreBackup(id),
      remove: (id) => svc.removeBackup(id),
      offsite: async ({ dir }) => { svc.snapshot({ force: true }); const last = svc.backups()[0]; if (last) fs.copyFileSync(path.join(svc.backupDir(), `${last.id}.json`), path.join(dir, 'mail-accounts.json')); },
    });
  }
  // Erst nach dem Start von Hostwerk verbinden; Offline-Modus beobachten (an → still warten, aus → sofort verbinden)
  let wasOffline = svc.offline();
  const first = setTimeout(() => svc.start(), 4000);
  if (first.unref) first.unref();
  const timer = setInterval(() => {
    const off = svc.offline();
    if (wasOffline && !off) svc.wakeAll();
    wasOffline = off;
    try { svc.snapshot(); } catch { /* nächstes Mal */ }
  }, 60000);
  if (timer.unref) timer.unref();
  host.on('shutdown', async () => { clearTimeout(first); clearInterval(timer); await svc.stop(); });
  return svc;
}

function deactivate() {}

module.exports = { activate, deactivate, createService, routes };
