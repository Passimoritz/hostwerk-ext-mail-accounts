'use strict';
/*
 * Eine Mail lesbar machen: Rohtext (RFC 5322) → Ansicht für die Oberfläche.
 *   view = { subject, from, to, cc, bcc, replyTo, date, messageId, inReplyTo, references, html (bereinigt), text, snippet,
 *            attachments: [{ i, filename, contentType, size, inline, cid }], remoteImages, trackers, links, phishing,
 *            unsubscribe, priority, threadKey }
 * Dazu Listeneinträge aus dem IMAP-Umschlag (envelope) und Konversationen (Threads).
 */
const { simpleParser } = require('./libs');
const { sanitize, textToHtml, htmlToText } = require('./sanitize');
const { analyze, unsubscribe } = require('./phishing');

const MAX_INLINE_DATA = 2 * 1024 * 1024; // eingebettete Bilder (cid:) bis 2 MB direkt in die Ansicht

const addrList = (v) => (v && v.value ? v.value : Array.isArray(v) ? v.flatMap((x) => (x && x.value) || []) : [])
  .flatMap((a) => (a.group ? a.group : [a])).map((a) => ({ name: a.name || '', address: (a.address || '').toLowerCase() })).filter((a) => a.address || a.name);

/** Betreff ohne Re:/AW:/Fwd:/WG:/[Liste] – für Konversationen. */
function baseSubject(s) {
  let x = String(s || '').trim();
  for (let i = 0; i < 6; i++) {
    const y = x.replace(/^\s*((re|aw|wg|fw|fwd|sv|vs|antw|r|tr)(\[\d+\])?\s*:\s*|\[[^\]]{1,40}\]\s*)/i, '');
    if (y === x) break;
    x = y;
  }
  return x.toLowerCase().replace(/\s+/g, ' ').trim();
}
const ids = (s) => (String(s || '').match(/<[^<>\s]+>/g) || []).map((x) => x.toLowerCase());

/** Schlüssel einer Konversation: erste Message-ID der Kette, sonst Betreff ohne Präfixe. */
function threadKey({ references, inReplyTo, messageId, subject }) {
  const refs = Array.isArray(references) ? references.map((x) => String(x).toLowerCase()) : ids(references);
  const root = refs[0] || ids(inReplyTo)[0];
  if (root) return `m:${root}`;
  const b = baseSubject(subject);
  return b ? `s:${b}` : `m:${String(messageId || '').toLowerCase()}`;
}

/**
 * Konversationen bilden: Einträge mit gemeinsamer Kette landen zusammen (auch wenn ein Teil per Betreff, ein anderer per
 * Message-ID verkettet ist). items: [{ key, messageId, threadKey, subject, date }] → [{ key, items: [neueste zuerst] }]
 */
function threads(items) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const node = (k) => { if (!parent.has(k)) parent.set(k, k); return k; };
  for (const it of items) {
    node(it.threadKey);
    if (it.messageId) union(node(`m:${String(it.messageId).toLowerCase()}`), it.threadKey);
    const b = baseSubject(it.subject);
    if (b && b.length > 3 && /^m:/.test(it.threadKey)) union(node(`s:${b}`), it.threadKey);
  }
  const groups = new Map();
  for (const it of items) {
    const r = find(it.threadKey);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  }
  return [...groups.values()].map((list) => ({ key: list[0].key, items: list.sort((a, b) => (b.date || 0) - (a.date || 0)) }))
    .sort((a, b) => (b.items[0].date || 0) - (a.items[0].date || 0));
}

/** IMAP-Umschlag + Flags → Listeneintrag */
function fromEnvelope(msg, { account, folder }) {
  const env = msg.envelope || {};
  const conv = (l) => (l || []).map((a) => ({ name: a.name || '', address: String(a.address || '').toLowerCase() }));
  const headers = String(msg.headers ? msg.headers.toString('utf8') : '');
  const head = (name) => { const m = new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n[^\\s]|$)`, 'im').exec(headers); return m ? m[1].replace(/\r?\n\s+/g, ' ').trim() : ''; };
  const flags = [...(msg.flags || [])];
  const ct = head('content-type').toLowerCase();
  const references = ids(head('references'));
  const date = env.date ? new Date(env.date).getTime() : msg.internalDate ? new Date(msg.internalDate).getTime() : null;
  const item = {
    key: `${account}|${folder}|${msg.uid}`, account, folder, uid: msg.uid,
    subject: env.subject || '', from: conv(env.from)[0] || null, to: conv(env.to), cc: conv(env.cc),
    date, size: msg.size || 0, messageId: env.messageId || '', inReplyTo: env.inReplyTo || '',
    seen: flags.includes('\\Seen'), flagged: flags.includes('\\Flagged'), answered: flags.includes('\\Answered'), draft: flags.includes('\\Draft'),
    forwarded: flags.includes('$Forwarded'), attachment: /multipart\/(mixed|report)/.test(ct), list: !!head('list-unsubscribe') || !!head('list-id'),
  };
  item.threadKey = threadKey({ references, inReplyTo: item.inReplyTo, messageId: item.messageId, subject: item.subject });
  return item;
}

/** Rohtext → Ansicht. opts: { remote: Bilder von außen laden, lang } */
async function parseMessage(raw, opts = {}) {
  const p = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 4 * 1024 * 1024 });
  const atts = (p.attachments || []).map((a, i) => ({
    i, filename: a.filename || (a.contentType === 'message/rfc822' ? 'message.eml' : `attachment-${i + 1}`), contentType: a.contentType || 'application/octet-stream',
    size: a.size || (a.content ? a.content.length : 0), inline: a.contentDisposition === 'inline' || !!a.related, cid: a.contentId ? String(a.contentId).replace(/^<|>$/g, '').toLowerCase() : null,
    content: a.content,
  }));
  const cid = {};
  for (const a of atts) if (a.cid && a.content && a.content.length <= MAX_INLINE_DATA && /^image\//.test(a.contentType)) cid[a.cid] = `data:${a.contentType};base64,${a.content.toString('base64')}`;
  const usedCid = new Set();
  const rawHtml = p.html || '';
  for (const m of String(rawHtml).matchAll(/cid:([^"'\s)>]+)/gi)) usedCid.add(m[1].toLowerCase());
  const s = rawHtml ? sanitize(rawHtml, { remote: !!opts.remote, cid }) : sanitize(textToHtml(p.text || ''), { remote: false });
  const text = p.text || htmlToText(rawHtml);
  const headers = {};
  for (const [k, v] of p.headers) headers[k] = typeof v === 'string' ? v : v && v.text ? v.text : v && v.value !== undefined && typeof v.value === 'string' ? v.value : v;
  // Authentication-Results darf mehrfach vorkommen – alle Zeilen in Reihenfolge (oben = vom eigenen Anbieter)
  const authAll = (p.headerLines || []).filter((h) => h.key === 'authentication-results').map((h) => h.line.replace(/^authentication-results:\s*/i, ''));
  const from = addrList(p.from)[0] || null;
  const replyTo = addrList(p.replyTo);
  const attachments = atts.filter((a) => !(a.inline && a.cid && usedCid.has(a.cid))).map(({ content, ...rest }) => rest); // eslint-disable-line no-unused-vars
  const view = {
    subject: p.subject || '', from, to: addrList(p.to), cc: addrList(p.cc), bcc: addrList(p.bcc), replyTo,
    date: p.date ? p.date.getTime() : null, messageId: p.messageId || '', inReplyTo: p.inReplyTo || '',
    references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
    html: s.html, plain: !rawHtml, text: text.slice(0, 200000), snippet: text.replace(/\s+/g, ' ').trim().slice(0, 200),
    attachments, remoteImages: s.remoteImages, trackers: s.trackers, links: s.links.length,
    priority: /^(1|2)/.test(String(headers['x-priority'] || '')) || /high|urgent/i.test(String(headers.importance || headers.priority || '')),
    unsubscribe: unsubscribe({ 'list-unsubscribe': headerText(p, 'list-unsubscribe'), 'list-unsubscribe-post': headerText(p, 'list-unsubscribe-post') }),
    phishing: analyze({ from, replyTo, headers: { 'authentication-results': authAll.length ? authAll : headers['authentication-results'] }, links: s.links, attachments }),
    dispositionTo: headerText(p, 'disposition-notification-to') ? true : false,
  };
  view.threadKey = threadKey(view);
  return view;
}
function headerText(p, k) { const l = (p.headerLines || []).find((h) => h.key === k); return l ? l.line.replace(new RegExp(`^${k}:\\s*`, 'i'), '').replace(/\r?\n\s+/g, ' ').trim() : ''; }

/** Anhang i aus dem Rohtext */
async function attachment(raw, i) {
  const p = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const a = (p.attachments || [])[Number(i)];
  if (!a) return null;
  return { filename: a.filename || `attachment-${Number(i) + 1}`, contentType: a.contentType || 'application/octet-stream', content: a.content };
}

module.exports = { parseMessage, attachment, fromEnvelope, threads, threadKey, baseSubject, addrList };
