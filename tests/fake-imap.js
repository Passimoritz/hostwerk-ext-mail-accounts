'use strict';
/*
 * Kleiner IMAP-Server nur für die Tests (127.0.0.1, im Speicher) – genug IMAP4rev1, damit imapflow ihn wie einen echten
 * Server benutzt: LOGIN, AUTHENTICATE XOAUTH2, CAPABILITY, NAMESPACE, LIST/LSUB mit SPECIAL-USE, STATUS, SELECT/EXAMINE,
 * FETCH (UID, FLAGS, ENVELOPE, INTERNALDATE, RFC822.SIZE, BODY[]/BODY.PEEK[…], HEADER.FIELDS), STORE, SEARCH, COPY, MOVE,
 * EXPUNGE, APPEND, CREATE/DELETE/RENAME, IDLE (meldet neue Mails), NOOP, LOGOUT. TLS optional (key/cert).
 * Kein echtes Konto, kein Netz nach außen.
 */
const net = require('net');
const tls = require('tls');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const q = (s) => (s == null || s === '' ? 'NIL' : `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
const lit = (buf) => `{${buf.length}}\r\n${buf.toString('binary')}`;

function headerMap(raw) {
  const s = raw.toString('binary');
  const end = s.search(/\r?\n\r?\n/);
  const head = end < 0 ? s : s.slice(0, end);
  const map = new Map();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!map.has(k)) map.set(k, line.slice(i + 1).trim()); } }
  return { map, head: end < 0 ? s : s.slice(0, end + (s[end] === '\r' ? 4 : 2)), body: end < 0 ? '' : s.slice(end).replace(/^\r?\n\r?\n/, '') };
}
function addrList(v) {
  if (!v) return 'NIL';
  const parts = String(v).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim()).filter(Boolean);
  return `(${parts.map((p) => {
    const m = /^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/.exec(p) || [null, '', p];
    const [mb, host] = String(m[2]).split('@');
    return `(${q((m[1] || '').trim() || null)} NIL ${q(mb)} ${q(host)})`;
  }).join('')})`;
}
function envelope(raw) {
  const { map } = headerMap(raw);
  const g = (k) => map.get(k) || null;
  return `(${q(g('date'))} ${q(g('subject'))} ${addrList(g('from'))} ${addrList(g('sender') || g('from'))} ${addrList(g('reply-to') || g('from'))} ${addrList(g('to'))} ${addrList(g('cc'))} ${addrList(g('bcc'))} ${q(g('in-reply-to'))} ${q(g('message-id'))})`;
}
const idate = (d) => { const x = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `"${p(x.getUTCDate())}-${MONTHS[x.getUTCMonth()]}-${x.getUTCFullYear()} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())} +0000"`; };

/** Tokenizer für Argumente: Atome, "Strings", Literale (schon eingelesen), (Listen), BODY[...]<...> */
function tokenize(s) {
  const out = []; const stack = [out]; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if (c === '(') { const l = []; stack[stack.length - 1].push(l); stack.push(l); i++; continue; }
    if (c === ')') { stack.pop(); i++; continue; }
    if (c === '"') { let j = i + 1; let v = ''; while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; v += s[j]; j++; } stack[stack.length - 1].push({ str: v }); i = j + 1; continue; }
    if (c === '\u0000') { const j = s.indexOf('\u0001', i); stack[stack.length - 1].push({ lit: Number(s.slice(i + 1, j)) }); i = j + 1; continue; }
    let j = i; let depth = 0;
    while (j < s.length && (depth > 0 || (s[j] !== ' ' && s[j] !== ')' && s[j] !== '('))) { if (s[j] === '[') depth++; if (s[j] === ']') depth--; j++; }
    stack[stack.length - 1].push(s.slice(i, j)); i = j;
  }
  return out;
}

class FakeImap {
  /** opts: { user, pass, token (XOAUTH2), key, cert, caps } */
  constructor(opts = {}) {
    this.opts = { user: 'anna@example.test', pass: 'geheim', ...opts };
    this.boxes = new Map();
    this.uidValidity = 1000;
    for (const [name, use] of [['INBOX', null], ['Sent', '\\Sent'], ['Drafts', '\\Drafts'], ['Trash', '\\Trash'], ['Junk', '\\Junk'], ['Archive', '\\Archive']]) this.addBox(name, use);
    this.sessions = new Set();
    this.logins = 0;
    this.commands = [];
  }
  addBox(name, use = null) { this.boxes.set(name, { name, use, uidNext: 1, uidValidity: this.uidValidity++, msgs: [] }); }
  /** Mail einliefern (wie von außen) – IDLE-Sitzungen bekommen * n EXISTS */
  deliver(box, raw, { flags = [], date = Date.now() } = {}) {
    const b = this.boxes.get(box);
    const m = { uid: b.uidNext++, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw), flags: new Set(flags), date };
    b.msgs.push(m);
    for (const s of this.sessions) if (s.box === b) s.notify(`* ${b.msgs.length} EXISTS`);
    return m.uid;
  }
  listen() {
    return new Promise((resolve) => {
      const onConn = (sock) => this.session(sock);
      this.server = this.opts.key ? tls.createServer({ key: this.opts.key, cert: this.opts.cert }, onConn) : net.createServer(onConn);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }
  /** Alle Verbindungen hart trennen (Test für Wiederverbindung) */
  drop() { for (const s of this.sessions) s.sock.destroy(); }
  close() { this.drop(); return new Promise((r) => this.server.close(() => r())); }

  session(sock) {
    const srv = this;
    const caps = this.opts.caps || 'IMAP4rev1 IDLE UIDPLUS MOVE SPECIAL-USE NAMESPACE AUTH=XOAUTH2 SASL-IR';
    const st = { sock, auth: false, box: null, readOnly: false, idle: null, buf: Buffer.alloc(0), pendingLit: null, parts: [], lits: [], notify: null };
    this.sessions.add(st);
    sock.on('close', () => this.sessions.delete(st));
    sock.on('error', () => {});
    const send = (s) => { if (!sock.destroyed) sock.write(`${s}\r\n`, 'binary'); };
    st.notify = (line) => { if (st.idle) send(line); else (st.queued = st.queued || []).push(line); };
    send(`* OK [CAPABILITY ${caps}] Fake IMAP ready`);
    const flushQueued = () => { for (const l of (st.queued || []).splice(0)) send(l); };
    const seqOf = (b, uidMode, set) => {
      const out = [];
      const max = uidMode ? (b.msgs.length ? b.msgs[b.msgs.length - 1].uid : 0) : b.msgs.length;
      for (const part of String(set).split(',')) {
        const [a, z] = part.split(':');
        const lo = a === '*' ? max : Number(a); const hi = z === undefined ? lo : z === '*' ? max : Number(z);
        const [x, y] = lo <= hi ? [lo, hi] : [hi, lo];
        b.msgs.forEach((m, i) => { const k = uidMode ? m.uid : i + 1; if (k >= x && k <= y && !out.includes(i)) out.push(i); });
      }
      return out.sort((p, r) => p - r);
    };
    const flagStr = (m) => `(${[...m.flags].join(' ')})`;
    const fetchItems = (m, i, items, uidMode) => {
      const parts = [];
      const want = items.map((x) => (typeof x === 'string' ? x.toUpperCase() : x));
      if (uidMode && !want.includes('UID')) want.unshift('UID');
      for (const w of want) {
        if (w === 'UID') parts.push(`UID ${m.uid}`);
        else if (w === 'FLAGS') parts.push(`FLAGS ${flagStr(m)}`);
        else if (w === 'INTERNALDATE') parts.push(`INTERNALDATE ${idate(m.date)}`);
        else if (w === 'RFC822.SIZE') parts.push(`RFC822.SIZE ${m.raw.length}`);
        else if (w === 'ENVELOPE') parts.push(`ENVELOPE ${envelope(m.raw)}`);
        else if (typeof w === 'string' && /^BODY(\.PEEK)?\[/.test(w)) {
          const peek = /^BODY\.PEEK/.test(w);
          const sec = /\[([^\]]*)\]/.exec(w)[1];
          const partial = /<(\d+)(?:\.(\d+))?>$/.exec(w);
          let data;
          const { head, map } = headerMap(m.raw);
          if (sec === '') data = m.raw;
          else if (sec === 'HEADER') data = Buffer.from(head, 'binary');
          else if (/^HEADER\.FIELDS/.test(sec)) {
            const names = sec.replace(/^HEADER\.FIELDS(\.NOT)?\s*\(|\)$/g, '').split(/\s+/).map((x) => x.toLowerCase());
            data = Buffer.from(`${names.filter((n) => map.has(n)).map((n) => `${n}: ${map.get(n)}`).join('\r\n')}\r\n\r\n`, 'binary');
          } else if (sec === 'TEXT') data = Buffer.from(headerMap(m.raw).body, 'binary');
          else data = m.raw;
          if (partial) data = data.subarray(Number(partial[1]), partial[2] ? Number(partial[1]) + Number(partial[2]) : undefined);
          const label = w.replace('.PEEK', '').replace(/<(\d+)(?:\.\d+)?>$/, '<$1>');
          parts.push(`${label} ${lit(data)}`);
          if (!peek && !m.flags.has('\\Seen') && !st.readOnly) { m.flags.add('\\Seen'); if (!want.includes('FLAGS')) parts.push(`FLAGS ${flagStr(m)}`); }
        }
      }
      return `* ${i + 1} FETCH (${parts.join(' ')})`;
    };
    const search = (b, args) => {
      const run = (m, i, toks) => {
        let k = 0;
        const one = () => {
          const t = toks[k++];
          if (Array.isArray(t)) return run(m, i, t);
          const T = String(t && t.str !== undefined ? t.str : t).toUpperCase();
          const val = () => { const v = toks[k++]; return String(v && v.str !== undefined ? v.str : v && v.lit !== undefined ? st.lits[v.lit].toString('utf8') : v).toLowerCase(); };
          const parsed = headerMap(m.raw);
          const hdr = parsed.map;
          switch (T) {
            case 'ALL': return true;
            case 'SEEN': return m.flags.has('\\Seen');
            case 'UNSEEN': return !m.flags.has('\\Seen');
            case 'FLAGGED': return m.flags.has('\\Flagged');
            case 'UNFLAGGED': return !m.flags.has('\\Flagged');
            case 'DELETED': return m.flags.has('\\Deleted');
            case 'UNDELETED': return !m.flags.has('\\Deleted');
            case 'FROM': return (hdr.get('from') || '').toLowerCase().includes(val());
            case 'TO': return (hdr.get('to') || '').toLowerCase().includes(val());
            case 'SUBJECT': return (hdr.get('subject') || '').toLowerCase().includes(val());
            case 'BODY': return parsed.body.toLowerCase().includes(val());
            case 'TEXT': return m.raw.toString('binary').toLowerCase().includes(val());
            case 'HEADER': { const h = val(); const v = val(); return (hdr.get(h) || '').toLowerCase().includes(v); }
            case 'SINCE': case 'BEFORE': case 'ON': val(); return true;
            case 'UID': { const set = val(); return seqOf(b, true, set).includes(i); }
            case 'NOT': return !one();
            case 'OR': { const x = one(); const y = one(); return x || y; }
            default: if (/^[\d*:,]+$/.test(T)) return seqOf(b, false, T).includes(i); return true;
          }
        };
        let ok = true;
        while (k < toks.length) ok = one() && ok;
        return ok;
      };
      return b.msgs.map((m, i) => (run(m, i, args) ? i : -1)).filter((i) => i >= 0);
    };
    const handle = (tag, cmdRaw, args) => {
      let cmd = String(cmdRaw).toUpperCase();
      let uidMode = false;
      if (cmd === 'UID') { uidMode = true; cmd = String(args.shift()).toUpperCase(); }
      srv.commands.push(cmd);
      const ok = (text = `${cmd} completed`) => send(`${tag} OK ${text}`);
      const no = (text) => send(`${tag} NO ${text}`);
      const sv = (t) => (t && t.str !== undefined ? t.str : t && t.lit !== undefined ? st.lits[t.lit].toString('utf8') : String(t));
      if (cmd === 'CAPABILITY') { send(`* CAPABILITY ${caps}`); return ok(); }
      if (cmd === 'NOOP') { flushQueued(); return ok(); }
      if (cmd === 'LOGOUT') { send('* BYE bye'); ok(); return sock.end(); }
      if (cmd === 'ID') { send('* ID NIL'); return ok(); }
      if (cmd === 'LOGIN') {
        if (sv(args[0]) === srv.opts.user && sv(args[1]) === srv.opts.pass) { st.auth = true; srv.logins++; return ok(`[CAPABILITY ${caps}] Logged in`); }
        return no('[AUTHENTICATIONFAILED] Invalid credentials');
      }
      if (cmd === 'AUTHENTICATE') {
        const mech = String(args[0]).toUpperCase();
        const check = (b64) => {
          const s = Buffer.from(String(b64), 'base64').toString();
          if (mech === 'XOAUTH2' && srv.opts.token && s === `user=${srv.opts.user}\x01auth=Bearer ${srv.opts.token}\x01\x01`) { st.auth = true; srv.logins++; return ok(`[CAPABILITY ${caps}] Logged in`); }
          return no('[AUTHENTICATIONFAILED] Invalid credentials');
        };
        if (args[1]) return check(sv(args[1]));
        st.cont = (line) => { st.cont = null; check(line); };
        return send('+ ');
      }
      if (!st.auth) return send(`${tag} BAD not authenticated`);
      if (cmd === 'NAMESPACE') { send('* NAMESPACE (("" "/")) NIL NIL'); return ok(); }
      if (cmd === 'ENABLE') return ok();
      if (cmd === 'LIST' || cmd === 'LSUB') {
        for (const b of srv.boxes.values()) send(`* ${cmd} (\\HasNoChildren${b.use && cmd === 'LIST' ? ` ${b.use}` : ''}) "/" ${q(b.name)}`);
        return ok();
      }
      if (cmd === 'STATUS') {
        const b = srv.boxes.get(sv(args[0]));
        if (!b) return no('no such mailbox');
        const items = (args[1] || []).map((x) => String(x).toUpperCase());
        const val = { MESSAGES: b.msgs.length, UNSEEN: b.msgs.filter((m) => !m.flags.has('\\Seen')).length, UIDNEXT: b.uidNext, UIDVALIDITY: b.uidValidity, RECENT: 0 };
        send(`* STATUS ${q(b.name)} (${items.map((k) => `${k} ${val[k] ?? 0}`).join(' ')})`);
        return ok();
      }
      if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        const b = srv.boxes.get(sv(args[0]));
        if (!b) return no('no such mailbox');
        st.box = b; st.readOnly = cmd === 'EXAMINE';
        send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft $Forwarded)');
        send('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft $Forwarded \\*)] ok');
        send(`* ${b.msgs.length} EXISTS`);
        send('* 0 RECENT');
        send(`* OK [UIDVALIDITY ${b.uidValidity}] ok`);
        send(`* OK [UIDNEXT ${b.uidNext}] ok`);
        return ok(`[${st.readOnly ? 'READ-ONLY' : 'READ-WRITE'}] selected`);
      }
      if (cmd === 'CLOSE' || cmd === 'UNSELECT') { st.box = null; return ok(); }
      if (cmd === 'CREATE') { const n = sv(args[0]); if (srv.boxes.has(n)) return no('[ALREADYEXISTS] exists'); srv.addBox(n); return ok(); }
      if (cmd === 'DELETE') { srv.boxes.delete(sv(args[0])); return ok(); }
      if (cmd === 'RENAME') { const b = srv.boxes.get(sv(args[0])); if (!b) return no('no such'); srv.boxes.delete(b.name); b.name = sv(args[1]); srv.boxes.set(b.name, b); return ok(); }
      if (cmd === 'SUBSCRIBE' || cmd === 'UNSUBSCRIBE') return ok();
      if (cmd === 'APPEND') {
        const b = srv.boxes.get(sv(args[0]));
        if (!b) return no('[TRYCREATE] no such mailbox');
        let flags = []; let rawTok = args[args.length - 1];
        if (Array.isArray(args[1])) flags = args[1].map(String);
        const raw = st.lits[rawTok.lit];
        const m = { uid: b.uidNext++, raw, flags: new Set(flags), date: Date.now() };
        b.msgs.push(m);
        for (const s of srv.sessions) if (s !== st && s.box === b) s.notify(`* ${b.msgs.length} EXISTS`);
        return ok(`[APPENDUID ${b.uidValidity} ${m.uid}] appended`);
      }
      if (cmd === 'IDLE') {
        st.idle = tag; send('+ idling'); flushQueued(); return null;
      }
      const b = st.box;
      if (!b) return send(`${tag} BAD no mailbox selected`);
      if (cmd === 'FETCH') {
        const idx = seqOf(b, uidMode, args[0]);
        const items = Array.isArray(args[1]) ? args[1] : [args[1]];
        const expand = items.flatMap((x) => (String(x).toUpperCase() === 'ALL' ? ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'] : String(x).toUpperCase() === 'FAST' ? ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'] : [x]));
        for (const i of idx) send(fetchItems(b.msgs[i], i, expand, uidMode));
        return ok();
      }
      if (cmd === 'STORE') {
        const idx = seqOf(b, uidMode, args[0]);
        const mode = String(args[1]).toUpperCase();
        const flags = (Array.isArray(args[2]) ? args[2] : [args[2]]).map(String);
        for (const i of idx) {
          const m = b.msgs[i];
          if (/^\+/.test(mode)) flags.forEach((f) => m.flags.add(f));
          else if (/^-/.test(mode)) flags.forEach((f) => m.flags.delete(f));
          else m.flags = new Set(flags);
          if (!/SILENT/.test(mode)) send(`* ${i + 1} FETCH (${uidMode ? `UID ${m.uid} ` : ''}FLAGS ${flagStr(m)})`);
        }
        return ok();
      }
      if (cmd === 'SEARCH') {
        const a = args.slice();
        if (String(a[0]).toUpperCase() === 'CHARSET') a.splice(0, 2);
        const idx = search(b, a);
        send(`* SEARCH${idx.map((i) => ` ${uidMode ? b.msgs[i].uid : i + 1}`).join('')}`);
        return ok();
      }
      if (cmd === 'COPY' || cmd === 'MOVE') {
        const dest = srv.boxes.get(sv(args[1]));
        if (!dest) return no('[TRYCREATE] no such mailbox');
        const idx = seqOf(b, uidMode, args[0]);
        const src = []; const dst = [];
        for (const i of idx) { const m = b.msgs[i]; const n = { uid: dest.uidNext++, raw: m.raw, flags: new Set(m.flags), date: m.date }; dest.msgs.push(n); src.push(m.uid); dst.push(n.uid); }
        if (cmd === 'MOVE') {
          send(`* OK [COPYUID ${dest.uidValidity} ${src.join(',')} ${dst.join(',')}] moved`);
          for (const i of idx.slice().reverse()) { b.msgs.splice(i, 1); send(`* ${i + 1} EXPUNGE`); }
          return ok();
        }
        return ok(`[COPYUID ${dest.uidValidity} ${src.join(',')} ${dst.join(',')}] copied`);
      }
      if (cmd === 'EXPUNGE') {
        const only = uidMode ? seqOf(b, true, args[0]) : null;
        for (let i = b.msgs.length - 1; i >= 0; i--) if (b.msgs[i].flags.has('\\Deleted') && (!only || only.includes(i))) { b.msgs.splice(i, 1); send(`* ${i + 1} EXPUNGE`); }
        return ok();
      }
      return send(`${tag} BAD unknown command ${cmd}`);
    };
    // Zeilen mit Literalen einlesen
    let line = ''; let need = 0; let litBuf = null;
    sock.on('data', (chunk) => {
      st.buf = Buffer.concat([st.buf, chunk]);
      for (;;) {
        if (need > 0) {
          if (st.buf.length < need) return;
          litBuf = st.buf.subarray(0, need); st.buf = st.buf.subarray(need); need = 0;
          st.lits.push(Buffer.from(litBuf));
          line += `\u0000${st.lits.length - 1}\u0001`;
          continue;
        }
        const nl = st.buf.indexOf('\r\n');
        if (nl < 0) return;
        const part = st.buf.subarray(0, nl).toString('binary'); st.buf = st.buf.subarray(nl + 2);
        const m = /\{(\d+)(\+?)\}$/.exec(part);
        if (m) { line += part.slice(0, m.index); need = Number(m[1]); if (!m[2]) send('+ go ahead'); if (need === 0) { st.lits.push(Buffer.alloc(0)); line += `\u0000${st.lits.length - 1}\u0001`; } continue; }
        line += part;
        const full = line; line = '';
        if (st.cont) { st.cont(full); st.lits = []; continue; }
        if (st.idle) { if (full.trim().toUpperCase() === 'DONE') { const t = st.idle; st.idle = null; send(`${t} OK IDLE terminated`); } continue; }
        const sp = full.indexOf(' ');
        const tag = full.slice(0, sp);
        const rest = full.slice(sp + 1);
        const sp2 = rest.indexOf(' ');
        const cmd = sp2 < 0 ? rest : rest.slice(0, sp2);
        const args = sp2 < 0 ? [] : tokenize(rest.slice(sp2 + 1));
        try { handle(tag, cmd, args); } catch (e) { send(`${tag} BAD ${e.message}`); }
        st.lits = [];
      }
    });
  }
}

/** Kleiner SMTP-Server für die Tests: AUTH PLAIN/LOGIN, nimmt Mails an und merkt sie sich (kein Weiterleiten). */
class FakeSmtp {
  constructor(opts = {}) { this.opts = { user: 'anna@example.test', pass: 'geheim', ...opts }; this.mails = []; }
  listen() {
    return new Promise((resolve) => {
      this.server = net.createServer((sock) => {
        const send = (s) => sock.write(`${s}\r\n`);
        let buf = ''; let data = null; let from = null; let to = []; let auth = false; let loginStep = 0; let loginUser = '';
        send('220 fake.smtp ESMTP ready');
        sock.on('error', () => {});
        sock.on('data', (d) => {
          buf += d.toString('binary');
          for (;;) {
            if (data !== null) {
              const end = buf.indexOf('\r\n.\r\n');
              if (end < 0) { if (buf.startsWith('.\r\n')) { buf = buf.slice(3); } else return; }
              const raw = (data + buf.slice(0, end)).replace(/\r\n\.\./g, '\r\n.');
              buf = buf.slice(end + 5); data = null;
              this.mails.push({ from, to: to.slice(), raw: Buffer.from(raw, 'binary') });
              send('250 OK queued'); continue;
            }
            const nl = buf.indexOf('\r\n');
            if (nl < 0) return;
            const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
            if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; send('334 UGFzc3dvcmQ6'); continue; }
            if (loginStep === 2) { loginStep = 0; const p = Buffer.from(line, 'base64').toString(); if (loginUser === this.opts.user && p === this.opts.pass) { auth = true; send('235 ok'); } else send('535 5.7.8 Authentication credentials invalid'); continue; }
            const [verb, ...rest] = line.split(' ');
            const V = verb.toUpperCase();
            if (V === 'EHLO' || V === 'HELO') { sock.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n'); }
            else if (V === 'AUTH') {
              const mech = (rest[0] || '').toUpperCase();
              if (mech === 'PLAIN') { const p = Buffer.from(rest[1] || '', 'base64').toString().split('\u0000'); if (p[1] === this.opts.user && p[2] === this.opts.pass) { auth = true; send('235 ok'); } else send('535 5.7.8 Authentication credentials invalid'); }
              else if (mech === 'LOGIN') { loginStep = 1; send('334 VXNlcm5hbWU6'); }
              else send('504 unsupported');
            } else if (V === 'MAIL') { if (!auth) { send('530 auth required'); continue; } from = /<([^>]*)>/.exec(line)[1]; to = []; send('250 ok'); }
            else if (V === 'RCPT') { to.push(/<([^>]*)>/.exec(line)[1]); send('250 ok'); }
            else if (V === 'DATA') { data = ''; send('354 go'); }
            else if (V === 'RSET') { from = null; to = []; send('250 ok'); }
            else if (V === 'NOOP') send('250 ok');
            else if (V === 'QUIT') { send('221 bye'); sock.end(); }
            else send('502 unknown');
          }
        });
      });
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }
  close() { return new Promise((r) => this.server.close(() => r())); }
}

/** Testmail als Rohtext */
function mail({ from = 'Bob <bob@example.org>', to = 'anna@example.test', subject = 'Hallo', text = 'Hallo Anna', html = null, id = null, headers = {}, attach = null, date = 'Wed, 21 Oct 2026 10:00:00 +0000' } = {}) {
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const head = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: <${id || Math.random().toString(36).slice(2)}@example.org>\r\nMIME-Version: 1.0\r\n${extra}`;
  if (!html && !attach) return `${head}Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
  const b = 'BOUNDARY42';
  let body = `${head}Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n`;
  body += html ? `Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n` : `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
  if (attach) body += `--${b}\r\nContent-Type: ${attach.type}; name="${attach.name}"\r\nContent-Disposition: attachment; filename="${attach.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(attach.data).toString('base64')}\r\n`;
  return `${body}--${b}--\r\n`;
}

module.exports = { FakeImap, FakeSmtp, mail };
