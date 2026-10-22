'use strict';
/*
 * Verbindungs-Hilfen: verständliche Fehler, Zertifikate ansehen und bewusst je Server vertrauen.
 *
 * Zertifikatsfehler werden nie still übergangen. Kann ein Server sein Zertifikat nicht belegen (selbst signiert, eigene
 * Firmen-CA, falscher Name), zeigt die Oberfläche Aussteller, Gültigkeit und Fingerabdruck – und nur, wenn der Mensch
 * genau DIESEM Zertifikat vertraut, merkt sich das Konto dessen SHA-256-Fingerabdruck. Danach gilt: dieses eine
 * Zertifikat an diesem einen Server, sonst nichts. Wechselt es, kommt die Frage wieder.
 */
const net = require('net');
const tls = require('tls');

const CERT_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_FINGERPRINT']);
const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
/** Rechner selbst oder Heimnetz – nur dort ist eine Verbindung ohne Verschlüsselung erlaubt. */
const isLocal = (host) => { const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, ''); return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || PRIVATE.test(h); };

/** TLS-Optionen für einen Server, ggf. mit gemerktem Zertifikat (trust: { fingerprint256, pem }) */
function tlsOptions(server, trust) {
  const o = { servername: net.isIP(server.host) ? undefined : server.host, minVersion: 'TLSv1.2' };
  if (trust && trust.fingerprint256 && trust.pem) {
    o.ca = [trust.pem];
    o.allowPartialTrustChain = true; // gemerktes Zwischenzertifikat als Anker (Node ≥ 22.9, ältere ignorieren es)
    o.checkServerIdentity = (host, cert) => (cert && cert.fingerprint256 === trust.fingerprint256 ? undefined : tls.checkServerIdentity(host, cert));
  }
  return o;
}

/** Fehler einordnen → { code, text, detail } – text ist englischer Quelltext (Deutsch über locales/de.json) */
function classify(err) {
  const e = err || {};
  const code = String(e.code || (e.cause && e.cause.code) || '');
  const msg = String(e.responseText || e.response || e.message || e);
  if (e.status === 'offline' || code === 'OFFLINE') return { code: 'offline', text: 'Offline mode is on – Hostwerk doesn’t connect right now.' };
  if (code === 'INSECURE') return { code: 'insecure', text: 'Without encryption Hostwerk only connects to mail servers on this PC or in your home network.' };
  if (CERT_CODES.has(code) || /certificate|self.signed|altname/i.test(code)) return { code: 'cert', text: 'The server’s certificate can’t be verified.', detail: code };
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|invalid credentials|authentication failed|login failed|\b535\b|username and password not accepted|LOGIN failed/i.test(msg) || code === 'EAUTH') {
    return { code: 'auth', text: 'The server didn’t accept the login – check the address, password or app password.', detail: msg.slice(0, 200) };
  }
  if (/Web login required|application-specific password|app password|\bapp-specific\b|WEBALERT/i.test(msg)) return { code: 'auth', text: 'The provider wants an app password or a sign-in on its website first.', detail: msg.slice(0, 200) };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: 'dns', text: 'The server name can’t be found – is the address right, or is the internet down?', detail: code };
  if (code === 'ECONNREFUSED') return { code: 'refused', text: 'The server refuses the connection on this port.', detail: code };
  if (code === 'ETIMEDOUT' || code === 'ETIMEOUT' || code === 'CONNECT_TIMEOUT' || code === 'GREETING_TIMEOUT' || /timed? ?out/i.test(msg)) return { code: 'timeout', text: 'The server didn’t answer in time.', detail: code || msg.slice(0, 120) };
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'NoConnection' || code === 'ClosedAfterConnectTLS' || code === 'ClosedAfterConnectText') return { code: 'network', text: 'The connection broke off.', detail: code };
  if (/STARTTLS|TLS|SSL|wrong version number|EPROTO/i.test(code + msg)) return { code: 'tls', text: 'Encryption doesn’t fit this port – try SSL/TLS or STARTTLS.', detail: (code || msg).slice(0, 120) };
  return { code: 'server', text: 'The mail server reported an error.', detail: msg.slice(0, 200) };
}

/** Zertifikat ansehen, ohne etwas zu senden (bei STARTTLS: Begrüßung + STARTTLS, nie Zugangsdaten). */
function peekCertificate({ host, port, security }, kind = 'imap', timeout = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(t); try { raw && raw.destroy(); } catch { /* egal */ } try { sec && sec.destroy(); } catch { /* egal */ } return err ? reject(err) : resolve(val); };
    const t = setTimeout(() => finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeout);
    let raw = null; let sec = null;
    const upgrade = (socket) => {
      sec = tls.connect({ ...(socket ? { socket } : { port }), host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => {
        const c = sec.getPeerCertificate(true);
        if (!c || !c.raw) return finish(new Error('no certificate'));
        // Kette bis zur obersten gelieferten Stelle – die wird als Anker gemerkt
        let top = c; const seen = new Set();
        while (top.issuerCertificate && top.issuerCertificate !== top && !seen.has(top.fingerprint256)) { seen.add(top.fingerprint256); top = top.issuerCertificate; }
        let reason = sec.authorizationError ? String(sec.authorizationError) : null;
        if (!reason) { const idErr = tls.checkServerIdentity(host, c); if (idErr) reason = idErr.code || 'ERR_TLS_CERT_ALTNAME_INVALID'; }
        const pem = (x) => `-----BEGIN CERTIFICATE-----\n${x.raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
        finish(null, {
          host, port, reason, subject: c.subject ? c.subject.CN || c.subject.O || '' : '', issuer: c.issuer ? c.issuer.CN || c.issuer.O || '' : '',
          altNames: String(c.subjectaltname || '').replace(/DNS:/g, '').split(/,\s*/).filter(Boolean).slice(0, 20),
          validFrom: Date.parse(c.valid_from) || null, validTo: Date.parse(c.valid_to) || null, fingerprint256: c.fingerprint256, pem: pem(top === c ? c : top), selfSigned: top === c && !c.issuerCertificate ? true : c.issuerCertificate === c,
        });
      });
      sec.on('error', (e) => finish(e));
    };
    if (security === 'tls') { upgrade(null); return; }
    raw = net.connect({ host, port });
    raw.setEncoding('utf8');
    let buf = ''; let step = 0;
    raw.on('error', (e) => finish(e));
    raw.on('data', (d) => {
      buf += d;
      if (!/\r?\n$/.test(buf)) return;
      const lines = buf.trim().split(/\r?\n/); buf = '';
      const last = lines[lines.length - 1];
      if (kind === 'imap') {
        if (step === 0 && /^\* (OK|PREAUTH)/i.test(last)) { step = 1; raw.write('hw1 STARTTLS\r\n'); }
        else if (step === 1 && /^hw1 OK/i.test(last)) { step = 2; raw.removeAllListeners('data'); upgrade(raw); }
        else if (step === 1 && /^hw1 (NO|BAD)/i.test(last)) finish(Object.assign(new Error('STARTTLS refused'), { code: 'NO_STARTTLS' }));
      } else {
        if (step === 0 && /^220 /.test(last)) { step = 1; raw.write('EHLO hostwerk.local\r\n'); }
        else if (step === 1 && /^250 /.test(last)) { step = 2; raw.write('STARTTLS\r\n'); }
        else if (step === 2 && /^220 /.test(last)) { step = 3; raw.removeAllListeners('data'); upgrade(raw); }
        else if (/^[45]\d\d /.test(last)) finish(Object.assign(new Error('STARTTLS refused'), { code: 'NO_STARTTLS' }));
      }
    });
  });
}

module.exports = { classify, tlsOptions, peekCertificate, isLocal, CERT_CODES };
