import { useEffect, useState } from 'react';
import { Settings2, Bell, Filter, FileText, HardDrive, Sparkles, Send, Plus, Trash2, X, RotateCw, Pencil, Play, ArrowUp, ArrowDown } from 'lucide-react';
import { get, put, post, del } from '@hostwerk/api';
import { Btn, Modal, Tabs, Field, Switch, SettingRow, Callout, InfoTip, Empty, toast, confirmDialog } from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';
import { BASE, fmtSize, when, emit } from './lib';

const FIELDS = [{ id: 'from', label: 'Sender' }, { id: 'to', label: 'Recipient' }, { id: 'subject', label: 'Subject' }, { id: 'list', label: 'Is a newsletter' }, { id: 'attachment', label: 'Has attachments' }];
const OPS = [{ id: 'contains', label: 'contains' }, { id: 'not-contains', label: 'doesn’t contain' }, { id: 'is', label: 'is exactly' }, { id: 'ends-with', label: 'ends with' }];
const ACTIONS = [{ id: 'move', label: 'Move to folder' }, { id: 'read', label: 'Mark as read' }, { id: 'flag', label: 'Star' }, { id: 'archive', label: 'Archive' }, { id: 'trash', label: 'Move to trash' }, { id: 'mute', label: 'No notification' }];
const flagLike = (f) => f === 'list' || f === 'attachment';

function General({ prefs, save }) {
  const p = prefs;
  const [senders, setSenders] = useState((p.trustedSenders || []).join('\n'));
  return (
    <div className="stack">
      <SettingRow title="Mark as read when opened" text=""><Switch checked={p.markReadOnOpen} onChange={(v) => save({ markReadOnOpen: v })} label={t('Mark as read when opened')} /></SettingRow>
      <SettingRow title="Group conversations" text=""><Switch checked={p.threads} onChange={(v) => save({ threads: v })} label={t('Group conversations')} /></SettingRow>
      <SettingRow title="Compact list" text=""><Switch checked={p.density === 'compact'} onChange={(v) => save({ density: v ? 'compact' : 'normal' })} label={t('Compact list')} /></SettingRow>
      <Field label="Write new mails as">
        <select className="select" value={p.composeFormat} onChange={(e) => save({ composeFormat: e.target.value })}><option value="html">{t('Formatted text')}</option><option value="text">{t('Plain text')}</option></select>
      </Field>
      <Field label="Time to undo sending" hint={t('The mail waits this long before it goes out.')}>
        <select className="select" value={String(p.undoSeconds)} onChange={(e) => save({ undoSeconds: Number(e.target.value) })}>{[0, 5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n ? t('{n} seconds', { n }) : t('Send right away')}</option>)}</select>
      </Field>
      <Field label="Always load images from" hint={t('One address or @domain per line. For everyone else, Hostwerk asks first.')}>
        <textarea className="input mono" rows={4} value={senders} onChange={(e) => setSenders(e.target.value)} onBlur={() => save({ trustedSenders: senders.split(/[\s,;]+/).filter(Boolean) })} />
      </Field>
    </div>
  );
}

function Notifications({ prefs, save }) {
  const q = prefs.quiet || {};
  return (
    <div className="stack">
      <SettingRow title="Notify me about new mails" text=""><Switch checked={prefs.notify} onChange={(v) => save({ notify: v })} label={t('Notify me about new mails')} /></SettingRow>
      <InfoTip>{t('New mails arrive by push (IMAP IDLE) – Hostwerk doesn’t ask the server again and again. Several mails within 20 seconds come as one notification, on the desktop and – if switched on – on your phone (Settings → Notifications). Per account you can switch them off in its settings.')}</InfoTip>
      <SettingRow title="Quiet hours" text=""><Switch checked={!!q.on} onChange={(v) => save({ quiet: { ...q, on: v } })} label={t('Quiet hours')} /></SettingRow>
      {q.on && (
        <div className="row-tight">
          <Field label="From"><input className="input" type="time" value={q.from} onChange={(e) => save({ quiet: { ...q, from: e.target.value } })} /></Field>
          <Field label="Until"><input className="input" type="time" value={q.to} onChange={(e) => save({ quiet: { ...q, to: e.target.value } })} /></Field>
        </div>
      )}
    </div>
  );
}

function Rules({ accounts }) {
  const [rules, setRules] = useState(null);
  const [edit, setEdit] = useState(null);
  const [folders, setFolders] = useState([]);
  useEffect(() => { get(`${BASE}/rules`).then(setRules).catch(() => setRules([])); }, []);
  useEffect(() => {
    if (!edit) return;
    const acc = edit.account !== '*' ? edit.account : accounts[0] && accounts[0].id;
    if (acc) get(`${BASE}/folders?account=${encodeURIComponent(acc)}`).then(setFolders).catch(() => setFolders([]));
  }, [edit && edit.account]);
  const store = async (list) => { try { setRules(await put(`${BASE}/rules`, { rules: list })); return true; } catch (e) { toast.error(e.message); return false; } };
  if (!rules) return null;
  if (edit) {
    const r = edit;
    const set = (patch) => setEdit({ ...r, ...patch });
    return (
      <div className="stack">
        <Field label="Name"><input className="input" value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('e.g. Newsletters into “Reading”')} /></Field>
        <Field label="Account"><select className="select" value={r.account} onChange={(e) => set({ account: e.target.value })}><option value="*">{t('All accounts')}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <div className="row-tight"><span>{t('When')}</span><select className="select ma-narrow" value={r.match} onChange={(e) => set({ match: e.target.value })}><option value="all">{t('all conditions apply')}</option><option value="any">{t('one condition applies')}</option></select></div>
        {r.conditions.map((c, i) => (
          <div key={i} className="row-tight ma-rule-row">
            <select className="select" aria-label={t('Field')} value={c.field} onChange={(e) => set({ conditions: r.conditions.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}>{FIELDS.map((f) => <option key={f.id} value={f.id}>{t(f.label)}</option>)}</select>
            {flagLike(c.field)
              ? <select className="select" aria-label={t('Condition')} value={c.op === 'not-contains' ? 'not-contains' : 'contains'} onChange={(e) => set({ conditions: r.conditions.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })}><option value="contains">{t('yes')}</option><option value="not-contains">{t('no')}</option></select>
              : <>
                <select className="select" aria-label={t('Condition')} value={c.op} onChange={(e) => set({ conditions: r.conditions.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })}>{OPS.map((o) => <option key={o.id} value={o.id}>{t(o.label)}</option>)}</select>
                <input className="input" aria-label={t('Value')} value={c.value} onChange={(e) => set({ conditions: r.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
              </>}
            <Btn className="xs ghost icon" icon={X} title="Remove condition" aria-label="Remove condition" disabled={r.conditions.length < 2} onClick={() => set({ conditions: r.conditions.filter((x, j) => j !== i) })} />
          </div>
        ))}
        <div><Btn className="xs" icon={Plus} onClick={() => set({ conditions: [...r.conditions, { field: 'subject', op: 'contains', value: '' }] })}>Add condition</Btn></div>
        <b>{t('Then')}</b>
        {r.actions.map((a, i) => (
          <div key={i} className="row-tight ma-rule-row">
            <select className="select" aria-label={t('Action')} value={a.type} onChange={(e) => set({ actions: r.actions.map((x, j) => (j === i ? { type: e.target.value } : x)) })}>{ACTIONS.map((o) => <option key={o.id} value={o.id}>{t(o.label)}</option>)}</select>
            {a.type === 'move' && <select className="select" aria-label={t('Folder')} value={a.folder || ''} onChange={(e) => set({ actions: r.actions.map((x, j) => (j === i ? { ...x, folder: e.target.value } : x)) })}><option value="">{t('Choose a folder …')}</option>{folders.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}</select>}
            <Btn className="xs ghost icon" icon={X} title="Remove action" aria-label="Remove action" disabled={r.actions.length < 2} onClick={() => set({ actions: r.actions.filter((x, j) => j !== i) })} />
          </div>
        ))}
        <div><Btn className="xs" icon={Plus} onClick={() => set({ actions: [...r.actions, { type: 'read' }] })}>Add action</Btn></div>
        <SettingRow title="Stop after this rule" text=""><Switch checked={!!r.stop} onChange={(v) => set({ stop: v })} label={t('Stop after this rule')} /></SettingRow>
        <div className="row-tight"><span className="grow" /><Btn onClick={() => setEdit(null)}>Cancel</Btn><Btn className="primary" onClick={async () => { const list = r.id ? rules.map((x) => (x.id === r.id ? r : x)) : [...rules, r]; if (await store(list)) setEdit(null); }}>Save rule</Btn></div>
      </div>
    );
  }
  return (
    <div className="stack">
      <InfoTip>{t('Rules sort new mails in the inbox while Hostwerk is running – e.g. newsletters into a folder or mark invoices with a star. Forwarding to others is deliberately not possible.')}</InfoTip>
      {!rules.length && <Empty icon={Filter} title="No rules yet" text="Sort mails automatically by sender or subject." />}
      {rules.map((r, i) => (
        <div key={r.id} className="row-tight ma-rule card">
          <div className="card-body row-tight grow">
            <Switch checked={r.on} onChange={(v) => store(rules.map((x) => (x.id === r.id ? { ...x, on: v } : x)))} label={r.name || t('Rule')} />
            <span className="grow"><b>{r.name || t('Rule {n}', { n: i + 1 })}</b> <span className="small muted">{pl(r.conditions.length, '{n} condition', '{n} conditions')} → {r.actions.map((a) => t((ACTIONS.find((x) => x.id === a.type) || {}).label || a.type)).join(', ')}</span></span>
            <Btn className="xs ghost icon" icon={ArrowUp} title="Move up" aria-label="Move up" disabled={!i} onClick={() => { const l = [...rules]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; store(l); }} />
            <Btn className="xs ghost icon" icon={ArrowDown} title="Move down" aria-label="Move down" disabled={i === rules.length - 1} onClick={() => { const l = [...rules]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; store(l); }} />
            <Btn className="xs ghost icon" icon={Pencil} title="Edit" aria-label="Edit" onClick={() => setEdit(r)} />
            <Btn className="xs ghost icon" icon={Trash2} title="Delete rule" aria-label="Delete rule" onClick={() => store(rules.filter((x) => x.id !== r.id))} />
          </div>
        </div>
      ))}
      <div className="row-tight">
        <Btn icon={Plus} onClick={() => setEdit({ name: '', on: true, account: '*', match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'move', folder: '' }], stop: false })}>New rule</Btn>
        {rules.length > 0 && <Btn className="ghost" icon={Play} onClick={async () => { try { const r = await post(`${BASE}/rules/run`, {}); toast.success(pl(r.hits, 'Rules applied to {n} mail', 'Rules applied to {n} mails')); } catch (e) { toast.error(e.message); } }}>Apply to the inbox now</Btn>}
      </div>
    </div>
  );
}

function Templates() {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);
  useEffect(() => { get(`${BASE}/templates`).then(setList).catch(() => setList([])); }, []);
  const store = async (l) => { try { setList(await put(`${BASE}/templates`, { templates: l })); emit('templates'); return true; } catch (e) { toast.error(e.message); return false; } };
  if (!list) return null;
  if (edit) return (
    <div className="stack">
      <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
      <Field label="Subject (optional)"><input className="input" value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></Field>
      <Field label="Text" hint={t('Plain text or simple HTML.')}><textarea className="input" rows={8} value={edit.html} onChange={(e) => setEdit({ ...edit, html: e.target.value })} /></Field>
      <div className="row-tight"><span className="grow" /><Btn onClick={() => setEdit(null)}>Cancel</Btn><Btn className="primary" onClick={async () => { const h = /<[a-z][\s\S]*>/i.test(edit.html) ? edit.html : edit.html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'); const x = { ...edit, html: h }; if (await store(x.id ? list.map((y) => (y.id === x.id ? x : y)) : [...list, x])) setEdit(null); }}>Save template</Btn></div>
    </div>
  );
  return (
    <div className="stack">
      {!list.length && <Empty icon={FileText} title="No templates yet" text="Texts you write often – insert them with one click when writing." />}
      {list.map((x) => (
        <div key={x.id} className="row-tight card"><div className="card-body row-tight grow">
          <FileText size={15} aria-hidden="true" /><b className="grow">{x.name}</b>
          <Btn className="xs ghost icon" icon={Pencil} title="Edit" aria-label="Edit" onClick={() => setEdit(x)} />
          <Btn className="xs ghost icon" icon={Trash2} title="Delete template" aria-label="Delete template" onClick={() => store(list.filter((y) => y.id !== x.id))} />
        </div></div>
      ))}
      <div><Btn icon={Plus} onClick={() => setEdit({ name: '', subject: '', html: '' })}>New template</Btn></div>
    </div>
  );
}

function Storage({ prefs, save, overview, reload }) {
  const c = overview.cache || {};
  return (
    <div className="stack">
      <InfoTip>{t('Hostwerk keeps recently opened and the newest mails on this PC, so you can read them offline. When the space is full, the mails you haven’t opened for the longest time go first. Your mails always stay on the mail server.')}</InfoTip>
      <div className="row-tight ma-cache"><HardDrive size={16} aria-hidden="true" /><span className="grow">{t('{size} of {limit} used · {n} mails', { size: fmtSize(c.bytes || 0), limit: fmtSize(c.limit || 0), n: c.count || 0 })}</span>
        <Btn className="xs" onClick={async () => { if (await confirmDialog({ title: t('Empty the cache?'), text: t('Mails load from the server again when you open them.'), confirm: t('Empty') })) { await post(`${BASE}/cache/clear`); reload(); } }}>Empty</Btn></div>
      <Field label="Space for offline reading">
        <select className="select" value={String(prefs.cacheMB)} onChange={(e) => save({ cacheMB: Number(e.target.value) })}>{[0, 50, 100, 300, 1000, 3000].map((n) => <option key={n} value={n}>{n ? (n >= 1000 ? `${n / 1000} GB` : `${n} MB`) : t('Don’t keep anything')}</option>)}</select>
      </Field>
      <SettingRow title="Fetch the newest mails in advance" text=""><Switch checked={prefs.prefetch} onChange={(v) => save({ prefetch: v })} label={t('Fetch the newest mails in advance')} /></SettingRow>
    </div>
  );
}

function Ai({ prefs, save }) {
  const [st, setSt] = useState(null);
  useEffect(() => { get(`${BASE}/ai`).then(setSt).catch(() => setSt({ ready: false })); }, [prefs.aiConsent]);
  return (
    <div className="stack">
      <Callout kind="info" dismissible={false} title={t('Your mails and AI')}>
        {t('With the AI help, Hostwerk sends the text of ONE mail – only when you click “Summarise”, “Translate” or “What do they want?” – to the AI you set up in Hostwerk. With a local model (Ollama) nothing leaves your PC; with an online provider the text goes there.')}
      </Callout>
      <SettingRow title="Allow the AI help for mails" text=""><Switch checked={!!prefs.aiConsent} onChange={(v) => save({ aiConsent: v })} label={t('Allow the AI help for mails')} /></SettingRow>
      {st && !st.ready && <p className="small muted">{t('The AI assistant isn’t ready – set it up under AI in Hostwerk.')}</p>}
    </div>
  );
}

function Outbox({ overview, reload }) {
  const list = overview.outbox || [];
  if (!list.length) return <Empty icon={Send} title="The outbox is empty" text="Mails waiting for the undo time or for a connection show up here." />;
  return (
    <div className="stack">
      {list.map((x) => (
        <div key={x.id} className="card"><div className="card-body row-tight">
          <Send size={15} aria-hidden="true" />
          <div className="grow"><b>{x.subject || t('(no subject)')}</b><div className="small muted">{(x.to || []).join(', ')} · {x.state === 'failed' ? <span className="ma-bad">{t(x.error ? x.error.text : 'Failed')}</span> : x.error ? t('Next try {when}', { when: when(x.sendAt) }) : t('Goes out {when}', { when: when(x.sendAt) })}</div></div>
          <Btn className="xs" icon={RotateCw} onClick={async () => { await post(`${BASE}/outbox/${x.id}/retry`); reload(); }}>Try again</Btn>
          <Btn className="xs ghost" icon={Pencil} onClick={async () => { const r = await del(`${BASE}/outbox/${x.id}`); reload(); if (r.draft) emit('compose', r.draft); }}>Edit</Btn>
          <Btn className="xs ghost icon" icon={Trash2} title="Discard" aria-label="Discard" onClick={async () => { if (await confirmDialog({ title: t('Discard this mail?'), confirm: t('Discard'), danger: true })) { await del(`${BASE}/outbox/${x.id}`); reload(); } }} />
        </div></div>
      ))}
    </div>
  );
}

export function SettingsDialog({ overview, reload, onClose, start = 'general' }) {
  const [tab, setTab] = useState(start);
  const [prefs, setPrefs] = useState(overview.prefs || {});
  const save = async (patch) => { const next = { ...prefs, ...patch }; setPrefs(next); try { setPrefs(await put(`${BASE}/prefs`, patch)); reload(); } catch (e) { toast.error(e.message); } };
  const tabs = [
    { id: 'general', label: 'General', icon: Settings2 }, { id: 'notify', label: 'Notifications', icon: Bell }, { id: 'rules', label: 'Rules', icon: Filter },
    { id: 'templates', label: 'Templates', icon: FileText }, { id: 'storage', label: 'Offline', icon: HardDrive }, { id: 'ai', label: 'AI', icon: Sparkles },
    { id: 'outbox', label: `${t('Outbox')}${(overview.outbox || []).length ? ` (${overview.outbox.length})` : ''}`, icon: Send },
  ];
  return (
    <Modal title="Mail settings" size="wide" onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      <div className="stack ma-settings">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        {tab === 'general' && <General prefs={prefs} save={save} />}
        {tab === 'notify' && <Notifications prefs={prefs} save={save} />}
        {tab === 'rules' && <Rules accounts={overview.accounts || []} />}
        {tab === 'templates' && <Templates />}
        {tab === 'storage' && <Storage prefs={prefs} save={save} overview={overview} reload={reload} />}
        {tab === 'ai' && <Ai prefs={prefs} save={save} />}
        {tab === 'outbox' && <Outbox overview={overview} reload={reload} />}
      </div>
    </Modal>
  );
}
