'use strict';
// Sicherheit beim Lesen: HTML-Bereinigung (Skripte, Tracker, Bilder von außen), Phishing-Regeln, Abmelde-Link.
const test = require('node:test');
const assert = require('node:assert');
const { sanitize, cleanCss, textToHtml } = require('../server/sanitize');
const { analyze, parseAuthResults, unsubscribe } = require('../server/phishing');
const { parseMessage } = require('../server/message');

test('Skripte, Ereignisse, Formulare, Rahmen und javascript:-Links fliegen raus', () => {
  const r = sanitize(`<p onclick="alert(1)">Hallo</p><script>alert(2)</script><iframe src="https://x.example"></iframe><form action="https://x.example"><input name="pw"></form>
    <a href="javascript:alert(3)">klick</a><a href="https://bank.example/login">Bank</a><object data="x.swf"></object><svg><script>1</script></svg><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">`);
  assert.ok(!/script|onclick|iframe|<form|<input|javascript:|<object|<svg|<base|<meta/i.test(r.html), r.html);
  assert.match(r.html, /data-hw-href="https:\/\/bank\.example\/login"/);
  assert.deepStrictEqual(r.links, [{ href: 'https://bank.example/login', text: 'Bank' }]);
});

test('Bilder von außen erst auf Wunsch, Zählpixel immer raus, cid: wird eingebettet', () => {
  const html = '<img src="https://cdn.example/logo.png" alt="Logo" width="120"><img src="https://t.example/open/abc.gif" width="1" height="1"><img src="https://x.example/p.gif" style="display:none"><img src="cid:bild1@x">';
  const r = sanitize(html, { cid: { 'bild1@x': 'data:image/png;base64,AAAA' } });
  assert.strictEqual(r.trackers, 2);
  assert.strictEqual(r.remoteImages, 1);
  assert.ok(!/\ssrc="https:/.test(r.html), 'kein Laden von außen');
  assert.match(r.html, /data-hw-src="https:\/\/cdn\.example\/logo\.png"/);
  assert.match(r.html, /src="data:image\/png;base64,AAAA"/);
  const r2 = sanitize(html, { remote: true });
  assert.match(r2.html, /\ssrc="https:\/\/cdn\.example\/logo\.png"/);
  assert.strictEqual(r2.trackers, 2, 'Zählpixel auch mit erlaubten Bildern weg');
});

test('CSS: kein url() nach außen, kein @import, kein fixed', () => {
  assert.strictEqual(cleanCss('@import url(https://x.example/a.css); body{background:url("https://t.example/p.gif")}', false).includes('https://'), false);
  assert.match(cleanCss('div{position:fixed;top:0}'), /position: static/);
  assert.match(cleanCss('a{background:url(data:image/png;base64,AA)}'), /data:image/);
  const r = sanitize('<div style="background-image:url(https://t.example/x.gif);color:red">x</div><style>p{background:url(https://t.example/y.gif)}</style>');
  assert.ok(!r.html.includes('https://t.example'), r.html);
});

test('Klartext wird sicheres HTML mit Links und Zitat-Ebenen', () => {
  const h = textToHtml('Hallo <b>\n> zitiert https://a.example/x\n>> tiefer');
  assert.match(h, /&lt;b&gt;/);
  assert.match(h, /<blockquote>[\s\S]*<blockquote>/);
  assert.match(h, /data-hw-href="https:\/\/a\.example\/x"/);
});

test('Phishing: gefälschter Name, falscher Linktext, fehlgeschlagene Prüfung, Anhang', () => {
  const r = analyze({
    from: { name: 'PayPal service@paypal.example', address: 'x@gauner.example' },
    replyTo: [{ address: 'antwort@anderswo.example' }],
    headers: { 'authentication-results': ['mx.anbieter.example; spf=fail smtp.mailfrom=gauner.example; dkim=none; dmarc=fail header.from=gauner.example', 'spf=pass (vom Absender eingeschmuggelt)'] },
    links: [{ href: 'https://login.gauner.example/paypal', text: 'www.paypal.example' }, { href: 'http://203.0.113.9/x', text: 'hier' }, { href: 'https://xn--pypal-4ve.example/', text: 'Konto' }],
    attachments: [{ filename: 'rechnung.pdf.exe' }],
  });
  assert.strictEqual(r.level, 'danger');
  const codes = r.hints.map((h) => h.code);
  for (const c of ['auth', 'name-address', 'reply-to', 'link-mismatch', 'ip-link', 'punycode', 'attachment']) assert.ok(codes.includes(c), c);
  assert.deepStrictEqual(r.auth, { spf: 'fail', dkim: 'none', dmarc: 'fail' }, 'nur der oberste Kopf zählt');
});

test('Phishing: normale Mail ohne Hinweise', () => {
  const r = analyze({ from: { name: 'Anna Beispiel', address: 'anna@firma.example' }, headers: { 'authentication-results': 'mx.example; spf=pass; dkim=pass; dmarc=pass' }, links: [{ href: 'https://www.firma.example/a', text: 'firma.example' }, { href: 'https://news.firma.example/x', text: 'Hier lesen' }] });
  assert.deepStrictEqual([r.level, r.hints.length], ['ok', 0]);
  assert.deepStrictEqual(parseAuthResults(''), { spf: null, dkim: null, dmarc: null });
});

test('List-Unsubscribe: Ein-Klick nur mit https und List-Unsubscribe-Post', () => {
  assert.deepStrictEqual(unsubscribe({ 'list-unsubscribe': '<mailto:off@x.example>, <https://x.example/u?id=1>', 'list-unsubscribe-post': 'List-Unsubscribe=One-Click' }), { http: 'https://x.example/u?id=1', mailto: 'mailto:off@x.example', oneClick: true });
  assert.strictEqual(unsubscribe({ 'list-unsubscribe': '<mailto:off@x.example>' }).oneClick, false);
  assert.strictEqual(unsubscribe({}), null);
});

test('Ganze Mail: Ansicht mit bereinigtem HTML, Prüfergebnis und Abmelde-Link', async () => {
  const raw = ['From: "Bank" <info@bank.example>', 'To: anna@example.test', 'Subject: Wichtig', 'Message-ID: <x1@bank.example>', 'Authentication-Results: mx.example; dkim=fail; spf=fail; dmarc=fail',
    'List-Unsubscribe: <https://bank.example/u>', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', '<p>Hallo <img src="https://bank.example/t.gif" width="1" height="1"><a href="https://evil.example">https://bank.example/login</a><script>x()</script></p>'].join('\r\n');
  const v = await parseMessage(Buffer.from(raw));
  assert.ok(!/script/.test(v.html));
  assert.strictEqual(v.trackers, 1);
  assert.strictEqual(v.phishing.level, 'danger');
  assert.strictEqual(v.unsubscribe.http, 'https://bank.example/u');
  assert.match(v.snippet, /Hallo/);
});
