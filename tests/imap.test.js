'use strict';
// IMAP-Ablauf gegen den lokalen Test-Server: anmelden, Ordner, Liste, Lesen, Flags, Verschieben, Suchen, Löschen,
// IDLE meldet neue Mails, Regeln, Wiederverbindung nach Abbruch, falsches Passwort verständlich.
const test = require('node:test');
const assert = require('node:assert');
const { FakeImap, FakeSmtp, mail } = require('./fake-imap');
const { service, until } = require('./helpers');

async function setup(opts = {}) {
  const imap = new FakeImap(opts.imap);
  await imap.listen();
  const smtp = new FakeSmtp();
  await smtp.listen();
  const h = service(opts.service);
  const acc = await h.svc.addAccount({
    email: 'anna@example.test', name: 'Anna', imap: { host: '127.0.0.1', port: imap.port, security: 'none' }, smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' },
    auth: { type: 'password', user: 'anna@example.test', pass: opts.pass || 'geheim' },
  });
  return { imap, smtp, ...h, acc, async done() { await h.svc.stop(); await imap.close(); await smtp.close(); } };
}

test('Konto anlegen prüft die Anmeldung; Passwort liegt verschlüsselt', async () => {
  const s = await setup();
  try {
    assert.strictEqual(s.acc.email, 'anna@example.test');
    assert.strictEqual(s.acc.auth.hasPass, true);
    const fs = require('fs');
    const raw = fs.readFileSync(require('path').join(s.dir, 'accounts.json'), 'utf8');
    assert.ok(!raw.includes('geheim'), 'Passwort darf nicht im Klartext stehen');
    assert.match(raw, /"pass": "mak:/);
    assert.ok(!JSON.stringify(s.svc.overview()).includes('mak:'), 'Überblick ohne Geheimnisse');
  } finally { await s.done(); }
});

test('falsches Passwort: verständlicher Fehler, kein Konto', async () => {
  const imap = new FakeImap();
  await imap.listen();
  const h = service();
  try {
    await assert.rejects(h.svc.addAccount({ email: 'anna@example.test', imap: { host: '127.0.0.1', port: imap.port, security: 'none' }, auth: { type: 'password', pass: 'falsch' } }), (e) => /login|Anmeldung|password/i.test(e.message) && e.result.imap.error.code === 'auth');
    assert.strictEqual(h.svc.accountsCfg.length, 0);
  } finally { await h.svc.stop(); await imap.close(); }
});

test('unverschlüsselt nur im eigenen Netz', async () => {
  const h = service();
  assert.throws(() => h.svc.normalize({ email: 'a@b.de', imap: { host: 'imap.example.org', port: 143, security: 'none' } }), /home network|Heimnetz/);
  assert.ok(h.svc.normalize({ email: 'a@b.de', imap: { host: '192.168.1.5', port: 143, security: 'none' } }).imap);
});

test('Ordner mit Rollen, Liste, Lesen, Flags, Verschieben, Löschen, Suchen', async () => {
  const s = await setup();
  try {
    s.imap.deliver('INBOX', mail({ subject: 'Erste', text: 'eins', id: 'm1' }));
    s.imap.deliver('INBOX', mail({ subject: 'Re: Erste', text: 'zwei', id: 'm2', headers: { 'In-Reply-To': '<m1@example.org>', References: '<m1@example.org>' } }));
    s.imap.deliver('INBOX', mail({ subject: 'Rechnung', text: 'Anhang anbei', id: 'm3', attach: { name: 'rechnung.pdf', type: 'application/pdf', data: '%PDF-1.4 test' } }));
    const folders = await s.svc.folders(s.acc.id, { fresh: true });
    const roles = Object.fromEntries(folders.filter((f) => f.role).map((f) => [f.role, f.path]));
    assert.deepStrictEqual({ inbox: roles.inbox, sent: roles.sent, trash: roles.trash, drafts: roles.drafts, archive: roles.archive }, { inbox: 'INBOX', sent: 'Sent', trash: 'Trash', drafts: 'Drafts', archive: 'Archive' });

    const page = await s.svc.messages({ account: s.acc.id, folder: 'INBOX' });
    assert.strictEqual(page.total, 3);
    assert.deepStrictEqual(page.items.map((x) => x.subject), ['Rechnung', 'Re: Erste', 'Erste']);
    assert.strictEqual(page.items[0].attachment, true);
    assert.ok(page.threads.some((t) => t.keys.length === 2), 'Antwort und Original bilden eine Konversation');

    const m = await s.svc.message(s.acc.id, 'INBOX', page.items[0].uid);
    assert.strictEqual(m.subject, 'Rechnung');
    assert.strictEqual(m.attachments.length, 1);
    assert.strictEqual(m.attachments[0].filename, 'rechnung.pdf');
    const a = await s.svc.attachment(s.acc.id, 'INBOX', page.items[0].uid, 0);
    assert.strictEqual(a.content.toString(), '%PDF-1.4 test');
    await until(() => s.imap.boxes.get('INBOX').msgs[2].flags.has('\\Seen'));

    const unread = await s.svc.messages({ account: s.acc.id, folder: 'INBOX', filter: { unread: true } });
    assert.strictEqual(unread.total, 2);
    const found = await s.svc.messages({ account: s.acc.id, folder: 'INBOX', q: 'zwei' });
    assert.deepStrictEqual(found.items.map((x) => x.subject), ['Re: Erste']);

    const it = (uid) => ({ account: s.acc.id, folder: 'INBOX', uid });
    await s.svc.setFlags([it(page.items[1].uid)], { add: ['\\Flagged'] });
    assert.ok(s.imap.boxes.get('INBOX').msgs[1].flags.has('\\Flagged'));
    await s.svc.move([it(page.items[2].uid)], { role: 'archive' });
    assert.strictEqual(s.imap.boxes.get('Archive').msgs.length, 1);
    await s.svc.remove([it(page.items[1].uid)]);
    assert.strictEqual(s.imap.boxes.get('Trash').msgs.length, 1, 'Löschen = in den Papierkorb');
    const trashUid = s.imap.boxes.get('Trash').msgs[0].uid;
    await s.svc.remove([{ account: s.acc.id, folder: 'Trash', uid: trashUid }]);
    assert.strictEqual(s.imap.boxes.get('Trash').msgs.length, 0, 'aus dem Papierkorb endgültig');
    assert.strictEqual(s.imap.boxes.get('INBOX').msgs.length, 1);
  } finally { await s.done(); }
});

test('IDLE: neue Mail kommt ohne Abfragen an, Regel greift, Benachrichtigung gebündelt', async () => {
  const s = await setup();
  try {
    s.svc.setRules([{ name: 'Newsletter', conditions: [{ field: 'from', op: 'contains', value: 'newsletter@' }], actions: [{ type: 'move', folder: 'Archive' }] }]);
    s.svc.start();
    await until(() => (s.svc.live.get(s.acc.id) || {}).status === 'online');
    await until(() => s.svc.stateCfg[s.acc.id]);
    s.imap.deliver('INBOX', mail({ from: 'Carla <carla@example.org>', subject: 'Neu da', id: 'n1' }));
    s.imap.deliver('INBOX', mail({ from: 'Shop <newsletter@shop.example>', subject: 'Angebote', id: 'n2' }));
    await until(() => s.notes.length > 0, { timeout: 8000 });
    assert.match(s.notes[0].title, /Carla/);
    assert.ok(!s.notes.some((n) => /Angebote/.test(n.text)), 'Newsletter per Regel verschoben, keine Meldung');
    await until(() => s.imap.boxes.get('Archive').msgs.length === 1);
    await until(() => (s.svc.live.get(s.acc.id) || {}).unread === 1);
    assert.ok(s.events.some((e) => e.event === 'new'));
  } finally { await s.done(); }
});

test('Wiederverbindung nach Abbruch', async () => {
  const s = await setup();
  try {
    s.svc.start();
    await until(() => (s.svc.live.get(s.acc.id) || {}).status === 'online');
    const before = s.imap.logins;
    s.imap.drop();
    await until(() => s.imap.logins > before && (s.svc.live.get(s.acc.id) || {}).status === 'online', { timeout: 10000 });
    s.imap.deliver('INBOX', mail({ subject: 'Nach dem Abbruch', id: 'r1' }));
    await until(() => s.notes.some((n) => /Bob|neue/i.test(n.title)), { timeout: 8000 });
  } finally { await s.done(); }
});

test('Offline-Lesen: Liste und Mail kommen aus dem Zwischenspeicher', async () => {
  let off = false;
  const s = await setup({ service: { offline: () => off } });
  try {
    s.imap.deliver('INBOX', mail({ subject: 'Für unterwegs', text: 'offline lesbar', id: 'o1' }));
    const page = await s.svc.messages({ account: s.acc.id, folder: 'INBOX' });
    await s.svc.message(s.acc.id, 'INBOX', page.items[0].uid);
    off = true;
    await s.svc.client(s.acc.id).close();
    const p2 = await s.svc.messages({ account: s.acc.id, folder: 'INBOX' });
    assert.strictEqual(p2.offline, true);
    assert.strictEqual(p2.items[0].subject, 'Für unterwegs');
    const m = await s.svc.message(s.acc.id, 'INBOX', page.items[0].uid);
    assert.match(m.text, /offline lesbar/);
    const local = s.svc.cache.search('unterwegs');
    assert.strictEqual(local.length, 1);
  } finally { await s.done(); }
});

test('Entwurf speichern, Antworten mit Kette, Senden mit Rückgängig-Frist und Ablage in Gesendet', async () => {
  const s = await setup();
  try {
    s.imap.deliver('INBOX', mail({ from: 'Bob <bob@example.org>', subject: 'Frage', text: 'Kommst du?', id: 'q1' }));
    const page = await s.svc.messages({ account: s.acc.id, folder: 'INBOX' });
    const d = await s.svc.compose({ mode: 'reply', account: s.acc.id, folder: 'INBOX', uid: page.items[0].uid });
    assert.strictEqual(d.subject, 'AW: Frage');
    assert.deepStrictEqual(d.to.map((x) => x.address), ['bob@example.org']);
    assert.strictEqual(d.inReplyTo, '<q1@example.org>');
    const draft = await s.svc.saveDraft({ ...d, html: '<p>Ja!</p>' + d.html });
    assert.strictEqual(draft.folder, 'Drafts');
    assert.strictEqual(s.imap.boxes.get('Drafts').msgs.length, 1);

    // Rückgängig innerhalb der Frist: nichts geht raus
    const r1 = await s.svc.send({ ...d, html: '<p>Ja!</p>', delay: 5000 });
    const back = s.svc.outbox.undo(r1.id);
    assert.ok(back && back.subject === 'AW: Frage');
    assert.strictEqual(s.smtp.mails.length, 0);

    await s.svc.send({ ...d, html: '<p>Ja, gern!</p>', delay: 0, draftRef: draft });
    await until(() => s.smtp.mails.length === 1);
    const sent = s.smtp.mails[0];
    assert.deepStrictEqual(sent.to, ['bob@example.org']);
    assert.match(sent.raw.toString(), /In-Reply-To: <q1@example\.org>/);
    await until(() => s.imap.boxes.get('Sent').msgs.length === 1);
    await until(() => s.imap.boxes.get('INBOX').msgs[0].flags.has('\\Answered'));
    await until(() => s.imap.boxes.get('Drafts').msgs.length === 0);
    assert.ok(s.svc.contacts.find('bob').length === 1);
  } finally { await s.done(); }
});

test('Senden mit falschem SMTP-Passwort bleibt im Postausgang mit Fehler', async () => {
  const s = await setup();
  try {
    s.smtp.opts.pass = 'anders';
    await s.svc.send({ account: s.acc.id, to: ['bob@example.org'], subject: 'Test', html: '<p>x</p>', delay: 0 });
    await until(() => s.svc.outbox.items.some((x) => x.state === 'failed'));
    const it = s.svc.outbox.list()[0];
    assert.strictEqual(it.error.code, 'auth');
    assert.ok(s.notes.some((n) => n.kind === 'error'));
  } finally { await s.done(); }
});

test('Export als mbox', async () => {
  const s = await setup();
  try {
    s.imap.deliver('INBOX', mail({ subject: 'Eins', text: 'From the start\r\nZeile', id: 'e1' }));
    s.imap.deliver('INBOX', mail({ subject: 'Zwei', id: 'e2' }));
    const chunks = [];
    const n = await s.svc.exportMbox(s.acc.id, 'INBOX', async (b) => { chunks.push(b); });
    const out = Buffer.concat(chunks).toString('binary');
    assert.strictEqual(n, 2);
    assert.strictEqual((out.match(/^From /gm) || []).length, 2);
    assert.match(out, /^>From the start/m, 'mboxrd: From-Zeilen im Text maskiert');
    assert.ok(!out.includes('\r\n'));
  } finally { await s.done(); }
});

test('Sicherung: Stand anlegen, ändern, zurückspielen', async () => {
  const s = await setup();
  try {
    const id = s.svc.snapshot({ force: true });
    assert.ok(id);
    await s.svc.updateAccount(s.acc.id, { name: 'Geändert' });
    await s.svc.restoreBackup(s.svc.backups().find((b) => b.id === id).id);
    assert.strictEqual(s.svc.accountsCfg[0].name, 'Anna');
  } finally { await s.done(); }
});

test('Zertifikat: Fehler wird nie still übergangen; Vertrauen nur für genau dieses Zertifikat', async (t) => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const { tempDir } = require('./helpers');
  const d = tempDir();
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=mail.test', '-days', '2', '-keyout', path.join(d, 'k.pem'), '-out', path.join(d, 'c.pem')], { stdio: 'ignore' });
  } catch { t.skip('openssl fehlt'); return; }
  const imap = new FakeImap({ key: fs.readFileSync(path.join(d, 'k.pem')), cert: fs.readFileSync(path.join(d, 'c.pem')) });
  await imap.listen();
  const h = service();
  try {
    const draft = { email: 'anna@example.test', imap: { host: '127.0.0.1', port: imap.port, security: 'tls' }, auth: { type: 'password', pass: 'geheim' } };
    await assert.rejects(h.svc.addAccount(draft), (e) => e.result.imap.error.code === 'cert');
    assert.strictEqual(imap.logins, 0, 'ohne gültiges Zertifikat geht kein Passwort raus');
    const acc = await h.svc.addAccount({ ...draft, skipTest: true });
    const cert = await h.svc.certificate(acc.id, 'imap');
    assert.strictEqual(cert.subject, 'mail.test');
    assert.match(cert.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    await assert.rejects(h.svc.trust(acc.id, 'imap', 'AA:BB'), /changed/);
    await h.svc.trust(acc.id, 'imap', cert.fingerprint256);
    const page = await h.svc.messages({ account: acc.id, folder: 'INBOX' });
    assert.strictEqual(page.total, 0);
    assert.strictEqual(imap.logins, 1);
  } finally { await h.svc.stop(); await imap.close(); }
});
