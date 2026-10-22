/*
 * Gemeinsames für die Oberfläche: Adressen der API, Ordner-Rollen mit Symbolen, Datumsanzeige, kleine Helfer.
 */
import { Inbox, Send, FileText, Trash2, ShieldAlert, Archive, Star, Folder } from 'lucide-react';
import { t } from '@hostwerk/i18n';

export const BASE = '/mail-accounts';
export const TAB_HASH = '#/mail/x-mail-accounts-inbox';

/** Abfrage-Teil einer Adresse: leere Werte fallen weg, true → 1 */
export const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
  .map(([k, v]) => `${k}=${encodeURIComponent(v === true ? '1' : v)}`).join('&');
export const apiUrl = (p, o) => `/api${BASE}${p}${o ? `?${qs(o)}` : ''}`;

export const ROLE_ICON = { inbox: Inbox, sent: Send, drafts: FileText, trash: Trash2, junk: ShieldAlert, archive: Archive, all: Archive, flagged: Star };
export const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'all', 'flagged', 'junk', 'trash'];
export const ROLE_LABEL = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', trash: 'Trash', junk: 'Spam', archive: 'Archive', all: 'All mail', flagged: 'Starred' };
export const folderIcon = (f) => (f && f.role && ROLE_ICON[f.role]) || Folder;
export const folderLabel = (f) => (f && f.role && ROLE_LABEL[f.role] ? t(ROLE_LABEL[f.role]) : f ? f.name : '');
export const sortFolders = (list) => [...(list || [])].sort((a, b) => {
  const ra = ROLE_ORDER.indexOf(a.role); const rb = ROLE_ORDER.indexOf(b.role);
  if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  return a.path.localeCompare(b.path);
});

export const lang = () => (String(document.documentElement.lang || 'de').toLowerCase().startsWith('en') ? 'en' : 'de');
const loc = () => (lang() === 'en' ? 'en-GB' : 'de-DE');

/** Kurze Zeit für die Liste: heute Uhrzeit, dieses Jahr Tag + Monat, sonst Datum */
export function when(ts) {
  if (!ts) return '';
  const d = new Date(ts); const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('Yesterday');
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(loc(), { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(loc(), { day: '2-digit', month: '2-digit', year: '2-digit' });
}
export const fullDate = (ts) => (ts ? new Date(ts).toLocaleString(loc(), { dateStyle: 'full', timeStyle: 'short' }) : '');

export const addrText = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');
export const who = (a) => (a ? a.name || a.address : '');
export const initials = (a) => {
  const s = (a && (a.name || a.address)) || '?';
  const p = s.replace(/[<>"@].*$/, '').split(/[\s._-]+/).filter(Boolean);
  return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
};
/** Farbe je Absender (für das Kürzel): fester Farbton aus der Adresse, Helligkeit über Tokens */
export const hue = (s) => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

export const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Domain aus einem Link-Text (wie der Server) – für die Rückfrage beim Klick */
export function textDomain(text) {
  const m = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/.exec(String(text || '').trim().toLowerCase());
  return m ? m[1] : '';
}
export const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
export const baseDomain = (h) => { const p = String(h || '').split('.').filter(Boolean); if (p.length <= 2) return p.join('.'); const two = p[p.length - 1].length === 2 && /^(co|com|org|net|gov|ac|edu|or|ne|go|gv|ltd|plc)$/.test(p[p.length - 2]); return p.slice(two ? -3 : -2).join('.'); };

/** Datei → { filename, contentType, size, data (base64) } */
export const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', size: file.size, data: String(r.result).replace(/^data:[^,]*,/, '') });
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

/** Ist der Fokus gerade in einem Eingabefeld? (dann keine Einzeltasten-Kürzel) */
export const typing = (e) => { const el = e.target; return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))); };

/** Kleiner Ereignis-Kanal zwischen Kachel, Kürzeln und der Seite */
export const emit = (name, detail) => window.dispatchEvent(new CustomEvent(`hw-mail-accounts:${name}`, { detail }));
export const listen = (name, fn) => { const h = (e) => fn(e.detail); window.addEventListener(`hw-mail-accounts:${name}`, h); return () => window.removeEventListener(`hw-mail-accounts:${name}`, h); };
