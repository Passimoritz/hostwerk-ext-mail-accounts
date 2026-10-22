'use strict';
// Einstellungen finden: ISPDB-/Autoconfig-XML, Autodiscover, MX-Rückschluss, DNS-SRV – alles mit Attrappen, ohne Netz.
const test = require('node:test');
const assert = require('node:assert');
const { discover, parseAutoconfig, parseAutodiscover, baseDomain } = require('../server/discover');

// Aufbau wie in Mozillas ISPDB (gekürzt, Werte für Tests ausgedacht)
const GMAILISH = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="mailbig.example">
    <domain>mailbig.example</domain><domain>mailbig2.example</domain>
    <displayName>Mailbig Mail</displayName><displayShortName>Mailbig</displayShortName>
    <incomingServer type="imap"><hostname>imap.mailbig.example</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username><authentication>OAuth2</authentication><authentication>password-cleartext</authentication></incomingServer>
    <incomingServer type="pop3"><hostname>pop.mailbig.example</hostname><port>995</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.mailbig.example</hostname><port>465</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username><authentication>OAuth2</authentication></outgoingServer>
    <documentation url="https://support.mailbig.example/app-passwords"><descr lang="en">App passwords</descr><descr lang="de">App-Passw&#246;rter &amp; mehr</descr></documentation>
  </emailProvider>
  <oAuth2><issuer>accounts.mailbig.example</issuer><scope>https://mail.mailbig.example/</scope><authURL>https://accounts.mailbig.example/o/oauth2/auth</authURL><tokenURL>https://oauth2.mailbig.example/token</tokenURL></oAuth2>
</clientConfig>`;
const ENABLE = `<clientConfig version="1.1"><emailProvider id="frei.example"><domain>frei.example</domain><displayName>Frei-Mail</displayName>
  <incomingServer type="imap"><hostname>imap.frei.example</hostname><port>143</port><socketType>plain</socketType><username>%EMAILLOCALPART%</username><authentication>password-cleartext</authentication></incomingServer>
  <incomingServer type="imap"><hostname>imap.frei.example</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username><authentication>password-cleartext</authentication></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.frei.example</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username><authentication>password-cleartext</authentication></outgoingServer>
  <enable visiturl="https://hilfe.frei.example/imap-einschalten"><instruction lang="de">IMAP erst in den Einstellungen einschalten.</instruction><instruction>Enable IMAP first.</instruction></enable>
</emailProvider></clientConfig>`;

const resp = (status, text) => ({ status, text: async () => text, json: async () => JSON.parse(text) });

test('ISPDB-XML: Server, Verschlüsselung, Benutzername, OAuth, Doku auf Deutsch', () => {
  const c = parseAutoconfig(GMAILISH, 'anna@mailbig.example', 'de');
  assert.deepStrictEqual(c.imap, { host: 'imap.mailbig.example', port: 993, security: 'tls', username: 'anna@mailbig.example', auth: ['oauth2', 'password'] });
  assert.strictEqual(c.smtp.port, 465);
  assert.strictEqual(c.provider.name, 'Mailbig Mail');
  assert.deepStrictEqual(c.domains, ['mailbig.example', 'mailbig2.example']);
  assert.strictEqual(c.oauth2.tokenURL, 'https://oauth2.mailbig.example/token');
  assert.strictEqual(c.oauth2.scope, 'https://mail.mailbig.example/');
  assert.deepStrictEqual(c.docs, [{ url: 'https://support.mailbig.example/app-passwords', text: 'App-Passwörter & mehr' }]);
});

test('ISPDB-XML: verschlüsselt vor unverschlüsselt, %EMAILLOCALPART%, Hinweis „erst einschalten“', () => {
  const c = parseAutoconfig(ENABLE, 'bea@frei.example', 'de');
  assert.strictEqual(c.imap.port, 993);
  assert.strictEqual(c.imap.security, 'tls');
  assert.strictEqual(c.imap.username, 'bea');
  assert.strictEqual(c.smtp.security, 'starttls');
  assert.deepStrictEqual(c.enable, { url: 'https://hilfe.frei.example/imap-einschalten', text: 'IMAP erst in den Einstellungen einschalten.' });
  assert.strictEqual(parseAutoconfig('<html>nope</html>', 'x@y.z'), null);
});

test('Autodiscover (POX) und Umleitung', () => {
  const xml = `<Autodiscover xmlns="x"><Response xmlns="y"><Account><Protocol><Type>IMAP</Type><Server>outlook.firma.example</Server><Port>993</Port><SSL>on</SSL></Protocol>
    <Protocol><Type>SMTP</Type><Server>smtp.firma.example</Server><Port>587</Port><SSL>on</SSL><Encryption>TLS</Encryption></Protocol></Account></Response></Autodiscover>`;
  const c = parseAutodiscover(xml, 'chef@firma.example');
  assert.deepStrictEqual([c.imap.host, c.imap.port, c.imap.security], ['outlook.firma.example', 993, 'tls']);
  assert.deepStrictEqual([c.smtp.port, c.smtp.security], [587, 'starttls']);
  const r = parseAutodiscover('<Autodiscover><Response><Account><Action>redirectUrl</Action><RedirectUrl>https://ad.firma.example/autodiscover/autodiscover.xml</RedirectUrl></Account></Response></Autodiscover>', 'x@firma.example');
  assert.strictEqual(r.redirect, 'https://ad.firma.example/autodiscover/autodiscover.xml');
});

test('baseDomain ohne Suffix-Liste', () => {
  assert.strictEqual(baseDomain('mx01.emig.gmx.net'), 'gmx.net');
  assert.strictEqual(baseDomain('aspmx.l.google.com.'), 'google.com');
  assert.strictEqual(baseDomain('mx.example.co.uk'), 'example.co.uk');
});

test('discover: ISPDB direkt; Anbieter-Autoconfig gewinnt', async () => {
  const urls = [];
  const fetch = async (u) => { urls.push(u); if (u.startsWith('https://autoconfig.thunderbird.net/v1.1/mailbig.example')) return resp(200, GMAILISH); return resp(404, ''); };
  const r = await discover('Anna@Mailbig.example', { fetch, resolveMx: async () => [] });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.source, 'ispdb');
  assert.ok(r.auth.includes('oauth2'));
  assert.ok(urls.some((u) => u.startsWith('https://autoconfig.mailbig.example/mail/config-v1.1.xml?emailaddress=anna%40mailbig.example')));
});

test('discover: eigene Domain → MX → Hoster in der ISPDB', async () => {
  const fetch = async (u) => (u === 'https://autoconfig.thunderbird.net/v1.1/mailbig.example' ? resp(200, GMAILISH) : resp(404, ''));
  const r = await discover('chef@meine-firma.example', { fetch, resolveMx: async () => [{ exchange: 'alt1.mx.mailbig.example', priority: 5 }, { exchange: 'mx.mailbig.example', priority: 1 }] });
  assert.strictEqual(r.source, 'ispdb-mx');
  assert.strictEqual(r.mx, 'mx.mailbig.example');
  assert.strictEqual(r.imap.username, 'chef@meine-firma.example');
});

test('discover: DNS-SRV, dann Autodiscover, dann nichts', async () => {
  const none = async () => resp(404, '');
  const srv = async (name) => ({ '_imaps._tcp.srv.example': [{ name: 'mail.srv.example', port: 993, priority: 0, weight: 1 }], '_submission._tcp.srv.example': [{ name: 'mail.srv.example', port: 587, priority: 0, weight: 1 }] }[name] || Promise.reject(new Error('ENODATA')));
  const r = await discover('x@srv.example', { fetch: none, resolveMx: async () => [], resolveSrv: srv, guess: false });
  assert.deepStrictEqual([r.source, r.imap.host, r.imap.security, r.smtp.port, r.smtp.security], ['srv', 'mail.srv.example', 'tls', 587, 'starttls']);

  const ad = async (u, o) => (u === 'https://autodiscover.ex.example/autodiscover/autodiscover.xml' && o.method === 'POST' ? resp(200, '<Autodiscover><Response><Account><Protocol><Type>IMAP</Type><Server>imap.ex.example</Server><Port>993</Port><SSL>on</SSL></Protocol></Account></Response></Autodiscover>') : resp(404, ''));
  const r2 = await discover('x@ex.example', { fetch: ad, resolveMx: async () => [], resolveSrv: async () => [], guess: false });
  assert.strictEqual(r2.source, 'autodiscover');

  const r3 = await discover('x@leer.example', { fetch: none, resolveMx: async () => [], resolveSrv: async () => [], guess: false });
  assert.strictEqual(r3.found, false);
  assert.ok(r3.tried.length >= 3);
});

test('discover: Raten mit Probe, Offline-Modus, falsche Adresse', async () => {
  const none = async () => resp(404, '');
  const r = await discover('x@rate.example', { fetch: none, resolveMx: async () => [], resolveSrv: async () => [], probe: async (c, kind) => (kind === 'imap' ? c.host === 'mail.rate.example' && c.port === 993 : c.host === 'mail.rate.example' && c.port === 587) });
  assert.deepStrictEqual([r.source, r.imap.host, r.smtp.port], ['guess', 'mail.rate.example', 587]);
  const off = await discover('x@a.example', { offline: () => true });
  assert.strictEqual(off.offline, true);
  await assert.rejects(discover('keine-adresse'), /e-mail address/);
});
