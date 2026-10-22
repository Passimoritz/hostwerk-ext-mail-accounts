import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Reply, ReplyAll, Forward, Archive, Trash2, Star, MailOpen, Mail, MoreHorizontal, Image, ShieldAlert, ShieldCheck, ShieldX, Paperclip, Download, Eye,
  FolderInput, ArrowLeft, Sparkles, Languages, MessageCircleQuestion, MailX, FileDown, FolderDown, Ban, CloudOff, Link2,
} from 'lucide-react';
import { get, post, openExternal, canPickPath, pickFolder } from '@hostwerk/api';
import { Btn, Modal, Callout, Loading, Empty, toast, confirmDialog } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t, pl } from '@hostwerk/i18n';
import { BASE, apiUrl, qs, fullDate, addrText, who, initials, hue, fmtSize, textDomain, hostOf, baseDomain, emit } from './lib';

const LEVEL = { danger: 'err', warn: 'warn', info: 'info' };
const AUTH_ICON = (v) => (v === 'pass' ? ShieldCheck : v && /fail/.test(v) ? ShieldX : ShieldAlert);

/** Mail-Inhalt im abgeschotteten Rahmen: keine Skripte (sandbox ohne allow-scripts), eigene CSP, Links fängt Hostwerk ab */
function Body({ view, images, onLink, onHover }) {
  const ref = useRef(null);
  const [h, setH] = useState(200);
  const dark = !view.plain ? false : document.documentElement.getAttribute('data-theme') === 'dark' || window.matchMedia('(prefers-color-scheme: dark)').matches;
  const cs = getComputedStyle(document.documentElement);
  const fg = view.plain ? (cs.getPropertyValue('--text') || '').trim() : '';
  const bg = view.plain ? (cs.getPropertyValue('--surface') || '').trim() : '';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${images ? ' https: http:' : ''}; form-action 'none'; base-uri 'none'`;
  // Farben: HTML-Mails auf hellem Papier (sie sind dafür gestaltet), Klartext in Hostwerks Farben
  const css = `html{color-scheme:${dark ? 'dark' : 'light'}}body{margin:0;padding:16px;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;word-wrap:break-word;overflow-wrap:anywhere;${view.plain ? `color:${fg || 'CanvasText'};background:${bg || 'Canvas'};` : 'color:#1f2328;background:#fff;'}}img{max-width:100%;height:auto}img[data-hw-blocked]{display:inline-block;min-width:24px;min-height:24px;background:repeating-linear-gradient(45deg,#8881 0 6px,#8882 6px 12px);border-radius:4px}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 .4em;padding-left:.8em;border-left:3px solid #8886;color:inherit}a{color:${view.plain ? 'inherit' : '#0b57d0'}}a:focus-visible{outline:2px solid #0b57d0;outline-offset:2px}.hw-plain{white-space:normal}`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${css}</style></head><body>${view.html}</body></html>`;
  useLayoutEffect(() => {
    const f = ref.current;
    if (!f) return undefined;
    let ro = null;
    const wire = () => {
      const d = f.contentDocument;
      if (!d || !d.body) return;
      const fit = () => setH(Math.max(80, Math.min(40000, d.documentElement.scrollHeight)));
      fit();
      ro = new ResizeObserver(fit); ro.observe(d.body);
      d.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('data-hw-href');
        if (href) onLink(href, a.textContent || '');
      });
      d.addEventListener('mouseover', (e) => { const a = e.target.closest && e.target.closest('a'); onHover(a ? a.getAttribute('data-hw-href') || '' : ''); });
      d.addEventListener('focusin', (e) => { const a = e.target.closest && e.target.closest('a'); onHover(a ? a.getAttribute('data-hw-href') || '' : ''); });
      d.addEventListener('keydown', (e) => { if (e.key === 'Escape') f.blur(); });
    };
    f.addEventListener('load', wire);
    if (f.contentDocument && f.contentDocument.readyState === 'complete') wire();
    return () => { f.removeEventListener('load', wire); if (ro) ro.disconnect(); };
  }, [doc]);
  return <iframe ref={ref} className="ma-body" title={t('Content of the mail')} sandbox="allow-same-origin" srcDoc={doc} style={{ height: `${h}px` }} referrerPolicy="no-referrer" />;
}

/** Anhang ansehen: Bilder, PDF, Text – alles andere herunterladen */
function Preview({ att, url, onClose }) {
  const [text, setText] = useState(null);
  const isText = /^text\/plain$/i.test(att.contentType);
  useEffect(() => { if (isText) fetch(url, { credentials: 'same-origin' }).then((r) => r.text()).then((x) => setText(x.slice(0, 500000))).catch(() => setText('')); }, [url]);
  return (
    <Modal title={att.filename} subtitle={`${att.contentType} · ${fmtSize(att.size)}`} size="wide" onClose={onClose}
      footer={<><Btn onClick={onClose}>Close</Btn><a className="btn primary" href={`${url}&download=1`} download={att.filename}><Download size={14} aria-hidden="true" /> {t('Download')}</a></>}>
      <div className="ma-preview">
        {/^image\//i.test(att.contentType) && <img src={url} alt={att.filename} />}
        {/^application\/pdf$/i.test(att.contentType) && <iframe src={url} title={att.filename} />}
        {isText && (text == null ? <Loading /> : <pre>{text}</pre>)}
        {/^(audio)\//i.test(att.contentType) && <audio controls src={url} />}
        {/^(video)\//i.test(att.contentType) && <video controls src={url} />}
      </div>
    </Modal>
  );
}
const previewable = (a) => /^(image\/(png|jpe?g|gif|webp|bmp|avif)|application\/pdf|text\/plain|audio\/(mpeg|ogg|wav|webm)|video\/(mp4|webm|ogg))$/i.test(a.contentType);

/**
 * Lesen: Kopf, Prüfhinweise (Phishing, SPF/DKIM/DMARC), Bilder-Leiste, Inhalt, Anhänge, Aktionen.
 * props: { item, overview, ai, onAction(kind, items, extra), onBack, folders }
 */
export function Reader({ item, overview, ai, onAction, onBack, folders, narrow }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [images, setImages] = useState(false);
  const [hover, setHover] = useState('');
  const [preview, setPreview] = useState(null);
  const [aiOut, setAiOut] = useState(null);
  const [aiBusy, setAiBusy] = useState('');
  const [headers, setHeaders] = useState(false);
  const ref = { account: item.account, folder: item.folder, uid: item.uid };
  const load = async (img = false) => {
    setError(null);
    try { const v = await get(`${BASE}/message?${qs({ ...ref, images: img })}`); setView(v); setImages(img || !!v.imagesLoaded); } catch (e) { setError(e); }
  };
  useEffect(() => { setView(null); setAiOut(null); setImages(false); setHeaders(false); load(false); }, [item.key]);
  if (error) return <div className="ma-reader-empty"><Empty icon={CloudOff} title="Couldn’t load this mail" text={t(error.message)} action={<Btn onClick={() => load(false)}>Try again</Btn>} /></div>;
  if (!view) return <div className="ma-reader-empty" aria-busy="true"><Loading /></div>;
  const acc = (overview.accounts || []).find((a) => a.id === item.account);
  const ph = view.phishing || { level: 'ok', hints: [], auth: {} };
  const attUrl = (a, extra = {}) => apiUrl('/attachment', { ...ref, i: a.i, ...extra });
  const onLink = async (href, text) => {
    if (/^mailto:/i.test(href)) {
      const u = new URL(href);
      const to = decodeURIComponent(u.pathname).split(',').filter(Boolean).map((address) => ({ name: '', address: address.toLowerCase() }));
      emit('compose', { account: item.account, to, subject: u.searchParams.get('subject') || '', html: u.searchParams.get('body') ? `<p>${u.searchParams.get('body').replace(/</g, '&lt;')}</p>` : '' });
      return;
    }
    if (!/^https?:/i.test(href)) return;
    const td = textDomain(text); const h = hostOf(href);
    if (td && baseDomain(td) !== baseDomain(h)) {
      if (!(await confirmDialog({ title: t('This link leads somewhere else'), text: t('It shows “{shown}” but opens {real}. Phishing mails do exactly that. Open it anyway?', { shown: td, real: h }), confirm: t('Open anyway'), danger: true }))) return;
    }
    openExternal(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
  };
  const runAi = async (task) => {
    setAiBusy(task);
    try { const r = await post(`${BASE}/ai`, { task, ...ref }); setAiOut({ task, text: r.text }); } catch (e) { toast.error(e.message); }
    setAiBusy('');
  };
  const unsubscribe = async () => {
    const u = view.unsubscribe;
    if (!(await confirmDialog({ title: t('Unsubscribe from this mailing list?'), text: u.oneClick ? t('Hostwerk tells the sender with one request that you no longer want these mails – no website opens.') : u.http ? t('The sender’s unsubscribe page opens in your browser.') : t('A short unsubscribe mail opens for you to send.'), confirm: t('Unsubscribe') }))) return;
    try {
      const r = await post(`${BASE}/unsubscribe`, ref);
      if (r.done) toast.success(r.ok ? t('Unsubscribed') : t('The sender didn’t confirm the unsubscription.'));
      else if (r.http) openExternal(r.http).catch(() => window.open(r.http, '_blank', 'noopener,noreferrer'));
      else if (r.mailto) { const m = new URL(r.mailto); emit('compose', { account: item.account, to: [{ name: '', address: decodeURIComponent(m.pathname) }], subject: m.searchParams.get('subject') || 'unsubscribe', html: '<p>unsubscribe</p>' }); }
    } catch (e) { toast.error(e.message); }
  };
  const saveAll = async (a = null) => {
    const dir = await pickFolder(t('Save attachments to …'));
    if (!dir) return;
    try { const r = await post(`${BASE}/attachment/save`, { ...ref, dir, ...(a ? { i: a.i } : { all: true }) }); toast.success(pl(r.saved.length, '{n} file saved', '{n} files saved')); } catch (e) { toast.error(e.message); }
  };
  const attMenu = (e, a) => contextMenu(e, [
    previewable(a) && { label: t('Preview'), icon: Eye, onClick: () => setPreview(a) },
    { label: t('Download'), icon: Download, onClick: () => { const l = document.createElement('a'); l.href = attUrl(a, { download: 1 }); l.download = a.filename; l.click(); } },
    canPickPath() && { label: t('Save to folder …'), icon: FolderDown, onClick: () => saveAll(a) },
  ]);
  const moveMenu = (e) => contextMenu(e, (folders || []).filter((f) => f.path !== item.folder).map((f) => ({ label: f.name === f.path ? f.name : f.path, icon: FolderInput, onClick: () => onAction('move', [ref], { folder: f.path }) })));
  const more = (e) => contextMenu(e, [
    { label: item.seen === false ? t('Mark as read') : t('Mark as unread'), icon: item.seen === false ? MailOpen : Mail, onClick: () => onAction('seen', [ref], { on: item.seen === false }) },
    { label: t('Move to …'), icon: FolderInput, onClick: () => moveMenu(e) },
    { label: t('Spam'), icon: Ban, onClick: () => onAction('junk', [ref]) },
    '-',
    { label: t('Save as .eml'), icon: FileDown, onClick: () => { const l = document.createElement('a'); l.href = apiUrl('/raw', { ...ref, name: (view.subject || 'mail').slice(0, 60) }); l.click(); } },
    { label: headers ? t('Hide details') : t('Show details'), icon: ShieldCheck, onClick: () => setHeaders(!headers) },
    view.from && { label: t('Always load images from {name}', { name: view.from.address }), icon: Image, onClick: async () => { await post(`${BASE}/trust-sender`, { address: view.from.address }); load(true); } },
  ]);
  const authBadges = ['spf', 'dkim', 'dmarc'].filter((k) => ph.auth && ph.auth[k]).map((k) => { const I = AUTH_ICON(ph.auth[k]); return <span key={k} className={`badge ${ph.auth[k] === 'pass' ? 'ok' : /fail/.test(ph.auth[k]) ? 'err' : ''}`} title={t('{check}: {result}', { check: k.toUpperCase(), result: ph.auth[k] })}><I size={12} aria-hidden="true" />{k.toUpperCase()}</span>; });
  return (
    <article className="ma-reader" aria-label={view.subject || t('(no subject)')}>
      <header className="ma-read-head">
        {narrow && <Btn className="xs ghost icon" icon={ArrowLeft} title="Back to the list" aria-label="Back to the list" onClick={onBack} />}
        <h2 className="ma-subject">{view.subject || t('(no subject)')}</h2>
        <div className="ma-read-actions" role="toolbar" aria-label={t('Actions')}>
          <Btn className="sm ghost icon" icon={Reply} title="Reply (R)" aria-label="Reply" onClick={() => onAction('reply', [ref])} />
          <Btn className="sm ghost icon" icon={ReplyAll} title="Reply all (A)" aria-label="Reply all" onClick={() => onAction('replyAll', [ref])} />
          <Btn className="sm ghost icon" icon={Forward} title="Forward (F)" aria-label="Forward" onClick={() => onAction('forward', [ref])} />
          <Btn className="sm ghost icon" icon={Archive} title="Archive (E)" aria-label="Archive" onClick={() => onAction('archive', [ref])} />
          <Btn className="sm ghost icon" icon={Trash2} title="Delete (Del)" aria-label="Delete" onClick={() => onAction('delete', [ref])} />
          <Btn className={`sm ghost icon${item.flagged ? ' ma-starred' : ''}`} icon={Star} title="Star (S)" aria-label={item.flagged ? 'Remove star' : 'Star'} aria-pressed={!!item.flagged} onClick={() => onAction('flag', [ref], { on: !item.flagged })} />
          <Btn className="sm ghost icon" icon={MoreHorizontal} title="More" aria-label="More actions" onClick={more} />
        </div>
      </header>
      <div className="ma-read-meta">
        <span className="ma-avatar" style={{ '--h': hue(view.from && view.from.address) }} aria-hidden="true">{initials(view.from)}</span>
        <div className="grow ma-read-who">
          <div><b>{who(view.from)}</b> <span className="muted small">{view.from && view.from.name ? `<${view.from.address}>` : ''}</span></div>
          <div className="small muted ellipsis" title={(view.to || []).map(addrText).join(', ')}>{t('to')} {(view.to || []).map((a) => (acc && a.address === acc.email ? t('me') : who(a))).join(', ')}{view.cc && view.cc.length ? ` · ${t('cc')} ${view.cc.map(who).join(', ')}` : ''}</div>
        </div>
        <div className="ma-read-date small muted" title={fullDate(view.date)}>{fullDate(view.date)}</div>
      </div>
      <div className="row-tight ma-read-badges">
        {view.offline && <span className="badge"><CloudOff size={12} aria-hidden="true" /> {t('from the cache')}</span>}
        {view.priority && <span className="badge warn">{t('Important')}</span>}
        {authBadges}
        {view.trackers > 0 && <span className="badge ok" title={t('Invisible images that report when you open a mail')}>{pl(view.trackers, '{n} tracker blocked', '{n} trackers blocked')}</span>}
        {view.unsubscribe && <Btn className="xs ghost" icon={MailX} onClick={unsubscribe}>Unsubscribe</Btn>}
        {ai && ai.ready && ai.allowed && (
          <>
            <Btn className="xs ghost" icon={Sparkles} busy={aiBusy === 'summarize'} onClick={() => runAi('summarize')}>Summarise</Btn>
            <Btn className="xs ghost" icon={Languages} busy={aiBusy === 'translate'} onClick={() => runAi('translate')}>Translate</Btn>
            <Btn className="xs ghost" icon={MessageCircleQuestion} busy={aiBusy === 'explain'} onClick={() => runAi('explain')}>What do they want?</Btn>
          </>
        )}
      </div>
      {ph.hints.filter((x) => x.level !== 'info' || ph.level === 'danger').length > 0 && (
        <Callout kind={LEVEL[ph.level] || 'warn'} icon={ShieldAlert} dismissible={false} title={ph.level === 'danger' ? t('Careful – this could be phishing') : t('Please check')}>
          <ul className="ma-hints">{ph.hints.map((x, i) => <li key={i}>{t(x.text, x.vars)}</li>)}</ul>
        </Callout>
      )}
      {headers && (
        <dl className="ma-cert ma-details">
          <dt>From</dt><dd>{addrText(view.from)}</dd>
          {view.replyTo && view.replyTo.length > 0 && <><dt>Reply to</dt><dd>{view.replyTo.map(addrText).join(', ')}</dd></>}
          <dt>To</dt><dd>{(view.to || []).map(addrText).join(', ')}</dd>
          {view.cc && view.cc.length > 0 && <><dt>Cc</dt><dd>{view.cc.map(addrText).join(', ')}</dd></>}
          <dt>Message-ID</dt><dd className="mono">{view.messageId}</dd>
          <dt>SPF / DKIM / DMARC</dt><dd>{['spf', 'dkim', 'dmarc'].map((k) => `${k.toUpperCase()}: ${(ph.auth && ph.auth[k]) || '–'}`).join(' · ')}</dd>
          <dt>Links</dt><dd>{view.links}</dd>
        </dl>
      )}
      {aiOut && (
        <Callout kind="info" icon={Sparkles} dismissible={false} title={aiOut.task === 'translate' ? t('Translation') : aiOut.task === 'explain' ? t('What the sender wants') : t('Summary')}>
          <div className="ma-ai">{aiOut.text}</div>
          <div className="row-tight"><span className="small muted grow">{t('Written by the AI assistant – check before you rely on it.')}</span><Btn className="xs ghost" onClick={() => setAiOut(null)}>Close</Btn></div>
        </Callout>
      )}
      {view.remoteImages > 0 && !images && (
        <div className="row-tight ma-images-bar" role="note">
          <Image size={15} aria-hidden="true" />
          <span className="grow small">{pl(view.remoteImages, 'Hostwerk held back {n} image from the internet – loading it tells the sender you read the mail.', 'Hostwerk held back {n} images from the internet – loading them tells the sender you read the mail.')}</span>
          <Btn className="xs" onClick={() => load(true)}>Load images</Btn>
          {view.from && <Btn className="xs ghost" onClick={async () => { await post(`${BASE}/trust-sender`, { address: view.from.address }); load(true); }}>Always for this sender</Btn>}
        </div>
      )}
      <Body view={view} images={images} onLink={onLink} onHover={setHover} />
      <div className="ma-hover small mono" aria-live="polite">{hover ? <><Link2 size={12} aria-hidden="true" /> {hover}</> : null}</div>
      {view.attachments && view.attachments.length > 0 && (
        <section className="ma-read-atts" aria-label={t('Attachments')}>
          <div className="row-tight"><Paperclip size={14} aria-hidden="true" /><b className="grow">{pl(view.attachments.length, '{n} attachment', '{n} attachments')}</b>{canPickPath() && view.attachments.length > 1 && <Btn className="xs ghost" icon={FolderDown} onClick={() => saveAll(null)}>Save all …</Btn>}</div>
          <div className="ma-att-grid">
            {view.attachments.map((a) => (
              <button key={a.i} type="button" className={`ma-att-card${/\.(exe|scr|bat|cmd|js|vbs|ps1|msi|jar|lnk|hta|iso|docm|xlsm)$/i.test(a.filename) ? ' ma-risky' : ''}`} title={t('{name} – right-click for more', { name: a.filename })}
                onClick={() => { if (previewable(a)) setPreview(a); else { const l = document.createElement('a'); l.href = attUrl(a, { download: 1 }); l.download = a.filename; l.click(); } }} onContextMenu={(e) => attMenu(e, a)}>
                <Paperclip size={14} aria-hidden="true" /><span className="ellipsis grow">{a.filename}</span><span className="small muted">{fmtSize(a.size)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {preview && <Preview att={preview} url={attUrl(preview)} onClose={() => setPreview(null)} />}
    </article>
  );
}

