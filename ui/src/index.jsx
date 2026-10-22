import { useEffect, useState } from 'react';
import { Inbox, CircleAlert, Mail } from 'lucide-react';
import { get, on, useApi } from '@hostwerk/api';
import { TileEmpty } from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';
import { MailApp } from './App';
import { BASE, TAB_HASH, when, who, emit } from './lib';
import './style.css';

/*
 * E-Mail-Konten: Reiter „Postfächer“ im Bereich E-Mail (Steckplatz mail.tabs), Kachel für die Übersicht und die ganze
 * Seite unter #/ext/mail-accounts. Texte englisch, Deutsch aus locales/de.json.
 */

/** Kachel: Ungelesen je Konto und die neuesten ungelesenen Mails */
function MailTile() {
  const ov = useApi(BASE, [], { live: false });
  const [latest, setLatest] = useState(null);
  const load = () => get(`${BASE}/messages?account=all&unread=1&size=10`).then(setLatest).catch(() => setLatest({ items: [] }));
  useEffect(() => {
    load();
    let tm = null;
    const off = on('mail-accounts', (m) => { if (m.event === 'new' || m.event === 'unread' || m.event === 'changed') { clearTimeout(tm); tm = setTimeout(() => { ov.reload({ silent: true }); load(); }, 1500); } });
    return () => { off(); clearTimeout(tm); };
  }, []);
  const d = ov.data;
  if (ov.loading && !d) return <div className="card-body"><div className="skeleton ma-skel" /></div>;
  const accounts = (d && d.accounts) || [];
  if (!accounts.length) return <TileEmpty icon={Inbox} text={t('No e-mail account connected yet')} href={TAB_HASH} action={t('Connect')} />;
  const total = accounts.reduce((n, a) => n + (a.unread || 0), 0);
  const items = ((latest && latest.items) || []).slice(0, 3);
  return (
    <div className="card-body stack ma-tile">
      <a className="row-tight ma-tile-head" href={TAB_HASH}>
        <Mail size={16} aria-hidden="true" />
        <b className="grow">{total ? pl(total, '{n} unread mail', '{n} unread mails') : t('All read')}</b>
      </a>
      <div className="row-tight ma-tile-accs small">
        {accounts.map((a) => (
          <a key={a.id} className="badge" href={TAB_HASH} title={a.email} style={{ '--acc': a.color }}>
            <span className="ma-dot" aria-hidden="true" />{a.name}{a.unread ? ` · ${a.unread}` : ''}
            {(a.status === 'error' || a.status === 'offline') && <CircleAlert size={12} className="ma-bad" aria-label={t('No connection')} />}
          </a>
        ))}
      </div>
      {items.map((it) => (
        <a key={it.key} className="row-tight ma-tile-row" href={TAB_HASH} title={it.subject}>
          <span className="ellipsis grow small"><b>{who(it.from)}</b> · {it.subject || t('(no subject)')}</span>
          <span className="small muted">{when(it.date)}</span>
        </a>
      ))}
    </div>
  );
}

function MailPage() {
  return <div className="page full ma-page"><MailApp /></div>;
}
function MailTab() { return <MailApp embedded />; }

export default {
  pages: { main: MailPage },
  slots: {
    // Reiter im Bereich E-Mail (Hostwerk 3.0+, SDK 3.2: ohne eigenen Seitenleisten-Eintrag) – vor Mail-Fänger-Erweiterungen
    'mail.tabs': [{ id: 'inbox', title: 'Mailboxes', icon: Inbox, Component: MailTab, order: 5 }],
    'dashboard.tiles': [{ id: 'mail', title: 'E-mail', icon: Mail, size: 'third', Component: MailTile }],
  },
  shortcuts: [
    { id: 'compose', title: 'Write an e-mail', keys: 'ctrl+alt+m', run: () => { location.hash = TAB_HASH.slice(1); setTimeout(() => emit('compose', {}), 400); } },
    { id: 'open', title: 'Open mailboxes', keys: 'ctrl+alt+i', run: () => { location.hash = TAB_HASH.slice(1); } },
  ],
};


