import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Paperclip, X, Bold, Italic, Underline, List, ListOrdered, Link2, Quote, RemoveFormatting, FileText, Save, Trash2, Type, ChevronDown, AlertTriangle, Flag } from 'lucide-react';
import { get, post } from '@hostwerk/api';
import { Btn, Modal, toast, confirmDialog, promptDialog, InfoTip } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t, pl } from '@hostwerk/i18n';
import { BASE, fmtSize, readFile, addrText } from './lib';

const ADDR = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;
const parseAddr = (s) => { const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s); return m ? { name: m[1].trim(), address: m[2].trim().toLowerCase() } : { name: '', address: String(s).trim().toLowerCase() }; };
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Signatur als HTML (Klartext wird umgewandelt) */
const sigHtml = (sig) => (!sig ? '' : /<[a-z][\s\S]*>/i.test(sig) ? sig : escHtml(sig).replace(/\n/g, '<br>'));
const SIG_RE = /<div class="hw-signature"[\s\S]*?<\/div>\s*<!--\/sig-->/;
const withSig = (html, sig) => {
  const block = sig ? `<div class="hw-signature">-- <br>${sigHtml(sig)}</div><!--/sig-->` : '';
  if (SIG_RE.test(html)) return html.replace(SIG_RE, block);
  const q = html.indexOf('<div class="hw-quote">');
  return q >= 0 ? `${html.slice(0, q)}${block}${html.slice(q)}` : `${html}${block ? `<p></p>${block}` : ''}`;
};

/** Empfänger-Feld mit Kärtchen und Vorschlägen aus den Kontakten */
function Recipients({ label, value, onChange, autoFocus }) {
  const [text, setText] = useState('');
  const [sugg, setSugg] = useState([]);
  const [hi, setHi] = useState(0);
  const id = useMemo(() => `ma-r-${Math.random().toString(36).slice(2, 8)}`, []);
  useEffect(() => {
    if (!text.trim()) { setSugg([]); return undefined; }
    const h = setTimeout(() => get(`${BASE}/contacts?q=${encodeURIComponent(text.trim())}`).then((r) => { setSugg(r.filter((x) => !value.some((v) => v.address === x.address))); setHi(0); }).catch(() => {}), 150);
    return () => clearTimeout(h);
  }, [text]);
  const add = (a) => { if (a && ADDR.test(a.address) && !value.some((v) => v.address === a.address)) onChange([...value, a]); setText(''); setSugg([]); };
  const commit = () => { for (const p of text.split(/[,;]+/).map((x) => x.trim()).filter(Boolean)) add(parseAddr(p)); };
  return (
    <div className="ma-rcpt">
      <label htmlFor={id} className="ma-rcpt-label">{label}</label>
      <div className="ma-rcpt-box">
        {value.map((a) => (
          <span key={a.address} className={`ma-chip${ADDR.test(a.address) ? '' : ' ma-chip-bad'}`} title={addrText(a)}>
            {a.name || a.address}
            <button type="button" className="ma-chip-x" aria-label={t('Remove {name}', { name: a.address })} onClick={() => onChange(value.filter((v) => v !== a))}><X size={12} /></button>
          </span>
        ))}
        <input id={id} className="ma-rcpt-input" value={text} autoFocus={autoFocus} autoComplete="off" role="combobox" aria-expanded={sugg.length > 0} aria-controls={`${id}-l`} aria-autocomplete="list"
          onChange={(e) => { const v = e.target.value; if (/[,;]\s*$/.test(v)) { setText(v); setTimeout(commit, 0); } else setText(v); }}
          onBlur={() => setTimeout(commit, 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && sugg.length) { e.preventDefault(); setHi((h) => Math.min(sugg.length - 1, h + 1)); }
            else if (e.key === 'ArrowUp' && sugg.length) { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
            else if ((e.key === 'Enter' || e.key === 'Tab') && sugg.length && text) { e.preventDefault(); add(sugg[hi]); }
            else if (e.key === 'Enter' && text) { e.preventDefault(); commit(); }
            else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
            else if (e.key === 'Escape' && sugg.length) { e.stopPropagation(); setSugg([]); }
          }} />
      </div>
      {sugg.length > 0 && (
        <ul className="ma-sugg" id={`${id}-l`} role="listbox">
          {sugg.map((s, i) => <li key={s.address} role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); add(s); }}>{s.name ? <><b>{s.name}</b> <span className="muted">{s.address}</span></> : s.address}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Rich-Text-Feld (contentEditable) mit kleiner Werkzeugleiste – oder Klartext */
function Editor({ html, onHtml, text, onText, plain, edRef }) {
  const cmd = (c, v = null) => { edRef.current && edRef.current.focus(); document.execCommand(c, false, v); onHtml(edRef.current.innerHTML); };
  useEffect(() => { if (!plain && edRef.current && edRef.current.innerHTML !== html) edRef.current.innerHTML = html; }, [plain]);
  if (plain) return <textarea className="input ma-plain" value={text} onChange={(e) => onText(e.target.value)} aria-label={t('Message')} spellCheck />;
  const tools = [
    [Bold, 'Bold (Ctrl+B)', () => cmd('bold')], [Italic, 'Italic (Ctrl+I)', () => cmd('italic')], [Underline, 'Underline (Ctrl+U)', () => cmd('underline')],
    [List, 'Bulleted list', () => cmd('insertUnorderedList')], [ListOrdered, 'Numbered list', () => cmd('insertOrderedList')], [Quote, 'Quote', () => cmd('formatBlock', 'blockquote')],
    [Link2, 'Insert link', async () => { const sel = window.getSelection(); const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null; const u = await promptDialog({ title: t('Insert link'), label: t('Address'), placeholder: 'https://' }); if (!u) return; if (range) { sel.removeAllRanges(); sel.addRange(range); } if (/^(https?:|mailto:)/i.test(u)) cmd('createLink', u); }],
    [RemoveFormatting, 'Remove formatting', () => cmd('removeFormat')],
  ];
  return (
    <div className="ma-editor">
      <div className="ma-tools" role="toolbar" aria-label={t('Formatting')}>
        {tools.map(([I, label, fn]) => <button key={label} type="button" className="btn xs ghost icon" title={t(label)} aria-label={t(label)} onMouseDown={(e) => e.preventDefault()} onClick={fn}><I size={15} /></button>)}
      </div>
      <div ref={edRef} className="ma-rich" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={t('Message')} spellCheck
        onInput={(e) => onHtml(e.currentTarget.innerHTML)}
        onPaste={(e) => {
          // Eingefügtes HTML nicht ungefiltert übernehmen: nur Text (Formatierung über die Leiste)
          const txt = e.clipboardData.getData('text/plain');
          if (e.clipboardData.types.includes('text/html')) { e.preventDefault(); document.execCommand('insertText', false, txt); }
        }} />
    </div>
  );
}

/**
 * Schreiben: Antwort/Weiterleiten kommt vorbefüllt vom Server (Zitat, Empfänger, Kette, Anhänge).
 * Speichert alle 30 s als Entwurf auf dem Server (nur bei Änderungen); Senden mit Rückgängig-Frist.
 */
export function Compose({ overview, initial, onClose, onSent }) {
  const accounts = (overview.accounts || []).filter((a) => a.smtp);
  const pick = accounts.find((a) => a.id === (initial && initial.account)) || accounts[0];
  const [acc, setAcc] = useState(pick ? pick.id : null);
  const account = accounts.find((a) => a.id === acc) || pick;
  const senders = account ? [{ name: account.displayName || '', address: account.email }, ...(account.aliases || [])] : [];
  const [from, setFrom] = useState((initial && initial.from && initial.from.address) || (account && account.email) || '');
  const [to, setTo] = useState((initial && initial.to) || []);
  const [cc, setCc] = useState((initial && initial.cc) || []);
  const [bcc, setBcc] = useState((initial && initial.bcc) || []);
  const [showCc, setShowCc] = useState(!!((initial && initial.cc && initial.cc.length) || (initial && initial.bcc && initial.bcc.length)));
  const [subject, setSubject] = useState((initial && initial.subject) || '');
  const prefsPlain = overview.prefs && overview.prefs.composeFormat === 'text';
  const [plain, setPlain] = useState(initial && initial.format ? initial.format === 'text' : prefsPlain);
  const [html, setHtml] = useState(() => withSig((initial && initial.html) || '<p></p>', initial && initial.draftRef ? null : account && account.signature));
  const [text, setText] = useState(() => `${(initial && initial.text) || ''}${account && account.signature && !(initial && initial.draftRef) ? `\n\n-- \n${account.signature.replace(/<[^>]+>/g, '')}` : ''}`);
  const [atts, setAtts] = useState((initial && initial.attachments) || []);
  const [priority, setPriority] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const [draftRef, setDraftRef] = useState((initial && initial.draftRef) || null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  const edRef = useRef(null);
  const templates = overview.templatesList || [];
  const mark = (fn) => (v) => { fn(v); setDirty(true); };

  // Absender wechseln → Signatur tauschen
  const firstAcc = useRef(true);
  useEffect(() => {
    if (firstAcc.current) { firstAcc.current = false; return; } // Startinhalt hat die Signatur schon (oder ist ein Entwurf)
    if (account) { setHtml((h) => withSig(h, account.signature)); if (edRef.current) edRef.current.innerHTML = withSig(edRef.current.innerHTML, account.signature); }
  }, [acc]);

  const body = () => ({
    account: acc, from: senders.find((s) => s.address === from) || { address: from }, to, cc, bcc, subject, format: plain ? 'text' : 'html',
    html: plain ? null : (edRef.current ? edRef.current.innerHTML : html), text: plain ? text : null, attachments: atts,
    inReplyTo: initial && initial.inReplyTo, references: initial && initial.references, origin: initial && initial.origin, mode: initial && initial.mode, priority, receipt, draftRef,
  });
  const saveDraft = async (quiet = false) => {
    if (!acc) return;
    setSaving(true);
    try { const r = await post(`${BASE}/draft`, body()); setDraftRef(r.uid ? r : null); setDirty(false); if (!quiet) toast.success(t('Draft saved')); } catch (e) { if (!quiet) toast.error(e.message); }
    setSaving(false);
  };
  useEffect(() => { if (!dirty) return undefined; const h = setTimeout(() => saveDraft(true), 30000); return () => clearTimeout(h); }, [dirty, html, text, subject, to, cc, bcc, atts]);

  const send = async () => {
    if (!to.length && !cc.length && !bcc.length) { toast.error(t('Add at least one recipient.')); return; }
    if (!subject.trim() && !(await confirmDialog({ title: t('Send without a subject?'), confirm: t('Send') }))) return;
    const content = plain ? text : (edRef.current ? edRef.current.innerText : '');
    if (/\b(anhang|anbei|attached|attachment|im anhang)\b/i.test(`${subject} ${content.split(/\n-- \n/)[0]}`) && !atts.length && !(await confirmDialog({ title: t('Forgot the attachment?'), text: t('The text mentions an attachment, but there is none.'), confirm: t('Send anyway') }))) return;
    setBusy(true);
    try {
      const r = await post(`${BASE}/send`, body());
      const secs = Math.max(0, Math.round((r.sendAt - Date.now()) / 1000));
      onSent && onSent();
      onClose();
      if (secs > 0) {
        toast(t('Sending in {n} s …', { n: secs }), 'info', secs * 1000, { action: { label: t('Undo'), onClick: async () => { try { const u = await post(`${BASE}/outbox/${r.id}/undo`); window.dispatchEvent(new CustomEvent('hw-mail-accounts:compose', { detail: { ...u.draft } })); } catch (e) { toast.error(e.message); } } } });
      } else toast.success(t('Sent'));
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const discard = async () => {
    if (dirty && !(await confirmDialog({ title: t('Discard this mail?'), confirm: t('Discard'), danger: true }))) return;
    onClose();
  };
  const addFiles = async (files) => {
    const list = await Promise.all([...files].map(readFile));
    const total = [...atts, ...list].reduce((n, a) => n + (a.size || 0), 0);
    if (total > 25 * 1048576) toast(t('More than 25 MB – many providers reject mails this big.'), 'warn');
    setAtts([...atts, ...list]); setDirty(true);
  };
  const insertTemplate = (tpl) => {
    if (tpl.subject && !subject) setSubject(tpl.subject);
    if (plain) setText((x) => `${tpl.html.replace(/<[^>]+>/g, '')}\n${x}`);
    else if (edRef.current) { edRef.current.focus(); document.execCommand('insertHTML', false, tpl.html); setHtml(edRef.current.innerHTML); }
    setDirty(true);
  };
  const togglePlain = async () => {
    if (!plain) {
      if (!(await confirmDialog({ title: t('Switch to plain text?'), text: t('Formatting and images in the text get lost.'), confirm: t('Plain text') }))) return;
      setText(edRef.current ? edRef.current.innerText : ''); setPlain(true);
    } else { setHtml(`<p>${escHtml(text).replace(/\n/g, '<br>')}</p>`); setPlain(false); }
  };
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); send(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); saveDraft(); }
  };
  if (!account) return null;
  const total = atts.reduce((n, a) => n + (a.size || 0), 0);
  return (
    <Modal title={initial && initial.mode === 'forward' ? 'Forward' : initial && initial.inReplyTo ? 'Reply' : 'New mail'} size="wide" onClose={discard}
      footer={<>
        <Btn className="ghost icon" icon={Trash2} title="Discard" aria-label="Discard" onClick={discard} />
        <Btn className="ghost" icon={Save} busy={saving} onClick={() => saveDraft(false)} title="Save draft (Ctrl+S)">Save draft</Btn>
        <span className="grow small muted" role="status">{saving ? t('Saving …') : draftRef ? t('Draft saved on the server') : ''}</span>
        <Btn className="primary" icon={Send} busy={busy} onClick={send} title="Send (Ctrl+Enter)">Send</Btn>
      </>}>
      <div className="ma-compose" onKeyDown={onKey} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } }}>
        <div className="ma-compose-head">
          <div className="ma-rcpt">
            <label className="ma-rcpt-label" htmlFor="ma-from">From</label>
            <select id="ma-from" className="select ma-from-select" value={`${acc}|${from}`} onChange={(e) => { const [a, f] = e.target.value.split('|'); setAcc(a); setFrom(f); setDirty(true); }}>
              {accounts.flatMap((a) => [{ name: a.displayName, address: a.email }, ...(a.aliases || [])].map((s) => <option key={`${a.id}|${s.address}`} value={`${a.id}|${s.address}`}>{s.name ? `${s.name} <${s.address}>` : s.address}{accounts.length > 1 ? ` · ${a.name}` : ''}</option>))}
            </select>
            {!showCc && <Btn className="xs ghost" onClick={() => setShowCc(true)}>Cc/Bcc</Btn>}
          </div>
          <Recipients label={t('To')} value={to} onChange={mark(setTo)} autoFocus={!to.length} />
          {showCc && <Recipients label={t('Cc')} value={cc} onChange={mark(setCc)} />}
          {showCc && <Recipients label={t('Bcc')} value={bcc} onChange={mark(setBcc)} />}
          <div className="ma-rcpt">
            <label className="ma-rcpt-label" htmlFor="ma-subj">Subject</label>
            <input id="ma-subj" className="ma-rcpt-input ma-subject" value={subject} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} autoFocus={!!to.length && !subject} />
          </div>
        </div>
        <div className="row-tight ma-compose-bar">
          <Btn className="xs ghost" icon={Paperclip} onClick={() => fileRef.current.click()}>Attach</Btn>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          {templates.length > 0 && <Btn className="xs ghost" icon={FileText} onClick={(e) => contextMenu(e, templates.map((x) => ({ label: x.name, icon: FileText, onClick: () => insertTemplate(x) })))}>Templates <ChevronDown size={12} aria-hidden="true" /></Btn>}
          <Btn className={`xs ghost${priority ? ' on' : ''}`} icon={Flag} aria-pressed={priority} onClick={() => setPriority(!priority)}>Important</Btn>
          <Btn className={`xs ghost${receipt ? ' on' : ''}`} aria-pressed={receipt} onClick={() => setReceipt(!receipt)}>Read receipt</Btn>
          <span className="grow" />
          <Btn className="xs ghost" icon={Type} onClick={togglePlain}>{plain ? 'Formatted' : 'Plain text'}</Btn>
          <InfoTip>{t('Ctrl+Enter sends, Ctrl+S saves the draft. Drop files anywhere here to attach them. After sending you have {n} seconds to undo.', { n: (overview.prefs && overview.prefs.undoSeconds) ?? 10 })}</InfoTip>
        </div>
        <Editor html={html} onHtml={mark(setHtml)} text={text} onText={mark(setText)} plain={plain} edRef={edRef} />
        {atts.length > 0 && (
          <div className="ma-atts" aria-label={t('Attachments')}>
            {atts.map((a, i) => (
              <span key={i} className="ma-att" title={a.filename}>
                <Paperclip size={13} aria-hidden="true" /><span className="ellipsis">{a.filename}</span><span className="muted small">{fmtSize(a.size)}</span>
                <button type="button" className="ma-chip-x" aria-label={t('Remove {name}', { name: a.filename })} onClick={() => { setAtts(atts.filter((x, j) => j !== i)); setDirty(true); }}><X size={12} /></button>
              </span>
            ))}
            <span className="small muted">{pl(atts.length, '{n} attachment', '{n} attachments')} · {fmtSize(total)}</span>
            {total > 25 * 1048576 && <span className="badge warn"><AlertTriangle size={12} aria-hidden="true" /> {t('very big')}</span>}
          </div>
        )}
      </div>
    </Modal>
  );
}
