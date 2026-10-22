'use strict';
// Hilfen für die Tests: Temp-Ordner, Dienst ohne Hostwerk, Warten auf Bedingungen. Kein echtes Netz, keine echten Konten.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MailService } = require('../server/service');
const { makeSecrets } = require('../server/store');

const temps = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-mail-accounts-'));
  temps.push(d);
  return d;
}
process.on('exit', () => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* egal */ } } });

/** Dienst mit Attrappen: notify/broadcast landen in Listen; fetch ohne Netz (wirft) */
function service(extra = {}) {
  const dir = extra.dir || tempDir();
  const notes = []; const events = [];
  const svc = new MailService({
    dir, secrets: makeSecrets(null, dir), offline: () => false, notify: (m) => notes.push(m), broadcast: (m) => events.push(m),
    lang: () => 'de', fetch: async () => { throw new Error('no network in tests'); }, notifyDelay: 50, prefetchDelay: 30, guess: false, ...extra,
  });
  return { svc, dir, notes, events };
}

async function until(fn, { timeout = 5000, every = 20 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, every));
  }
}

module.exports = { tempDir, service, until };
