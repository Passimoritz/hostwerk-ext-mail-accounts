'use strict';
/*
 * Einfache Regeln für neue Mails im Posteingang – laufen in Hostwerk, solange es läuft (nicht auf dem Mail-Server).
 *   rule = { id, name, on, account: '*'|id, match: 'all'|'any', conditions: [{ field, op, value }], actions: [{ type, folder }], stop }
 *   field: from · to · subject · list (Newsletter: List-Id/List-Unsubscribe vorhanden) · attachment
 *   op:    contains · not-contains · is · ends-with
 *   type:  move · read · flag · mute (keine Benachrichtigung) · archive · trash
 * Keine Weiterleitung nach außen per Regel – das bliebe unbemerkt und wäre ein beliebtes Ziel von Angreifern.
 */
const FIELDS = ['from', 'to', 'subject', 'list', 'attachment'];
const OPS = ['contains', 'not-contains', 'is', 'ends-with'];
const ACTIONS = ['move', 'read', 'flag', 'mute', 'archive', 'trash'];

function valueOf(item, field) {
  const addr = (a) => (a ? `${a.name || ''} <${a.address || ''}>`.toLowerCase() : '');
  if (field === 'from') return addr(item.from);
  if (field === 'to') return [...(item.to || []), ...(item.cc || [])].map(addr).join(', ');
  if (field === 'subject') return String(item.subject || '').toLowerCase();
  if (field === 'list') return item.list ? 'yes' : 'no';
  if (field === 'attachment') return item.attachment ? 'yes' : 'no';
  return '';
}
function test(item, c) {
  if (c.field === 'list' || c.field === 'attachment') return (valueOf(item, c.field) === 'yes') === (c.op !== 'not-contains');
  const v = valueOf(item, c.field);
  const w = String(c.value || '').toLowerCase().trim();
  if (!w) return false;
  if (c.op === 'contains') return v.includes(w);
  if (c.op === 'not-contains') return !v.includes(w);
  if (c.op === 'is') return c.field === 'from' || c.field === 'to' ? v.split(', ').some((x) => x.includes(`<${w}>`)) : v === w;
  if (c.op === 'ends-with') return c.field === 'from' || c.field === 'to' ? v.split(', ').some((x) => x.replace(/>$/, '').endsWith(w)) : v.endsWith(w);
  return false;
}

/** Bereinigt eine Regel aus der Oberfläche (oder wirft mit verständlichem Grund) */
function clean(r) {
  const conditions = (r.conditions || []).filter((c) => FIELDS.includes(c.field) && OPS.includes(c.op)).map((c) => ({ field: c.field, op: c.op, value: String(c.value || '').slice(0, 200) })).slice(0, 10);
  const actions = (r.actions || []).filter((a) => ACTIONS.includes(a.type)).map((a) => ({ type: a.type, ...(a.type === 'move' ? { folder: String(a.folder || '') } : {}) })).slice(0, 5);
  if (!conditions.length) throw Object.assign(new Error('A rule needs at least one condition.'), { status: 400 });
  if (!actions.length) throw Object.assign(new Error('A rule needs at least one action.'), { status: 400 });
  if (actions.some((a) => a.type === 'move' && !a.folder)) throw Object.assign(new Error('Choose the folder for “Move”.'), { status: 400 });
  return { id: String(r.id || ''), name: String(r.name || '').slice(0, 80), on: r.on !== false, account: String(r.account || '*'), match: r.match === 'any' ? 'any' : 'all', conditions, actions, stop: !!r.stop };
}

/** Welche Aktionen gelten für diese Mail? → [{ rule, actions }] (Reihenfolge der Regeln, „stop“ beendet) */
function evaluate(rules, item) {
  const out = [];
  for (const r of rules || []) {
    if (!r.on || (r.account !== '*' && r.account !== item.account)) continue;
    const hits = r.conditions.map((c) => test(item, c));
    if (r.match === 'any' ? hits.some(Boolean) : hits.every(Boolean)) { out.push({ rule: r, actions: r.actions }); if (r.stop) break; }
  }
  return out;
}

module.exports = { evaluate, clean, test, FIELDS, OPS, ACTIONS };
