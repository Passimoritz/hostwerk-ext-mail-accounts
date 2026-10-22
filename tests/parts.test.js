'use strict';
// Einzelteile: Geheimnisse, Zwischenspeicher-Grenzen, Regeln, Ruhezeiten, Kontakte, Konversationen, OAuth, Zertifikate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempDir, service } = require('./helpers');
const { makeSecrets } = require('../server/store');
const { Cache } = require('../server/cache');
const { evaluate, clean } = require('../server/rules');
const { inQuiet, Notifier } = require('../server/notify');
const { Contacts } = require('../server/contacts');
const { threads, baseSubject } = require('../server/message');
const { OAuth, xoauth2 } = require('../server/oauth');
const { classify } = require('../server/netutil');

test('Geheimnisse: verschlüsselt, mit Hostwerks Schlüssel wenn vorhanden, sonst eigenem', () => {
  const dir = tempDir();
  const own = makeSecrets(null, dir);
  const s = own.seal('geheim-123');
  assert.match(s, /^mak:/);
  assert.ok(!s.includes('geheim'));
  assert.strictEqual(own.open(s), 'geheim-123');
  assert.strictEqual(own.open('mak:kaputt'), '');
  assert.strictEqual(own.open('klartext'), '', 'Klartext wird nie als Geheimnis angenommen');
  const core = { seal: (t) => `enc:${Buffer.from(t).toString('base64')}`, open: (v) => Buffer.from(v.slice(4), 'base64').toString() };
  const withCore = makeSecrets(core, dir);
  const e = withCore.seal('pw');
  assert.match(e, /^enc:/);
  assert.strictEqual(withCore.open(e), 'pw');
  assert.strictEqual(withCore.open(s), 'geheim-123', 'alter eigener Schlüssel bleibt lesbar');
  const locked = makeSecrets({ seal: () => { throw new Error('gesperrt'); }, open: () => '', isLocked: () => true }, dir);
  assert.throws(() => locked.seal('x'), /gesperrt/);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'secret.key')).mode & 0o077, 0);
});

test('Zwischenspeicher bleibt unter der Grenze (LRU nach Zugriff)', () => {
  let now = 1000;
  const c = new Cache(tempDir(), { limitMB: 1, now: () => now });
  c.limit = 200 * 1024; // für den Test klein
  const big = Buffer.alloc(30 * 1024, 65);
  for (let i = 1; i <= 10; i++) { now += 10; c.put(`a|INBOX|${i}`, big, { subject: `m${i}`, text: `text ${i}` }, { account: 'a', folder: 'INBOX', uid: i, subject: `m${i}` }); if (i === 3) { now += 1; c.get('a|INBOX|1'); } }
  assert.ok(c.bytes() <= c.limit, `${c.bytes()} > ${c.limit}`);
  assert.ok(c.has('a|INBOX|10'));
  assert.ok(c.has('a|INBOX|1') || !c.has('a|INBOX|2'), 'zuletzt geöffnete bleiben länger');
  assert.ok(!c.has('a|INBOX|2'));
  c.put('a|INBOX|99', Buffer.alloc(120 * 1024), { subject: 'riesig' });
  assert.ok(!c.has('a|INBOX|99'), 'einzelne Riesenmail wird nicht zwischengespeichert');
  assert.strictEqual(c.search('text 10').length, 1);
  c.dropAccount('a');
  assert.strictEqual(c.stats().count, 0);
});

test('Regeln: Bedingungen, „stop“, Bereinigung', () => {
  const rules = [
    clean({ id: 'r1', conditions: [{ field: 'from', op: 'ends-with', value: '@shop.example' }, { field: 'list', op: 'contains' }], actions: [{ type: 'move', folder: 'Werbung' }, { type: 'read' }], stop: true }),
    clean({ id: 'r2', match: 'any', conditions: [{ field: 'subject', op: 'contains', value: 'rechnung' }], actions: [{ type: 'flag' }] }),
  ];
  const shop = { account: 'x', from: { name: 'Shop', address: 'news@shop.example' }, subject: 'Rechnung und Angebote', list: true };
  assert.deepStrictEqual(evaluate(rules, shop).map((x) => x.rule.id), ['r1'], 'stop beendet');
  assert.deepStrictEqual(evaluate(rules, { ...shop, list: false }).map((x) => x.rule.id), ['r2']);
  assert.throws(() => clean({ conditions: [], actions: [{ type: 'read' }] }), /condition/);
  assert.throws(() => clean({ conditions: [{ field: 'from', op: 'is', value: 'a@b' }], actions: [{ type: 'forward', to: 'x@y' }] }), /action/, 'keine Weiterleitung per Regel');
});

test('Ruhezeiten und gebündelte Meldung', () => {
  const q = { on: true, from: '22:00', to: '07:00' };
  assert.strictEqual(inQuiet(q, new Date(2026, 9, 22, 23, 30)), true);
  assert.strictEqual(inQuiet(q, new Date(2026, 9, 22, 6, 59)), true);
  assert.strictEqual(inQuiet(q, new Date(2026, 9, 22, 7, 0)), false);
  assert.strictEqual(inQuiet({ on: false, from: '0:00', to: '23:59' }, new Date()), false);
  const sent = [];
  const n = new Notifier({ send: (m) => sent.push(m), prefs: () => ({ notify: true }), t: (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => v[k]), delay: 100000 });
  n.push([{ from: { name: 'A' }, subject: 'eins' }, { from: { name: 'B' }, subject: 'zwei' }]);
  const msg = n.flush();
  n.stop();
  assert.strictEqual(msg.title, '2 new mails');
  assert.match(msg.text, /A: eins\nB: zwei/);
});

test('Kontakte: nur echte Adressen, wem du schreibst zuerst, Grenze', () => {
  const c = new Contacts(tempDir());
  c.add([{ name: 'Bob', address: 'bob@x.example' }, { address: 'noreply@x.example' }, { address: 'kaputt' }]);
  c.add([{ name: 'Bea', address: 'bea@x.example' }], { sent: true });
  assert.deepStrictEqual(c.find('').map((x) => x.address), ['bea@x.example', 'bob@x.example']);
  assert.deepStrictEqual(c.find('bob').map((x) => x.name), ['Bob']);
  clearTimeout(c.timer);
});

test('Konversationen über Message-ID-Kette und Betreff', () => {
  assert.strictEqual(baseSubject('AW: Re: [Liste] WG: Treffen'), 'treffen');
  const g = threads([
    { key: 'a', messageId: '<1@x>', threadKey: 'm:<1@x>', subject: 'Treffen', date: 1 },
    { key: 'b', messageId: '<2@x>', threadKey: 'm:<1@x>', subject: 'Re: Treffen', date: 2 },
    { key: 'c', messageId: '<3@x>', threadKey: 's:anderes', subject: 'Anderes', date: 3 },
  ]);
  assert.deepStrictEqual(g.map((x) => x.items.map((i) => i.key)), [['c'], ['b', 'a']]);
});

test('OAuth: PKCE-Start, Rücksprung, Token erneuern – gegen nachgebildeten Endpunkt', async () => {
  let now = 1000000;
  const calls = [];
  const fetch = async (url, o) => {
    const p = Object.fromEntries(new URLSearchParams(o.body));
    calls.push(p);
    if (p.grant_type === 'authorization_code') return { ok: true, status: 200, json: async () => ({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 }) };
    if (p.grant_type === 'refresh_token' && p.refresh_token === 'rt1') return { ok: true, status: 200, json: async () => ({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }) };
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
  };
  const o = new OAuth({ fetch, now: () => now });
  const s = o.start({ clientId: 'meine-app', authURL: 'https://login.example/auth', tokenURL: 'https://login.example/token', scope: 'mail offline_access', redirectUri: 'http://127.0.0.1:7800/api/x/mail-accounts/pub/oauth', email: 'a@b.example' });
  const u = new URL(s.url);
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(u.searchParams.get('login_hint'), 'a@b.example');
  assert.throws(() => o.start({ clientId: 'x', authURL: 'http://unsicher', tokenURL: 'https://t', scope: 's', redirectUri: 'r' }), /https/);
  await assert.rejects(o.callback({ state: 'falsch', code: 'c' }), /expired/);
  const r = await o.callback({ state: s.state, code: 'code123' });
  assert.strictEqual(r.ok, true);
  assert.ok(calls[0].code_verifier && calls[0].code_verifier.length >= 43);
  const took = o.take(s.state);
  assert.strictEqual(took.tokens.refreshToken, 'rt1');
  assert.strictEqual(o.take(s.state), null, 'nur einmal abholbar');
  const same = await o.refresh({ clientId: 'meine-app', tokenURL: 'https://login.example/token', refreshToken: 'rt1', accessToken: 'at1', expires: now + 3600000 });
  assert.strictEqual(same.changed, false);
  now += 3600000;
  const fresh = await o.refresh({ clientId: 'meine-app', tokenURL: 'https://login.example/token', refreshToken: 'rt1', accessToken: 'at1', expires: now - 1 });
  assert.deepStrictEqual([fresh.accessToken, fresh.refreshToken, fresh.changed], ['at2', 'rt2', true]);
  await assert.rejects(o.refresh({ clientId: 'x', tokenURL: 'https://login.example/token', refreshToken: 'alt' }), /invalid_grant/);
  assert.strictEqual(Buffer.from(xoauth2('a@b', 'tok'), 'base64').toString(), 'user=a@b\x01auth=Bearer tok\x01\x01');
});

test('Fehler verständlich einordnen', () => {
  assert.strictEqual(classify({ authenticationFailed: true, message: 'x' }).code, 'auth');
  assert.strictEqual(classify({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }).code, 'cert');
  assert.strictEqual(classify({ code: 'ENOTFOUND' }).code, 'dns');
  assert.strictEqual(classify({ code: 'ECONNREFUSED' }).code, 'refused');
  assert.strictEqual(classify({ code: 'EAUTH', response: '535 5.7.8 Username and Password not accepted' }).code, 'auth');
  assert.strictEqual(classify({ code: 'INSECURE' }).code, 'insecure');
});

test('Einstellungen werden geprüft gespeichert', () => {
  const { svc } = service();
  const p = svc.setPrefs({ undoSeconds: 999, cacheMB: 50, quiet: { on: true, from: '21:30', to: 'kaputt' }, trustedSenders: ['@firma.example', 'kein-muster', 'Bob@X.example'] });
  assert.strictEqual(p.undoSeconds, 60);
  assert.deepStrictEqual(p.quiet, { on: true, from: '21:30', to: '07:00' });
  assert.deepStrictEqual(p.trustedSenders, ['@firma.example', 'bob@x.example']);
  assert.strictEqual(svc.cache.limit, 50 * 1024 * 1024);
});
