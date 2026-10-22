import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Inbox, PenSquare, Search, X, Star, Paperclip, MailOpen, Mail, Archive, Trash2, FolderInput, RefreshCw, Settings2, Plus, ChevronRight, ChevronDown,
  CircleAlert, CloudOff, Loader2, Send, Ban, MoreHorizontal, FolderPlus, Pencil, FileDown, CheckSquare, Square, Users, AtSign,
} from 'lucide-react';
import { get, post, on, useApi } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, InfoTip, toast, confirmDialog, promptDialog, useFillHeight } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t, pl } from '@hostwerk/i18n';
import { BASE, qs, apiUrl, sortFolders, folderIcon, folderLabel, when, who, initials, hue, typing, listen, emit } from './lib';
import { Reader } from './Reader';
import { Compose } from './Compose';
import { AccountWizard, AccountSettings } from './Setup';
import { SettingsDialog } from './Settings';

const STATUS = { online: '', connecting: 'Connecting …', offline: 'Offline', error: 'No connection', off: 'Switched off' };
const PAGE = 50;

/** Seitenleiste: alle Posteingänge, Konten mit Ordnern, Postausgang, Einstellungen */
function Sidebar({ overview, view, setView, folders, loadFolders, onCompose, onAdd, onEdit, onSettings }) {
  const [open, setOpen] = useState(() => { try { return JSON.parse(localStorage.getItem('hw-mail-accounts-open') || '{}'); } catch { return {}; } });
  const toggle = (id) => { const n = { ...open, [id]: !(open[id] ?? true) }; setOpen(n); try { localStorage.setItem('hw-mail-accounts-open', JSON.stringify(n)); } catch { /* egal */ } };
  const accounts = overview.accounts || [];
  const total = accounts.reduce((n, a) => n + (a.unread || 0), 0);
  const isView = (acc, folder) => view.account === acc && view.folder === folder;
  const accMenu = (e, a) => contextMenu(e, [
    { label: t('Write from this account'), icon: PenSquare, onClick: () => onCompose({ account: a.id }) },
    { label: t('Reload folders'), icon: RefreshCw, onClick: () => loadFolders(a.id, true) },
    { label: t('New folder …'), icon: FolderPlus, onClick: async () => { const name = await promptDialog({ title: t('New folder'), label: t('Name') }); if (name) { try { await post(`${BASE}/folders`, { account: a.id, action: 'create', path: name }); loadFolders(a.id, true); } catch (er) { toast.error(er.message); } } } },
    { label: t('Connect again'), icon: RefreshCw, onClick: () => post(`${BASE}/accounts/${a.id}/reconnect`) },
    '-',
    { label: t('Account settings'), icon: Settings2, onClick: () => onEdit(a) },
  ]);
  const folderMenu = (e, a, f) => contextMenu(e, [
    { label: t('Mark all as read'), icon: MailOpen, onClick: () => emit('mark-all-read', { account: a.id, folder: f.path }) },
    { label: t('Export as .mbox'), icon: FileDown, onClick: () => { const l = document.createElement('a'); l.href = apiUrl('/export', { account: a.id, folder: f.path }); l.click(); } },
    !f.role && { label: t('Rename …'), icon: Pencil, onClick: async () => { const to = await promptDialog({ title: t('Rename folder'), label: t('Name'), value: f.path }); if (to && to !== f.path) { try { await post(`${BASE}/folders`, { account: a.id, action: 'rename', path: f.path, to }); loadFolders(a.id, true); } catch (er) { toast.error(er.message); } } } },
    !f.role && { label: t('Delete folder …'), icon: Trash2, danger: true, onClick: async () => { if (await confirmDialog({ title: t('Delete the folder “{name}” on the server?', { name: f.path }), text: t('The mails in it are deleted too.'), confirm: t('Delete'), danger: true })) { try { await post(`${BASE}/folders`, { account: a.id, action: 'delete', path: f.path }); loadFolders(a.id, true); } catch (er) { toast.error(er.message); } } } },
  ]);
  return (
    <nav className="ma-side" aria-label={t('Mailboxes')}>
      <Btn className="primary ma-compose-btn" icon={PenSquare} onClick={() => onCompose({})} disabled={!accounts.some((a) => a.smtp)} title="Write (C)">Write</Btn>
      <ul className="ma-folders">
        <li><button type="button" className={`ma-folder${isView('all', 'INBOX') ? ' on' : ''}`} aria-current={isView('all', 'INBOX') ? 'page' : undefined} onClick={() => setView({ account: 'all', folder: 'INBOX' })}>
          <Inbox size={15} aria-hidden="true" /><span className="grow ellipsis">{t('All inboxes')}</span>{total > 0 && <span className="ma-count">{total}</span>}
        </button></li>
      </ul>
      {accounts.map((a) => {
        const isOpen = open[a.id] ?? true;
        const list = sortFolders(folders[a.id] || []);
        const bad = a.status === 'error' || a.status === 'offline';
        return (
          <div key={a.id} className="ma-acc" style={{ '--acc': a.color }}>
            <div className="ma-acc-head" onContextMenu={(e) => accMenu(e, a)}>
              <button type="button" className="ma-acc-toggle" aria-expanded={isOpen} onClick={() => { toggle(a.id); if (!isOpen && !folders[a.id]) loadFolders(a.id); }}>
                {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                <span className="ma-dot" aria-hidden="true" />
                <span className="grow ellipsis" title={a.email}>{a.name}</span>
                {bad && <CircleAlert size={14} className="ma-bad" aria-label={t(STATUS[a.status])} />}
                {a.status === 'connecting' && <Loader2 size={13} className="spin muted" aria-label={t('Connecting …')} />}
                {a.unread > 0 && <span className="ma-count">{a.unread}</span>}
              </button>
              <button type="button" className="btn xs ghost icon ma-acc-more" title={t('More for {name}', { name: a.name })} aria-label={t('More for {name}', { name: a.name })} onClick={(e) => accMenu(e, a)}><MoreHorizontal size={14} /></button>
            </div>
            {bad && a.error && <button type="button" className="ma-acc-err small" onClick={() => onEdit(a)} title={a.error.detail || ''}>{t(a.error.text)}</button>}
            {isOpen && (
              <ul className="ma-folders">
                {(list.length ? list : [{ path: 'INBOX', name: 'INBOX', role: 'inbox' }]).map((f) => {
                  const I = folderIcon(f);
                  const depth = f.delimiter ? f.path.split(f.delimiter).length - 1 : 0;
                  return (
                    <li key={f.path}><button type="button" className={`ma-folder${isView(a.id, f.path) ? ' on' : ''}`} style={{ '--depth': Math.min(depth, 4) }} aria-current={isView(a.id, f.path) ? 'page' : undefined}
                      onClick={() => setView({ account: a.id, folder: f.path })} onContextMenu={(e) => folderMenu(e, a, f)}
                      onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-hw-mail')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } }}
                      onDragLeave={(e) => e.currentTarget.classList.remove('drop')}
                      onDrop={(e) => { e.currentTarget.classList.remove('drop'); const d = e.dataTransfer.getData('application/x-hw-mail'); if (d) emit('drop', { items: JSON.parse(d), account: a.id, folder: f.path }); }}>
                      <I size={15} aria-hidden="true" /><span className="grow ellipsis">{folderLabel(f)}</span>{f.unseen > 0 && f.role !== 'sent' && f.role !== 'trash' && f.role !== 'junk' && <span className="ma-count">{f.unseen}</span>}
                    </button></li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
      <div className="ma-side-foot">
        {(overview.outbox || []).length > 0 && <Btn className="xs ghost" icon={Send} onClick={() => onSettings('outbox')}>{t('Outbox')} ({overview.outbox.length})</Btn>}
        <Btn className="xs ghost" icon={Plus} onClick={onAdd}>Add account</Btn>
        <Btn className="xs ghost" icon={Settings2} onClick={() => onSettings('general')}>Settings</Btn>
      </div>
    </nav>
  );
}

/** Ein Eintrag der Liste (auch als Konversation mit Zähler) */
function Row({ it, count, selected, active, checked, onOpen, onCheck, onMenu, compact, accounts, unified, focusable }) {
  const acc = unified ? accounts.find((a) => a.id === it.account) : null;
  const drag = (e) => { e.dataTransfer.setData('application/x-hw-mail', JSON.stringify([{ account: it.account, folder: it.folder, uid: it.uid }])); e.dataTransfer.effectAllowed = 'move'; };
  const sent = it.folder && /sent|gesendet/i.test(it.folder);
  const person = sent ? (it.to && it.to[0]) : it.from;
  return (
    <div role="option" aria-selected={active} tabIndex={focusable ? 0 : -1} draggable onDragStart={drag} data-key={it.key}
      className={`ma-row${it.seen ? '' : ' unread'}${active ? ' active' : ''}${checked ? ' checked' : ''}${compact ? ' compact' : ''}`}
      onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? onCheck(e) : onOpen())} onContextMenu={onMenu} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <button type="button" className="ma-check" role="checkbox" aria-checked={checked} aria-label={t('Select')} tabIndex={-1} onClick={(e) => { e.stopPropagation(); onCheck(e); }}>
        {checked ? <CheckSquare size={15} /> : <span className="ma-avatar sm" style={{ '--h': hue(person && person.address) }} aria-hidden="true">{initials(person)}</span>}
      </button>
      <div className="ma-row-main">
        <div className="ma-row-top">
          {acc && <span className="ma-dot" style={{ '--acc': acc.color }} title={acc.email} aria-label={acc.email} />}
          <span className="ma-from ellipsis">{sent ? `${t('To')}: ${who(person)}` : who(person)}</span>
          {count > 1 && <span className="ma-thread-n" aria-label={pl(count, '{n} mail in this conversation', '{n} mails in this conversation')}>{count}</span>}
          <span className="grow" />
          {it.attachment && <Paperclip size={13} className="muted" aria-label={t('Has attachments')} />}
          {it.flagged && <Star size={13} className="ma-star" aria-label={t('Starred')} />}
          <time className="ma-when small" dateTime={it.date ? new Date(it.date).toISOString() : undefined}>{when(it.date)}</time>
        </div>
        <div className="ma-row-sub ellipsis"><span className="ma-subj">{it.subject || t('(no subject)')}</span>{!compact && it.snippet ? <span className="muted"> – {it.snippet}</span> : null}</div>
      </div>
    </div>
  );
}

export function MailApp({ embedded = false }) {
  const fill = useFillHeight({ min: 420 });
  const ov = useApi(BASE, [], { live: false });
  const overview = ov.data;
  const [folders, setFolders] = useState({});
  const [view, setView] = useState({ account: 'all', folder: 'INBOX' });
  const [filter, setFilter] = useState({ unread: false, flagged: false, attachments: false });
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [list, setList] = useState(null);
  const [listErr, setListErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState(1);
  const [active, setActive] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [expanded, setExpanded] = useState(new Set());
  const [compose, setCompose] = useState(null);
  const [wizard, setWizard] = useState(false);
  const [editAcc, setEditAcc] = useState(null);
  const [settings, setSettings] = useState(null);
  const [ai, setAi] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [narrow, setNarrow] = useState(false);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const seq = useRef(0);
  const setRoot = useCallback((el) => { rootRef.current = el; fill(el); }, [fill]);

  const reloadOverview = useCallback(() => ov.reload({ silent: true }), [ov.reload]);
  const loadFolders = useCallback(async (id, fresh = false) => {
    try { const l = await get(`${BASE}/folders?${qs({ account: id, fresh })}`); setFolders((f) => ({ ...f, [id]: l })); } catch { /* Konto offline – bleibt leer */ }
  }, []);
  const loadList = useCallback(async ({ keep = false } = {}) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await get(`${BASE}/messages?${qs({ account: view.account, folder: view.folder, page: 0, size: PAGE * pages, q, ...filter })}`);
      if (my !== seq.current) return;
      setList(r); setListErr(null);
      if (!keep) setChecked(new Set());
    } catch (e) { if (my === seq.current) setListErr(e); }
    if (my === seq.current) setLoading(false);
  }, [view.account, view.folder, q, filter, pages]);

  useEffect(() => { if (overview) for (const a of overview.accounts || []) if (!folders[a.id]) loadFolders(a.id); }, [overview && (overview.accounts || []).map((a) => a.id).join()]);
  useEffect(() => { setActive(null); setList(null); loadList(); }, [view.account, view.folder, q, filter]);
  const firstPages = useRef(true);
  useEffect(() => { if (firstPages.current) { firstPages.current = false; return; } loadList({ keep: true }); }, [pages]);
  useEffect(() => { get(`${BASE}/ai`).then(setAi).catch(() => setAi(null)); get(`${BASE}/templates`).then(setTemplates).catch(() => {}); }, [overview && overview.prefs && overview.prefs.aiConsent]);
  // Live: neue Mails, Zustände, Postausgang – gebündelt nachladen
  useEffect(() => {
    let tm = null;
    const kick = (full) => { clearTimeout(tm); tm = setTimeout(() => { reloadOverview(); if (full) loadList({ keep: true }); }, 400); };
    const off = on('mail-accounts', (m) => {
      if (m.event === 'new' || m.event === 'changed') { kick(true); if (m.account) loadFolders(m.account, true); }
      else if (m.event === 'accounts' || m.event === 'outbox' || m.event === 'state' || m.event === 'unread') kick(false);
    });
    return () => { off(); clearTimeout(tm); };
  }, [loadList, reloadOverview]);
  useEffect(() => listen('compose', (d) => setCompose(d || {})), []);
  useEffect(() => listen('templates', () => get(`${BASE}/templates`).then(setTemplates).catch(() => {})), []);
  useEffect(() => listen('drop', (d) => act('move', d.items.filter((x) => x.account === d.account), { folder: d.folder })), [list]);
  useEffect(() => listen('mark-all-read', async (d) => {
    try { const r = await get(`${BASE}/messages?${qs({ account: d.account, folder: d.folder, unread: true, size: 200 })}`); if (r.items.length) await post(`${BASE}/flags`, { items: r.items, add: ['\\Seen'] }); loadList({ keep: true }); loadFolders(d.account, true); } catch (e) { toast.error(e.message); }
  }), [loadList]);
  // Schmal (Handy, kleines Fenster): Liste ODER Lesen
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 860));
    ro.observe(el);
    return () => ro.disconnect();
  }, [overview]);
  useEffect(() => { const h = setTimeout(() => { if (qLive !== q) setQ(qLive.trim()); }, 450); return () => clearTimeout(h); }, [qLive]);

  // Liste mit Konversationen: pro Gruppe nur der neueste Eintrag (aufklappbar)
  const rows = useMemo(() => {
    if (!list) return [];
    const items = list.items || [];
    const groups = new Map();
    if (list.threads) for (const g of list.threads) for (const k of g.keys) groups.set(k, g);
    const out = []; const seen = new Set();
    for (const it of items) {
      const g = groups.get(it.key);
      if (!g) { out.push({ it, count: 1 }); continue; }
      if (seen.has(g.key)) continue;
      seen.add(g.key);
      const members = g.keys.map((k) => items.find((x) => x.key === k)).filter(Boolean).sort((a, b) => (b.date || 0) - (a.date || 0));
      const head = { ...members[0], seen: members.every((m) => m.seen), flagged: members.some((m) => m.flagged), attachment: members.some((m) => m.attachment) };
      out.push({ it: head, count: members.length, group: g.key, members });
      if (expanded.has(g.key)) for (const m of members.slice(1)) out.push({ it: m, count: 1, child: true });
    }
    return out;
  }, [list, expanded]);
  const flat = rows.map((r) => r.it);
  const activeItem = active ? flat.find((x) => x.key === active) || (list && (list.items || []).find((x) => x.key === active)) : null;
  const sel = () => (checked.size ? flat.filter((x) => checked.has(x.key)) : activeItem ? [activeItem] : []);
  const refOf = (x) => ({ account: x.account, folder: x.folder, uid: x.uid });

  /** Aktionen für eine oder mehrere Mails (optimistisch in der Liste, dann Server) */
  const act = async (kind, items, extra = {}) => {
    const refs = items.map(refOf);
    if (!refs.length) return;
    const keys = new Set(items.map((x) => (x.key ? x.key : `${x.account}|${x.folder}|${x.uid}`)));
    const removeFromList = () => { setList((l) => (l ? { ...l, items: l.items.filter((x) => !keys.has(x.key)), total: Math.max(0, l.total - keys.size) } : l)); if (active && keys.has(active)) { const idx = flat.findIndex((x) => x.key === active); const next = flat.slice(idx + 1).find((x) => !keys.has(x.key)) || flat.slice(0, idx).reverse().find((x) => !keys.has(x.key)); setActive(next && !narrow ? next.key : null); } setChecked(new Set()); };
    const patch = (fn) => setList((l) => (l ? { ...l, items: l.items.map((x) => (keys.has(x.key) ? fn(x) : x)) } : l));
    try {
      if (kind === 'reply' || kind === 'replyAll' || kind === 'forward') { setCompose(await get(`${BASE}/compose?${qs({ mode: kind, ...refs[0] })}`)); return; }
      if (kind === 'seen') { patch((x) => ({ ...x, seen: extra.on })); await post(`${BASE}/flags`, { items: refs, [extra.on ? 'add' : 'remove']: ['\\Seen'] }); }
      else if (kind === 'flag') { patch((x) => ({ ...x, flagged: extra.on })); await post(`${BASE}/flags`, { items: refs, [extra.on ? 'add' : 'remove']: ['\\Flagged'] }); }
      else if (kind === 'archive') { removeFromList(); await post(`${BASE}/move`, { items: refs, role: 'archive' }); toast(pl(refs.length, '{n} mail archived', '{n} mails archived')); }
      else if (kind === 'junk') { removeFromList(); await post(`${BASE}/move`, { items: refs, role: 'junk' }); toast(pl(refs.length, '{n} mail moved to spam', '{n} mails moved to spam')); }
      else if (kind === 'move') { removeFromList(); await post(`${BASE}/move`, { items: refs, folder: extra.folder }); toast(pl(refs.length, '{n} mail moved', '{n} mails moved')); }
      else if (kind === 'delete') {
        const folderRole = view.account !== 'all' && (folders[view.account] || []).find((f) => f.path === view.folder);
        const permanent = folderRole && (folderRole.role === 'trash' || folderRole.role === 'junk');
        if (permanent && !(await confirmDialog({ title: pl(refs.length, 'Delete {n} mail for good?', 'Delete {n} mails for good?'), text: t('They are in the trash already – this can’t be undone.'), confirm: t('Delete'), danger: true }))) return;
        removeFromList();
        try { await post(`${BASE}/delete`, { items: refs }); } catch (e) {
          if (e.code === 'NO_TRASH' && await confirmDialog({ title: t('This account has no trash folder'), text: t('Delete the mails for good?'), confirm: t('Delete'), danger: true })) await post(`${BASE}/delete`, { items: refs, permanent: true });
          else throw e;
        }
        if (!permanent) toast(pl(refs.length, '{n} mail moved to the trash', '{n} mails moved to the trash'));
      }
      reloadOverview();
      for (const a of new Set(refs.map((r) => r.account))) loadFolders(a, true);
    } catch (e) { toast.error(e.message); loadList({ keep: true }); }
  };

  // Tastatur: j/k, Enter, r/a/f, e, #/Entf, s, u, c, /, Esc, x
  useEffect(() => {
    const h = (e) => {
      if (!rootRef.current || !rootRef.current.isConnected || typing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
      if (document.querySelector('.modal-back, [role="dialog"][aria-modal="true"]')) return;
      const idx = flat.findIndex((x) => x.key === active);
      const go = (i) => { const it = flat[Math.max(0, Math.min(flat.length - 1, i))]; if (it) { setActive(it.key); const el = listRef.current && listRef.current.querySelector(`[data-key="${CSS.escape(it.key)}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); } };
      const k = e.key;
      if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); go(idx + 1); }
      else if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); go(idx < 0 ? 0 : idx - 1); }
      else if (k === '/') { e.preventDefault(); searchRef.current && searchRef.current.focus(); }
      else if (k === 'c' || k === 'n') { e.preventDefault(); setCompose({ account: view.account !== 'all' ? view.account : undefined }); }
      else if (k === 'Escape') { if (checked.size) setChecked(new Set()); else setActive(null); }
      else if (!sel().length) return;
      else if (k === 'r') { e.preventDefault(); act('reply', sel()); }
      else if (k === 'a') { e.preventDefault(); act('replyAll', sel()); }
      else if (k === 'f') { e.preventDefault(); act('forward', sel()); }
      else if (k === 'e') { e.preventDefault(); act('archive', sel()); }
      else if (k === '#' || k === 'Delete') { e.preventDefault(); act('delete', sel()); }
      else if (k === 's') { e.preventDefault(); act('flag', sel(), { on: !sel()[0].flagged }); }
      else if (k === 'u') { e.preventDefault(); act('seen', sel(), { on: !sel()[0].seen }); }
      else if (k === 'x' && activeItem) { e.preventDefault(); const n = new Set(checked); if (n.has(activeItem.key)) n.delete(activeItem.key); else n.add(activeItem.key); setChecked(n); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (ov.loading && !overview) return <div className="ma-app-loading"><Loading /></div>;
  if (ov.error && !overview) return <Empty icon={CloudOff} title="Couldn’t load your mailboxes" text={t(String(ov.error || ''))} action={<Btn onClick={reloadOverview}>Try again</Btn>} />;
  const accounts = (overview && overview.accounts) || [];
  const ovFull = { ...overview, templatesList: templates };
  const modals = (
    <>
      {compose && <Compose overview={ovFull} initial={compose} onClose={() => setCompose(null)} onSent={reloadOverview} />}
      {wizard && <AccountWizard overview={overview} prefill={wizard === true ? null : wizard} onClose={() => setWizard(false)} onDone={(a) => { setWizard(false); reloadOverview(); loadFolders(a.id); setView({ account: a.id, folder: 'INBOX' }); }} />}
      {editAcc && <AccountSettings account={editAcc} onClose={() => setEditAcc(null)} onChanged={() => { reloadOverview(); loadFolders(editAcc.id, true); }} />}
      {settings && <SettingsDialog overview={overview} start={settings} reload={() => { reloadOverview(); loadList({ keep: true }); }} onClose={() => setSettings(null)} />}
    </>
  );
  if (!accounts.length) {
    return (
      <div className={`ma-app ma-empty-app${embedded ? ' embedded' : ''}`} ref={setRoot}>
        <Empty icon={AtSign} title="Connect your e-mail accounts" text="Gmail, Outlook, web.de, GMX, T-Online, iCloud, Yahoo, Posteo, mailbox.org or your own domain – all inboxes together, right here in Hostwerk."
          action={<Btn className="primary" icon={Plus} onClick={() => setWizard(true)}>Connect an account</Btn>} />
        {modals}
      </div>
    );
  }
  const cur = view.account === 'all' ? null : accounts.find((a) => a.id === view.account);
  const curFolder = cur ? (folders[cur.id] || []).find((f) => f.path === view.folder) : null;
  const title = view.account === 'all' ? t('All inboxes') : `${folderLabel(curFolder || { name: view.folder })} · ${cur ? cur.name : ''}`;
  const compact = overview.prefs && overview.prefs.density === 'compact';
  const showList = !narrow || !activeItem;
  const showReader = !narrow || !!activeItem;
  const allChecked = flat.length > 0 && flat.every((x) => checked.has(x.key));
  const bulk = checked.size > 0;
  const rowMenu = (e, it) => {
    const items = checked.has(it.key) ? sel() : [it];
    contextMenu(e, [
      { label: t('Reply'), onClick: () => act('reply', [it]) }, { label: t('Reply all'), onClick: () => act('replyAll', [it]) }, { label: t('Forward'), onClick: () => act('forward', [it]) },
      '-',
      { label: it.seen ? t('Mark as unread') : t('Mark as read'), icon: it.seen ? Mail : MailOpen, onClick: () => act('seen', items, { on: !it.seen }) },
      { label: it.flagged ? t('Remove star') : t('Star'), icon: Star, onClick: () => act('flag', items, { on: !it.flagged }) },
      { label: t('Archive'), icon: Archive, onClick: () => act('archive', items) },
      { label: t('Spam'), icon: Ban, onClick: () => act('junk', items) },
      { label: t('Move to …'), icon: FolderInput, onClick: () => contextMenu(e, sortFolders(folders[it.account] || []).filter((f) => f.path !== it.folder).map((f) => ({ label: f.path, icon: folderIcon(f), onClick: () => act('move', items, { folder: f.path }) }))) },
      { label: t('Delete'), icon: Trash2, danger: true, onClick: () => act('delete', items) },
      '-',
      it.from && { label: t('Find mails from {name}', { name: who(it.from) }), icon: Search, onClick: () => { setQLive(it.from.address); setQ(it.from.address); } },
      it.draft && { label: t('Edit draft'), icon: Pencil, onClick: async () => { try { setCompose(await get(`${BASE}/draft?${qs(refOf(it))}`)); } catch (er) { toast.error(er.message); } } },
    ]);
  };
  const errors = (list && list.errors) || [];
  return (
    <div className={`ma-app${embedded ? ' embedded' : ''}${narrow ? ' narrow' : ''}`} ref={setRoot}>
      {(!narrow || (!activeItem && showList)) && <Sidebar overview={overview} view={view} setView={(v) => { setView(v); setPages(1); }} folders={folders} loadFolders={loadFolders}
        onCompose={(d) => setCompose(d)} onAdd={() => setWizard(true)} onEdit={setEditAcc} onSettings={setSettings} />}
      {showList && (
        <section className="ma-list" aria-label={title}>
          <div className="ma-list-head">
            <div className="row-tight">
              <h2 className="ma-list-title grow ellipsis">{title}</h2>
              {list && <span className="small muted">{list.offline ? <><CloudOff size={12} aria-hidden="true" /> {t('offline')}</> : pl(list.total || 0, '{n} mail', '{n} mails')}</span>}
              <Btn className="xs ghost icon" icon={RefreshCw} busy={loading} title="Reload" aria-label="Reload" onClick={() => loadList({ keep: true })} />
              <InfoTip>{t('Keys: J/K next/previous · Enter open · R reply · A reply all · F forward · E archive · # delete · S star · U read/unread · X select · C write · / search · Esc close')}</InfoTip>
            </div>
            <div className="ma-search">
              <Search size={14} aria-hidden="true" />
              <input ref={searchRef} className="input" type="search" placeholder={t('Search')} aria-label={t('Search mails')} value={qLive} onChange={(e) => setQLive(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setQ(qLive.trim()); if (e.key === 'Escape') { setQLive(''); setQ(''); e.currentTarget.blur(); } }} />
              {qLive && <button type="button" className="btn xs ghost icon" title={t('Clear search')} aria-label={t('Clear search')} onClick={() => { setQLive(''); setQ(''); }}><X size={13} /></button>}
            </div>
            <div className="row-tight ma-chips" role="group" aria-label={t('Filter')}>
              {[['unread', 'Unread', Mail], ['flagged', 'Starred', Star], ['attachments', 'Attachments', Paperclip]].map(([k, label, I]) => (
                <button key={k} type="button" className={`chip-toggle${filter[k] ? ' on' : ''}`} aria-pressed={filter[k]} onClick={() => setFilter({ ...filter, [k]: !filter[k] })}><I size={12} aria-hidden="true" /> {t(label)}</button>
              ))}
            </div>
            {bulk && (
              <div className="row-tight ma-bulk" role="toolbar" aria-label={t('Selected mails')}>
                <button type="button" className="btn xs ghost icon" aria-label={allChecked ? t('Select none') : t('Select all')} title={allChecked ? t('Select none') : t('Select all')} onClick={() => setChecked(allChecked ? new Set() : new Set(flat.map((x) => x.key)))}>{allChecked ? <CheckSquare size={14} /> : <Square size={14} />}</button>
                <span className="small grow">{pl(checked.size, '{n} selected', '{n} selected')}</span>
                <Btn className="xs ghost icon" icon={MailOpen} title="Mark as read" aria-label="Mark as read" onClick={() => act('seen', sel(), { on: true })} />
                <Btn className="xs ghost icon" icon={Star} title="Star" aria-label="Star" onClick={() => act('flag', sel(), { on: true })} />
                <Btn className="xs ghost icon" icon={Archive} title="Archive" aria-label="Archive" onClick={() => act('archive', sel())} />
                <Btn className="xs ghost icon" icon={Trash2} title="Delete" aria-label="Delete" onClick={() => act('delete', sel())} />
                <Btn className="xs ghost icon" icon={X} title="Cancel selection" aria-label="Cancel selection" onClick={() => setChecked(new Set())} />
              </div>
            )}
          </div>
          {errors.filter((x) => !x.offline).map((x) => { const a = accounts.find((y) => y.id === x.account); return <Callout key={x.account} kind="warn" dismissible={false}>{a ? `${a.name}: ` : ''}{t(x.text || '')}</Callout>; })}
          {list && list.offline && <Callout kind="info" icon={CloudOff} dismissible={false}>{t('No connection – you see the last known state.')}</Callout>}
          <div className="ma-rows" role="listbox" aria-label={title} aria-multiselectable="true" ref={listRef}>
            {!list && !listErr && <Loading />}
            {listErr && <Empty icon={CircleAlert} title="Couldn’t load the mails" text={t(listErr.message)} action={<Btn onClick={() => loadList()}>Try again</Btn>} />}
            {list && !rows.length && <Empty icon={Inbox} title={q || Object.values(filter).some(Boolean) ? 'Nothing found' : 'No mails here'} text={q ? t('The server found nothing for “{q}”.', { q }) : ''} />}
            {rows.map((r, i) => (
              <div key={r.it.key} className={r.child ? 'ma-child' : ''}>
                <Row it={r.it} count={r.count} active={r.it.key === active} checked={checked.has(r.it.key)} compact={compact} accounts={accounts} unified={view.account === 'all'} focusable={r.it.key === active || (!active && i === 0)}
                  onOpen={() => { setActive(r.it.key); if (r.group && r.count > 1) setExpanded((s) => new Set(s).add(r.group)); }}
                  onCheck={() => { const n = new Set(checked); if (n.has(r.it.key)) n.delete(r.it.key); else n.add(r.it.key); setChecked(n); }}
                  onMenu={(e) => rowMenu(e, r.it)} />
              </div>
            ))}
            {list && (list.local || []).length > 0 && q && (
              <div className="ma-local-hits">
                <div className="small muted"><Users size={12} aria-hidden="true" /> {t('Also found in mails stored on this PC')}</div>
                {list.local.slice(0, 10).map((x) => <button key={x.key} type="button" className="ma-local-hit ellipsis" onClick={() => { setView({ account: x.account, folder: x.folder }); setTimeout(() => setActive(x.key), 600); }}>{x.subject} <span className="muted small">· {x.folder}</span></button>)}
              </div>
            )}
            {list && list.total > (list.items || []).length && !list.offline && <div className="ma-more"><Btn className="sm" busy={loading} onClick={() => setPages((p) => p + 1)}>Load more</Btn></div>}
          </div>
        </section>
      )}
      {showReader && (
        <section className="ma-read" aria-label={t('Reading pane')}>
          {activeItem
            ? <Reader key={activeItem.key} item={activeItem} overview={overview} ai={ai} folders={sortFolders(folders[activeItem.account] || [])} narrow={narrow} onBack={() => setActive(null)}
              onAction={(kind, refs, extra) => act(kind, refs.map((r) => ({ ...r, key: `${r.account}|${r.folder}|${r.uid}`, flagged: activeItem.flagged, seen: activeItem.seen })), extra)} />
            : <div className="ma-reader-empty"><Empty icon={MailOpen} title={bulk ? pl(checked.size, '{n} mail selected', '{n} mails selected') : 'Choose a mail'} text={bulk ? '' : t('Or press C to write one.')} /></div>}
        </section>
      )}
      {modals}
    </div>
  );
}

