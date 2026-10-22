'use strict';
/*
 * Phishing-Hinweise – Regeln, die ohne Listen auskommen (nichts zu pflegen):
 *   auth          SPF/DKIM/DMARC aus dem obersten Authentication-Results-Kopf (den setzt der eigene Anbieter)
 *   name-address  Anzeigename enthält eine andere Adresse/Domain als der echte Absender („PayPal <x@gauner.tld>“)
 *   reply-to      Antworten gehen an eine andere Domain als der Absender
 *   link-mismatch Linktext zeigt eine Adresse, das Ziel ist eine andere Domain
 *   ip-link       Link auf eine nackte IP-Adresse
 *   punycode      Domain mit xn-- (ähnlich aussehende Zeichen) im Absender oder in Links
 *   attachment    ausführbare oder makrofähige Anhänge
 * Ergebnis: { level: 'ok'|'info'|'warn'|'danger', auth: { spf, dkim, dmarc }, hints: [{ code, level, text, vars }] }
 * Texte englisch (Quelltext), Deutsch über locales/de.json.
 */
const { baseDomain } = require('./discover');

const RISKY = /\.(exe|scr|com|pif|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|jar|lnk|iso|img|vhdx?|reg|cpl|appx|msix|docm|xlsm|pptm|dotm|xlam|one)$/i;
const domainOf = (addr) => { const m = /@([^@>\s]+)$/.exec(String(addr || '').trim().toLowerCase()); return m ? m[1].replace(/\.$/, '') : ''; };
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[?[0-9a-f:]+\]?$/i.test(h) && h.includes(':');

/** Authentication-Results: nur der oberste Kopf zählt (weiter unten kann der Absender selbst etwas hineinschreiben). */
function parseAuthResults(value) {
  const v = String(Array.isArray(value) ? value[0] || '' : value || '').toLowerCase();
  const pick = (k) => { const m = new RegExp(`\\b${k}\\s*=\\s*([a-z]+)`).exec(v); return m ? m[1] : null; };
  return { spf: pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc') };
}

/** Sieht der Text wie eine Adresse/Domain aus? → Domain, sonst '' */
function textDomain(text) {
  const t = String(text || '').trim().toLowerCase();
  const m = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/.exec(t);
  return m ? m[1] : '';
}

/**
 * msg: { from: { name, address }, replyTo: [{ address }], headers: { 'authentication-results': … }, links: [{ href, text }], attachments: [{ filename }] }
 */
function analyze(msg) {
  const hints = [];
  const add = (code, level, text, vars) => hints.push({ code, level, text, vars: vars || {} });
  const from = msg.from || {};
  const fromDomain = domainOf(from.address);
  const fromBase = baseDomain(fromDomain);
  const auth = parseAuthResults(msg.headers && msg.headers['authentication-results']);
  const failed = ['spf', 'dkim', 'dmarc'].filter((k) => auth[k] && /^(fail|softfail|permerror)$/.test(auth[k]));
  if (auth.dmarc === 'fail' || (failed.includes('spf') && failed.includes('dkim'))) add('auth', 'danger', 'The sender could not be verified ({checks} failed) – the address may be forged.', { checks: failed.map((x) => x.toUpperCase()).join(', ') });
  else if (failed.length) add('auth', 'warn', 'Part of the sender check failed ({checks}).', { checks: failed.map((x) => x.toUpperCase()).join(', ') });

  // Anzeigename mit fremder Adresse oder Domain
  const name = String(from.name || '').toLowerCase();
  const nameAddr = /[\w.+-]+@([\w-]+\.)+[a-z]{2,}/.exec(name);
  const nameDom = nameAddr ? domainOf(nameAddr[0]) : textDomain(name.split(/\s+/).find((w) => /\.[a-z]{2,}$/.test(w)) || '');
  if (fromDomain && nameDom && baseDomain(nameDom) !== fromBase) add('name-address', 'danger', 'The name shows “{shown}”, but the mail really comes from {real}.', { shown: nameAddr ? nameAddr[0] : nameDom, real: fromDomain });

  const rt = (msg.replyTo || []).map((r) => domainOf(r.address)).find((d) => d && baseDomain(d) !== fromBase);
  if (fromDomain && rt) add('reply-to', 'info', 'Replies go to {domain}, not to the sender’s domain.', { domain: rt });

  if (/(^|\.)xn--/.test(fromDomain)) add('punycode', 'warn', 'The sender’s domain uses look-alike characters ({domain}).', { domain: fromDomain });

  let mism = 0; let ip = 0; let puny = 0;
  const seen = new Set();
  for (const l of msg.links || []) {
    const h = hostOf(l.href);
    if (!h || !/^https?:/i.test(l.href)) continue;
    const td = textDomain(l.text);
    if (td && baseDomain(td) !== baseDomain(h) && mism < 3 && !seen.has(`${td}>${h}`)) { seen.add(`${td}>${h}`); mism++; add('link-mismatch', 'danger', 'A link shows “{shown}” but leads to {real}.', { shown: td, real: h }); }
    if (isIp(h) && ip < 1) { ip++; add('ip-link', 'warn', 'A link leads to a bare IP address ({host}).', { host: h }); }
    if (/(^|\.)xn--/.test(h) && puny < 1) { puny++; add('punycode', 'warn', 'A link leads to a domain with look-alike characters ({host}).', { host: h }); }
  }
  const risky = (msg.attachments || []).map((a) => a.filename || '').filter((f) => RISKY.test(f));
  if (risky.length) add('attachment', 'warn', 'Careful with the attachment {name} – files like this can run programs or macros.', { name: risky.slice(0, 2).join(', ') });

  const order = { ok: 0, info: 1, warn: 2, danger: 3 };
  const level = hints.reduce((l, h) => (order[h.level] > order[l] ? h.level : l), 'ok');
  return { level, auth, hints };
}

/** List-Unsubscribe (RFC 2369/8058): https-Link, mailto und ob „mit einem Klick“ (POST) geht. */
function unsubscribe(headers) {
  const raw = String((headers && (headers['list-unsubscribe'] || '')) || '');
  if (!raw) return null;
  const parts = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const http = parts.find((p) => /^https:\/\//i.test(p)) || null;
  const mailto = parts.find((p) => /^mailto:/i.test(p)) || null;
  const post = /one-click/i.test(String((headers && headers['list-unsubscribe-post']) || ''));
  return http || mailto ? { http, mailto, oneClick: !!(http && post) } : null;
}

module.exports = { analyze, parseAuthResults, unsubscribe, textDomain, domainOf, RISKY };
