'use strict';
/*
 * Benachrichtigungen bündeln: neue Mails sammeln sich 20 Sekunden, dann kommt EINE Meldung („3 neue Mails – Anna:
 * Betreff …“). In der Ruhezeit (z. B. 22–7 Uhr) und für stummgeschaltete Konten/Regeln kommt nichts – die Zähler in
 * Hostwerk zählen trotzdem.
 */
const inQuiet = (quiet, d) => {
  if (!quiet || !quiet.on) return false;
  const m = (s) => { const [h, mi] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (mi || 0); };
  const from = m(quiet.from); const to = m(quiet.to); const now = d.getHours() * 60 + d.getMinutes();
  return from <= to ? now >= from && now < to : now >= from || now < to;
};

class Notifier {
  /** deps: { send({ title, text }), prefs(), t(text, vars), now, delay } */
  constructor(deps) { this.deps = deps; this.queue = []; this.timer = null; }
  push(items) {
    const p = this.deps.prefs();
    if (!p.notify) return;
    const now = new Date(this.deps.now ? this.deps.now() : Date.now());
    if (inQuiet(p.quiet, now)) return;
    this.queue.push(...items);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.deps.delay ?? 20000);
    if (this.timer.unref) this.timer.unref();
  }
  flush() {
    this.timer = null;
    const list = this.queue.splice(0);
    if (!list.length) return null;
    const t = this.deps.t;
    const who = (it) => (it.from ? it.from.name || it.from.address : '?');
    const title = list.length === 1 ? t('New mail from {name}', { name: who(list[0]) }) : t('{n} new mails', { n: list.length });
    const lines = list.slice(0, 4).map((it) => `${list.length === 1 ? '' : `${who(it)}: `}${it.subject || t('(no subject)')}`);
    if (list.length > 4) lines.push(t('… and {n} more', { n: list.length - 4 }));
    const msg = { title, text: lines.join('\n') };
    try { this.deps.send(msg); } catch { /* Benachrichtigung ist Zugabe */ }
    return msg;
  }
  stop() { clearTimeout(this.timer); this.timer = null; this.queue = []; }
}

module.exports = { Notifier, inQuiet };
