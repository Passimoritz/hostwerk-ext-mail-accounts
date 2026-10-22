'use strict';
/*
 * Einstellungen zu einer E-Mail-Adresse finden – ohne eigene Anbieterliste, die gepflegt werden müsste.
 * Reihenfolge wie Thunderbird (die Quellen pflegen Anbieter bzw. Mozilla selbst):
 *   1. Autoconfig des Anbieters      https://autoconfig.<domain>/mail/config-v1.1.xml?emailaddress=…
 *                                    https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml
 *   2. Mozillas ISPDB                https://autoconfig.thunderbird.net/v1.1/<domain>
 *   3. MX-Rückschluss                MX der Domain → Domain des Mail-Hosters → ISPDB/Autoconfig dort (eigene Domain bei Google, Microsoft, IONOS …)
 *   4. DNS-SRV (RFC 6186/8314)       _imaps._tcp, _imap._tcp, _submissions._tcp, _submission._tcp
 *   5. Microsoft-Autodiscover        https://autodiscover.<domain>/autodiscover/autodiscover.xml (POX)
 *   6. Raten mit Probe               imap.<domain>, mail.<domain> … – nur Verbindung und Begrüßung, nie Zugangsdaten
 * Ergebnis: { found, source, domain, provider, imap, smtp, oauth2, docs, enable, auth, username }.
 * Alles ist austauschbar (io: fetch, resolveMx, resolveSrv, probe) – die Tests laufen ohne Netz.
 */
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const ISPDB = 'https://autoconfig.thunderbird.net/v1.1/';
const UA = 'Hostwerk-mail-accounts';

/* ---------- XML: genug für Autoconfig und Autodiscover (flach, ohne Namensräume) ---------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
}).trim();
/** Alle Vorkommen eines Elements (ohne Namensraum-Präfix): [{ attrs, inner }] */
function elements(xml, name) {
  const out = [];
  const re = new RegExp(`<(?:[\\w-]+:)?${name}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}\\s*>)`, 'gi');
  for (const m of String(xml).matchAll(re)) {
    const attrs = {};
    for (const a of (m[1] || '').matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = decode(a[3] ?? a[4]);
    out.push({ attrs, inner: m[2] || '' });
  }
  return out;
}
const first = (xml, name) => { const e = elements(xml, name)[0]; return e ? decode(e.inner) : ''; };

const SOCKET = { ssl: 'tls', tls: 'tls', starttls: 'starttls', plain: 'none' };
/** %EMAILADDRESS% usw. einsetzen */
function fill(s, email) {
  const [local, domain] = String(email).split('@');
  return String(s || '').replace(/%EMAILADDRESS%/g, email).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILDOMAIN%/g, domain || '');
}

/**
 * Autoconfig-XML (ISPDB, Format v1.1) → Einstellungen. Nimmt den ersten IMAP- und SMTP-Eintrag mit Verschlüsselung
 * (unverschlüsselte nur, wenn es keinen anderen gibt). lang = Sprache für Beschreibungen.
 */
function parseAutoconfig(xml, email, lang = 'de') {
  if (!/<clientConfig[\s>]/i.test(xml)) return null;
  const prov = elements(xml, 'emailProvider')[0];
  if (!prov) return null;
  const server = (e) => {
    const auths = elements(e.inner, 'authentication').map((a) => decode(a.inner));
    return {
      host: fill(first(e.inner, 'hostname'), email).toLowerCase(),
      port: Number(first(e.inner, 'port')) || null,
      security: SOCKET[first(e.inner, 'socketType').toLowerCase()] || 'tls',
      username: fill(first(e.inner, 'username') || '%EMAILADDRESS%', email),
      auth: auths.map((a) => (/oauth2/i.test(a) ? 'oauth2' : /password/i.test(a) ? 'password' : a.toLowerCase())).filter((a, i, l) => l.indexOf(a) === i),
    };
  };
  const pick = (list) => list.filter((s) => s.host && s.port).sort((a, b) => (a.security === 'none') - (b.security === 'none'))[0] || null;
  const imap = pick(elements(prov.inner, 'incomingServer').filter((e) => (e.attrs.type || '').toLowerCase() === 'imap').map(server));
  const pop3 = pick(elements(prov.inner, 'incomingServer').filter((e) => (e.attrs.type || '').toLowerCase() === 'pop3').map(server));
  const smtp = pick(elements(prov.inner, 'outgoingServer').filter((e) => (e.attrs.type || 'smtp').toLowerCase() === 'smtp').map(server));
  const descr = (inner) => {
    const all = elements(inner, 'descr').concat(elements(inner, 'instruction'));
    const hit = all.find((d) => (d.attrs.lang || '').toLowerCase() === lang) || all.find((d) => !d.attrs.lang || d.attrs.lang === 'en') || all[0];
    return hit ? decode(hit.inner) : '';
  };
  const docs = elements(prov.inner, 'documentation').map((d) => ({ url: d.attrs.url || '', text: descr(d.inner) })).filter((d) => /^https:\/\//i.test(d.url));
  const enable = elements(prov.inner, 'enable').map((d) => ({ url: d.attrs.visiturl || '', text: descr(d.inner) })).filter((d) => /^https:\/\//i.test(d.url))[0] || null;
  const o = elements(xml, 'oAuth2')[0];
  const oauth2 = o ? { issuer: first(o.inner, 'issuer'), scope: first(o.inner, 'scope'), authURL: first(o.inner, 'authURL'), tokenURL: first(o.inner, 'tokenURL') } : null;
  return {
    provider: { id: prov.attrs.id || '', name: first(prov.inner, 'displayName') || first(prov.inner, 'displayShortName') || prov.attrs.id || '', short: first(prov.inner, 'displayShortName') || '' },
    domains: elements(prov.inner, 'domain').map((d) => decode(d.inner).toLowerCase()),
    imap, pop3, smtp, docs, enable,
    oauth2: oauth2 && /^https:\/\//.test(oauth2.authURL) && /^https:\/\//.test(oauth2.tokenURL) ? oauth2 : null,
  };
}

/** Microsoft-Autodiscover (POX-Antwort) → Einstellungen; Umleitung als { redirect } */
function parseAutodiscover(xml, email) {
  const redirect = first(xml, 'RedirectAddr') || first(xml, 'RedirectUrl');
  if (redirect && /redirect/i.test(first(xml, 'Action'))) return { redirect };
  const protos = elements(xml, 'Protocol').map((p) => ({
    type: first(p.inner, 'Type').toUpperCase(), host: first(p.inner, 'Server').toLowerCase(), port: Number(first(p.inner, 'Port')) || null,
    ssl: first(p.inner, 'SSL').toLowerCase() !== 'off', enc: first(p.inner, 'Encryption').toLowerCase(), login: first(p.inner, 'LoginName'),
  }));
  const conv = (p, implicitPort) => (p && p.host ? { host: p.host, port: p.port || implicitPort, security: !p.ssl ? 'none' : p.enc === 'tls' && p.port !== 993 && p.port !== 465 ? 'starttls' : p.port === 587 || p.port === 143 ? 'starttls' : 'tls', username: p.login || email, auth: ['password'] } : null);
  const imap = conv(protos.find((p) => p.type === 'IMAP'), 993);
  const smtp = conv(protos.find((p) => p.type === 'SMTP'), 587);
  if (!imap && !smtp) return null;
  return { provider: { id: '', name: first(xml, 'DisplayName') || '' }, imap, smtp, docs: [], enable: null, oauth2: null };
}

/** Registrierbare Domain grob (ohne Public-Suffix-Liste): mx01.emig.gmx.net → gmx.net, mx.example.co.uk → example.co.uk */
function baseDomain(host) {
  const p = String(host || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const sld = p[p.length - 2];
  const two = p[p.length - 1].length === 2 && /^(co|com|org|net|gov|ac|edu|or|ne|go|gv|ltd|plc)$/.test(sld);
  return p.slice(two ? -3 : -2).join('.');
}

/** Begrüßung eines Servers prüfen (ohne Anmeldung): IMAP „* OK“, SMTP „220“. */
function probe({ host, port, security }, kind, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const end = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch { /* egal */ } resolve(ok); };
    const sock = security === 'tls' ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, timeout }) : net.connect({ host, port, timeout });
    sock.setTimeout(timeout, () => end(false));
    sock.on('error', () => end(false));
    sock.once('data', (d) => end(kind === 'imap' ? /^\* (OK|PREAUTH)/i.test(String(d)) : /^220[ -]/.test(String(d))));
  });
}

/**
 * Einstellungen zu einer Adresse finden.
 * io: { fetch, resolveMx, resolveSrv, probe, offline, timeout, lang, log }
 */
async function discover(email, io = {}) {
  const addr = String(email || '').trim().toLowerCase();
  const m = /^[^@\s]+@([a-z0-9.-]+\.[a-z0-9-]{2,})$/i.exec(addr);
  if (!m) throw Object.assign(new Error('That doesn’t look like an e-mail address.'), { status: 400 });
  const domain = m[1].replace(/\.$/, '');
  const lang = io.lang === 'en' ? 'en' : 'de';
  const timeout = io.timeout || 8000;
  const tried = [];
  if (io.offline && io.offline()) return { found: false, domain, tried, offline: true };
  const doFetch = io.fetch || globalThis.fetch;
  const get = async (url, opts = {}) => {
    tried.push(url.replace(/\?.*$/, ''));
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeout);
      const r = await doFetch(url, { redirect: 'follow', ...opts, signal: ac.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
      clearTimeout(t);
      if (!r || r.status !== 200) return null;
      const text = await r.text();
      return text.length > 512 * 1024 ? null : text;
    } catch { return null; }
  };
  const fromXml = (xml, source) => { const c = xml && parseAutoconfig(xml, addr, lang); return c && c.imap ? { ...c, source } : null; };
  const autoconfigFor = async (d, viaMx = false) => {
    // Anbieter-eigene Autoconfig (bei eigener Domain) und ISPDB gleichzeitig fragen – Anbieter gewinnt
    const [own, wk, isp] = await Promise.all([
      viaMx ? null : get(`https://autoconfig.${d}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(addr)}`),
      viaMx ? null : get(`https://${d}/.well-known/autoconfig/mail/config-v1.1.xml`),
      get(`${ISPDB}${encodeURIComponent(d)}`),
    ]);
    return fromXml(own, 'autoconfig') || fromXml(wk, 'autoconfig') || fromXml(isp, viaMx ? 'ispdb-mx' : 'ispdb');
  };

  let res = await autoconfigFor(domain);
  // MX-Rückschluss: eigene Domain bei einem großen Hoster
  let mxHost = null;
  if (!res) {
    try {
      const mx = await (io.resolveMx || dns.resolveMx)(domain);
      mxHost = (mx || []).sort((a, b) => a.priority - b.priority)[0];
      mxHost = mxHost ? String(mxHost.exchange).toLowerCase() : null;
    } catch { mxHost = null; }
    const mxDomain = mxHost ? baseDomain(mxHost) : null;
    if (mxDomain && mxDomain !== domain) res = await autoconfigFor(mxDomain, true);
  }
  // DNS-SRV (RFC 6186, implizites TLS nach RFC 8314 bevorzugt)
  if (!res) {
    const srv = async (name) => {
      try { const r = await (io.resolveSrv || dns.resolveSrv)(`${name}.${domain}`); const x = (r || []).filter((e) => e.name && e.name !== '.').sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0]; return x ? { host: x.name.toLowerCase().replace(/\.$/, ''), port: x.port } : null; } catch { return null; }
    };
    const [imaps, imap, subs, sub] = await Promise.all([srv('_imaps._tcp'), srv('_imap._tcp'), srv('_submissions._tcp'), srv('_submission._tcp')]);
    tried.push(`SRV ${domain}`);
    const i = imaps ? { ...imaps, security: 'tls' } : imap ? { ...imap, security: 'starttls' } : null;
    const s = subs ? { ...subs, security: 'tls' } : sub ? { ...sub, security: 'starttls' } : null;
    if (i) res = { source: 'srv', provider: { id: domain, name: domain }, imap: { ...i, username: addr, auth: ['password'] }, smtp: s ? { ...s, username: addr, auth: ['password'] } : null, docs: [], enable: null, oauth2: null };
  }
  // Microsoft-Autodiscover (Exchange, Microsoft 365 mit eigener Domain)
  if (!res) {
    const body = `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>${addr}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;
    const post = (u) => get(u, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body });
    for (const u of [`https://autodiscover.${domain}/autodiscover/autodiscover.xml`, `https://${domain}/autodiscover/autodiscover.xml`]) {
      let xml = await post(u);
      let r = xml && parseAutodiscover(xml, addr);
      if (r && r.redirect && /^https:\/\//i.test(r.redirect)) { xml = await post(r.redirect); r = xml && parseAutodiscover(xml, addr); }
      if (r && r.imap) { res = { ...r, source: 'autodiscover' }; break; }
    }
  }
  // Raten mit Probe (nur Begrüßung, nie Zugangsdaten)
  if (!res && io.guess !== false) {
    const doProbe = io.probe || probe;
    const cands = (prefixes, ports) => prefixes.flatMap((p) => ports.map(([port, security]) => ({ host: `${p}.${domain}`, port, security })));
    const firstOk = async (list, kind) => { for (const c of list) { tried.push(`${kind} ${c.host}:${c.port}`); if (await doProbe(c, kind)) return c; } return null; };
    const i = await firstOk(cands(['imap', 'mail'], [[993, 'tls'], [143, 'starttls']]), 'imap');
    if (i) {
      const s = await firstOk(cands(['smtp', 'mail'], [[465, 'tls'], [587, 'starttls']]), 'smtp');
      res = { source: 'guess', provider: { id: domain, name: domain }, imap: { ...i, username: addr, auth: ['password'] }, smtp: s ? { ...s, username: addr, auth: ['password'] } : null, docs: [], enable: null, oauth2: null };
    }
  }
  if (!res) return { found: false, domain, mx: mxHost, tried };
  const auth = [...new Set([...(res.imap.auth || []), ...((res.smtp && res.smtp.auth) || [])])];
  return { found: true, domain, mx: mxHost, tried, ...res, auth, username: res.imap.username || addr };
}

/** Rückfall für OAuth-Endpunkte, wenn nur der Aussteller bekannt ist: OpenID-Discovery des Ausstellers. */
async function oidcEndpoints(issuer, io = {}) {
  const host = String(issuer || '').replace(/^https:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+$/i.test(host)) return null;
  try {
    const r = await (io.fetch || globalThis.fetch)(`https://${host}/.well-known/openid-configuration`, { headers: { 'User-Agent': UA } });
    if (!r || r.status !== 200) return null;
    const j = await r.json();
    return j && /^https:\/\//.test(j.authorization_endpoint) && /^https:\/\//.test(j.token_endpoint) ? { authURL: j.authorization_endpoint, tokenURL: j.token_endpoint } : null;
  } catch { return null; }
}

module.exports = { discover, parseAutoconfig, parseAutodiscover, baseDomain, probe, oidcEndpoints, elements, decode };
