'use strict';
/*
 * Kontakte aus Mails – nur lokal, nie hochgeladen. Wer dir schreibt und wem du schreibst, landet hier (Name, wie oft,
 * zuletzt), damit beim Schreiben Vorschläge kommen. Höchstens 5000 Einträge; die am längsten unbenutzten fallen raus.
 */
const path = require('path');
const { readJson, writeJson } = require('./store');

const MAX = 5000;

class Contacts {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.file = path.join(dir, 'contacts.json');
    this.now = now;
    this.map = readJson(this.file, () => ({})); // address → { name, n, last, sent }
    this.timer = null;
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 2000);
    if (this.timer.unref) this.timer.unref();
  }
  flush() { try { writeJson(this.file, this.map); } catch { /* nächstes Mal */ } }
  /** sent = du hast an diese Adresse geschrieben (zählt mehr) */
  add(list, { sent = false, at = null } = {}) {
    for (const a of [].concat(list || [])) {
      const addr = String((a && a.address) || '').toLowerCase().trim();
      if (!addr || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) || /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)/.test(addr)) continue;
      const e = this.map[addr] || { name: '', n: 0, last: 0, sent: 0 };
      if (a.name && (!e.name || sent)) e.name = String(a.name).slice(0, 120);
      e.n += 1; if (sent) e.sent += 1;
      e.last = Math.max(e.last, at || this.now());
      this.map[addr] = e;
    }
    const keys = Object.keys(this.map);
    if (keys.length > MAX) for (const k of keys.sort((x, y) => this.map[x].last - this.map[y].last).slice(0, keys.length - MAX)) delete this.map[k];
    this.save();
  }
  /** Vorschläge: zuerst die, denen du schreibst, dann die häufigsten */
  find(q, limit = 8) {
    const s = String(q || '').toLowerCase().trim();
    const score = (e) => e.sent * 5 + e.n + (this.now() - e.last < 30 * 86400000 ? 3 : 0);
    return Object.entries(this.map)
      .filter(([addr, e]) => !s || addr.includes(s) || (e.name || '').toLowerCase().includes(s))
      .sort((a, b) => score(b[1]) - score(a[1])).slice(0, limit).map(([address, e]) => ({ address, name: e.name }));
  }
  remove(addr) { delete this.map[String(addr).toLowerCase()]; this.save(); }
  all() { return Object.entries(this.map).map(([address, e]) => ({ address, ...e })).sort((a, b) => b.last - a.last); }
}

module.exports = { Contacts };
