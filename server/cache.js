'use strict';
/*
 * Zwischenspeicher für Offline-Lesen und schnelle Listen – begrenzt, nie unbegrenzt wachsend.
 *   msg/<hash>.eml    Rohtext einer Mail (für Anhänge, Export, erneutes Anzeigen)
 *   msg/<hash>.json   bereinigte Ansicht (ohne Anhang-Inhalte) + Metadaten für die lokale Suche
 *   list/<hash>.json  erste Seite eines Ordners (für den ersten Blick und offline)
 * Grenze in MB (Einstellung): beim Überschreiten fliegen die am längsten nicht geöffneten Mails raus (LRU über die
 * Zugriffszeit, die der Speicher selbst führt – nicht über atime des Dateisystems, die oft abgeschaltet ist).
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, hash } = require('./store');

class Cache {
  constructor(dir, { limitMB = 300, now = () => Date.now() } = {}) {
    this.dir = dir;
    this.msgDir = path.join(dir, 'msg');
    this.listDir = path.join(dir, 'list');
    this.now = now;
    this.limit = limitMB * 1024 * 1024;
    this.indexFile = path.join(dir, 'index.json');
    this.index = readJson(this.indexFile, () => ({})); // key → { h, bytes, used, account, folder, uid, subject, from, date, text }
    this.dirty = false;
    this.timer = null;
    // Einträge ohne Dateien (z. B. von Hand gelöscht) verwerfen
    for (const [k, v] of Object.entries(this.index)) if (!fs.existsSync(path.join(this.msgDir, `${v.h}.json`))) delete this.index[k];
  }
  setLimit(mb) { this.limit = Math.max(20, Math.min(20000, Number(mb) || 300)) * 1024 * 1024; this.evict(); }
  bytes() { return Object.values(this.index).reduce((n, e) => n + (e.bytes || 0), 0); }
  stats() { return { bytes: this.bytes(), count: Object.keys(this.index).length, limit: this.limit }; }
  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1500);
    if (this.timer.unref) this.timer.unref();
  }
  flush() { if (!this.dirty) return; this.dirty = false; try { writeJson(this.indexFile, this.index); } catch { /* nächster Versuch */ } }

  /** key = konto|ordner|uidvalidity|uid */
  get(key) {
    const e = this.index[key];
    if (!e) return null;
    const view = readJson(path.join(this.msgDir, `${e.h}.json`), null);
    if (!view) { delete this.index[key]; this.save(); return null; }
    e.used = this.now();
    this.save();
    return view;
  }
  raw(key) {
    const e = this.index[key];
    if (!e) return null;
    try { e.used = this.now(); this.save(); return fs.readFileSync(path.join(this.msgDir, `${e.h}.eml`)); } catch { return null; }
  }
  has(key) { return !!this.index[key]; }
  put(key, raw, view, meta = {}) {
    if (this.limit <= 0) return;
    fs.mkdirSync(this.msgDir, { recursive: true });
    const h = hash(key);
    const json = JSON.stringify(view);
    const bytes = (raw ? raw.length : 0) + Buffer.byteLength(json);
    if (bytes > this.limit / 4) return; // einzelne Riesenmail nicht zwischenspeichern
    if (raw) fs.writeFileSync(path.join(this.msgDir, `${h}.eml`), raw);
    fs.writeFileSync(path.join(this.msgDir, `${h}.json`), json);
    this.index[key] = { h, bytes, used: this.now(), ...meta, text: String((view && view.text) || '').slice(0, 4000).toLowerCase() };
    this.save();
    this.evict();
  }
  /** Mail aus dem Speicher nehmen (gelöscht/verschoben) */
  drop(key) {
    const e = this.index[key];
    if (!e) return;
    for (const ext of ['eml', 'json']) { try { fs.unlinkSync(path.join(this.msgDir, `${e.h}.${ext}`)); } catch { /* egal */ } }
    delete this.index[key];
    this.save();
  }
  /** Alles eines Kontos entfernen (Konto gelöscht) */
  dropAccount(account) {
    for (const [k, e] of Object.entries(this.index)) if (e.account === account) this.drop(k);
    try { for (const f of fs.readdirSync(this.listDir)) if (f.startsWith(`${hash(account).slice(0, 8)}-`)) fs.unlinkSync(path.join(this.listDir, f)); } catch { /* egal */ }
  }
  evict() {
    let total = this.bytes();
    if (total <= this.limit) return 0;
    let n = 0;
    for (const [k, e] of Object.entries(this.index).sort((a, b) => (a[1].used || 0) - (b[1].used || 0))) {
      if (total <= this.limit * 0.9) break;
      total -= e.bytes || 0;
      this.drop(k);
      n++;
    }
    return n;
  }
  clear() { for (const k of Object.keys(this.index)) this.drop(k); try { fs.rmSync(this.listDir, { recursive: true, force: true }); } catch { /* egal */ } this.flush(); }

  /* ---------- Ordnerlisten (erste Seite) ---------- */
  listFile(account, folder) { return path.join(this.listDir, `${hash(account).slice(0, 8)}-${hash(folder)}.json`); }
  getList(account, folder) { return readJson(this.listFile(account, folder), null); }
  putList(account, folder, data) { try { writeJson(this.listFile(account, folder), { ...data, at: this.now() }); } catch { /* egal */ } }

  /** Lokale Suche über zwischengespeicherte Mails (offline oder zusätzlich zur Server-Suche) */
  search(q, { account = null, folder = null, limit = 100 } = {}) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out = [];
    for (const [k, e] of Object.entries(this.index)) {
      if (account && e.account !== account) continue;
      if (folder && e.folder !== folder) continue;
      const hay = `${e.subject || ''} ${e.from || ''} ${e.text || ''}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push({ key: k, account: e.account, folder: e.folder, uid: e.uid, subject: e.subject, from: e.from, date: e.date });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => (b.date || 0) - (a.date || 0));
  }
}

module.exports = { Cache };
