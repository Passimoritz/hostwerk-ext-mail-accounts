'use strict';
/*
 * Ablage im eigenen Datenordner (data/mail-accounts/): JSON-Dateien atomar schreiben (erst Temp-Datei, dann umbenennen –
 * ein Absturz mitten im Schreiben hinterlässt nie eine halbe Datei), Geheimnisse verschlüsselt.
 *
 * Geheimnisse (Passwörter, OAuth-Token): über Hostwerks Schlüssel (host.core('secrets') – derselbe wie für die
 * Mail-Weiterleitung, liegt in der Desktop-App im Schlüsselbund des Systems). Fehlt er (ältere Fassung, Tests), nimmt die
 * Erweiterung einen eigenen Schlüssel im Datenordner (nur für den Besitzer lesbar). Gespeichert wird immer „enc:…“ bzw.
 * „mak:…“ – nie Klartext.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return typeof fallback === 'function' ? fallback() : fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

/** Eigener Rückfall-Schlüssel (AES-256-GCM), wenn Hostwerks Schlüssel fehlt. Präfix „mak:“. */
function ownSealer(dir) {
  const f = path.join(dir, 'secret.key');
  const key = () => {
    if (!fs.existsSync(f)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 }); }
    return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  };
  return {
    seal(text) {
      if (!text) return '';
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
      const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return `mak:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
    },
    open(value) {
      if (!value || !String(value).startsWith('mak:')) return '';
      try {
        const b = Buffer.from(String(value).slice(4), 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
        d.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
      } catch { return ''; }
    },
  };
}

/**
 * Geheimnisse: core = Hostwerks secrets-Modul ({ seal, open }) oder null. Liefert { seal, open } – open kann beide Formate.
 * Hostwerks Schlüssel kann gesperrt sein (Kommandozeile auf dem Ordner der Desktop-App): dann wirft seal() verständlich.
 */
function makeSecrets(core, dir) {
  const own = ownSealer(dir);
  return {
    seal(text) {
      if (!text) return '';
      if (core && typeof core.seal === 'function') {
        try { return core.seal(text); } catch (e) { if (core.isLocked && core.isLocked()) throw e; }
      }
      return own.seal(text);
    },
    open(value) {
      if (!value) return '';
      const v = String(value);
      if (v.startsWith('mak:')) return own.open(v);
      if (v.startsWith('enc:') && core && typeof core.open === 'function') { try { return core.open(v) || ''; } catch { return ''; } }
      return '';
    },
    isSealed: (v) => !v || /^(enc|mak):/.test(String(v)),
  };
}

const newId = (n = 8) => crypto.randomBytes(n).toString('hex');
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

module.exports = { readJson, writeJson, makeSecrets, ownSealer, newId, hash };
