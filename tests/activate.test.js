'use strict';
// Server-Modul wie in Hostwerk starten (mit nachgebautem host): Routen, Dienst, Sicherungs-Quelle, Benachrichtigungs-Anlass,
// OAuth-Rücksprung ohne Anmeldung, Herunterfahren. Kein echtes Hostwerk, kein Netz.
const test = require('node:test');
const assert = require('node:assert');
const { tempDir } = require('./helpers');
const mod = require('../server/index');

function fakeHost() {
  const routes = new Map();
  const router = (map) => new Proxy({}, { get: (_, m) => (p, fn) => map.set(`${m.toUpperCase()} ${p}`, fn) });
  const pub = new Map();
  const hooks = { shutdown: [] };
  const h = {
    id: 'mail-accounts', ctx: { paths: { data: tempDir() } }, router: router(routes), publicRouter: router(pub), routes, pub, hooks,
    t: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => v[k]) : s), lang: () => 'de', log: () => {},
    error: (status, text) => Object.assign(new Error(text), { status }), broadcast: () => {},
    core: () => { throw new Error('core: unknown module'); },
    on: (ev, fn) => { (hooks[ev] = hooks[ev] || []).push(fn); },
    provided: {}, provide(name, obj) { this.provided[name] = obj; },
    registered: [], notifications: { register: (...a) => h.registered.push(a), notify: () => {} },
    backupSources: [], backups: { register: (d) => { h.backupSources.push(d); return () => {}; } },
  };
  return h;
}
const res = () => { const r = { headers: {}, body: null, statusCode: 200 }; r.json = (b) => { r.body = b; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; r.type = () => r; r.send = (b) => { r.body = b; return r; }; r.status = (c) => { r.statusCode = c; return r; }; return r; };

test('activate: Routen, Dienst, Sicherung, Anlass – und sauberes Herunterfahren', async () => {
  const h = fakeHost();
  const svc = mod.activate(h);
  try {
    for (const r of ['GET /mail-accounts', 'POST /mail-accounts/discover', 'POST /mail-accounts/accounts', 'GET /mail-accounts/messages', 'GET /mail-accounts/message', 'POST /mail-accounts/send', 'GET /mail-accounts/export', 'POST /mail-accounts/oauth/start']) assert.ok(h.routes.has(r), r);
    assert.ok(h.pub.has('GET /pub/oauth'), 'OAuth-Rücksprung öffentlich (prüft state)');
    assert.ok(h.provided.mailAccounts && typeof h.provided.mailAccounts.unread === 'function');
    assert.strictEqual(h.registered[0][0], 'new-mail');
    assert.strictEqual(h.backupSources.length, 1);
    const r = res();
    await h.routes.get('GET /mail-accounts')({ query: {} }, r);
    assert.deepStrictEqual(r.body.accounts, []);
    assert.strictEqual(r.body.prefs.undoSeconds, 10);
    // Rücksprung mit falschem state: freundliche Seite, keine Token
    const p = res();
    await h.pub.get('GET /pub/oauth')({ query: { state: 'falsch', code: 'x' } }, p);
    assert.match(String(p.body), /Sign-in didn’t work/);
    assert.match(p.headers['Content-Security-Policy'], /default-src 'none'/);
    // Geheimnisse: ohne Hostwerks Schlüssel eigener Rückfall
    assert.match(svc.secrets.seal('x'), /^mak:/);
  } finally {
    for (const fn of h.hooks.shutdown) await fn();
  }
});
