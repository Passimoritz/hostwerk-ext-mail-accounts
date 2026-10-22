import { useEffect, useRef, useState } from 'react';
import { Mail, Search, KeyRound, ShieldCheck, ShieldAlert, Server, ExternalLink, Copy, Check, Inbox, Trash2, RefreshCw, Plus, X, Lock, Globe } from 'lucide-react';
import { get, post, put, del, openExternal } from '@hostwerk/api';
import { Btn, Modal, Field, Callout, InfoTip, Seg, Switch, SettingRow, toast, confirmDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { BASE, fullDate } from './lib';

const SOURCE = {
  autoconfig: 'from the provider', ispdb: 'from Mozilla’s provider directory', 'ispdb-mx': 'via the mail exchanger (MX)', srv: 'from DNS (SRV records)',
  autodiscover: 'via Microsoft Autodiscover', guess: 'guessed and tested',
};
const SECURITY = [{ id: 'tls', label: 'SSL/TLS' }, { id: 'starttls', label: 'STARTTLS' }, { id: 'none', label: 'None' }];
const COLORS = ['#2563eb', '#0d9488', '#d97706', '#db2777', '#7c3aed', '#059669', '#dc2626', '#0891b2'];
const open = (url) => openExternal(url).catch(() => window.open(url, '_blank', 'noopener'));
const copy = (s) => navigator.clipboard.writeText(s).then(() => toast.success(t('Copied'))).catch(() => {});

/** Server-Felder (IMAP oder SMTP) */
function ServerFields({ label, value, onChange, smtp = false }) {
  const v = value || {};
  const set = (k, x) => onChange({ ...v, [k]: x });
  const ports = smtp ? { tls: 465, starttls: 587, none: 25 } : { tls: 993, starttls: 143, none: 143 };
  return (
    <fieldset className="ma-server">
      <legend>{label}</legend>
      <div className="ma-server-grid">
        <Field label="Server"><input className="input mono" value={v.host || ''} onChange={(e) => set('host', e.target.value.trim())} placeholder={smtp ? 'smtp.example.com' : 'imap.example.com'} spellCheck={false} /></Field>
        <Field label="Port"><input className="input mono" inputMode="numeric" value={v.port || ''} onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '')) || '')} /></Field>
        <Field label="Encryption"><select className="select" value={v.security || 'tls'} onChange={(e) => onChange({ ...v, security: e.target.value, port: ports[e.target.value] })}>{SECURITY.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}</select></Field>
      </div>
    </fieldset>
  );
}

/** Zertifikat ansehen und bewusst vertrauen */
export function CertDialog({ cert, onTrust, onClose }) {
  const [busy, setBusy] = useState(false);
  const expired = cert.validTo && cert.validTo < Date.now();
  return (
    <Modal title="Certificate can’t be verified" subtitle={`${cert.host}:${cert.port}`} onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="danger" icon={ShieldCheck} busy={busy} onClick={async () => { setBusy(true); try { await onTrust(cert.fingerprint256); onClose(); } catch (e) { toast.error(e.message); } setBusy(false); }}>Trust exactly this certificate</Btn></>}>
      <div className="stack">
        <Callout kind="warn" icon={ShieldAlert} dismissible={false}>
          {t('Only trust it if you know this server – e.g. your own mail server or the one of your company. A stranger could otherwise read your password.')}
        </Callout>
        <dl className="ma-cert">
          <dt>Issued to</dt><dd>{cert.subject || '–'}</dd>
          <dt>Issued by</dt><dd>{cert.issuer || '–'}{cert.selfSigned ? ` (${t('self-signed')})` : ''}</dd>
          <dt>Names</dt><dd className="mono">{(cert.altNames || []).join(', ') || '–'}</dd>
          <dt>Valid</dt><dd className={expired ? 'ma-bad' : ''}>{fullDate(cert.validFrom)} – {fullDate(cert.validTo)}{expired ? ` · ${t('expired')}` : ''}</dd>
          <dt>Reason</dt><dd className="mono">{cert.reason || '–'}</dd>
          <dt>SHA-256</dt><dd className="mono ma-fp">{cert.fingerprint256}</dd>
        </dl>
        <InfoTip>{t('Hostwerk remembers only this one fingerprint for this one server. If the certificate changes, it asks again.')}</InfoTip>
      </div>
    </Modal>
  );
}

/** Neues Konto: Adresse → Einstellungen finden → anmelden (Passwort/App-Passwort oder OAuth) */
export function AccountWizard({ overview, onClose, onDone, prefill = null }) {
  const [email, setEmail] = useState(prefill ? prefill.email || '' : '');
  const [name, setName] = useState('');
  const [found, setFound] = useState(null);
  const [manual, setManual] = useState(!!prefill);
  const [imap, setImap] = useState(prefill ? prefill.imap : { security: 'tls', port: 993 });
  const [smtp, setSmtp] = useState(prefill ? prefill.smtp : { security: 'starttls', port: 587 });
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [method, setMethod] = useState('password');
  const [oauth, setOauth] = useState({ clientId: '', clientSecret: '', authURL: '', tokenURL: '', scope: '', issuer: '' });
  const [oauthState, setOauthState] = useState(null);
  const [redirect, setRedirect] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [cert, setCert] = useState(null);
  const [trustFp, setTrustFp] = useState({});
  const poll = useRef(null);
  useEffect(() => () => clearInterval(poll.current), []);
  const local = (overview && overview.local) || [];
  const catcher = local.find((x) => x.id === 'catcher');
  const hasCatcher = (overview.accounts || []).some((a) => a.local === 'catcher');

  const doDiscover = async () => {
    setBusy(true); setError(null);
    try {
      const r = await post(`${BASE}/discover`, { email });
      setFound(r);
      if (r.found) {
        setImap({ host: r.imap.host, port: r.imap.port, security: r.imap.security });
        if (r.smtp) setSmtp({ host: r.smtp.host, port: r.smtp.port, security: r.smtp.security });
        setUser(r.username || email);
        if (r.oauth2) setOauth((o) => ({ ...o, ...r.oauth2 }));
        setManual(false);
      } else setManual(true);
    } catch (e) { setError({ text: e.message }); }
    setBusy(false);
  };
  const draft = (extra = {}) => ({
    email, name: name || email, imap: { ...imap, trustFingerprint: trustFp.imap }, smtp: smtp && smtp.host ? { ...smtp, trustFingerprint: trustFp.smtp } : null,
    auth: method === 'oauth2' ? { type: 'oauth2', user: user || email } : { type: 'password', user: user || email, pass },
    provider: found && found.found ? found.provider : null, docs: found && found.docs, enable: found && found.enable, ...extra,
  });
  const connect = async (extra = {}) => {
    setBusy(true); setError(null);
    try {
      const a = await post(`${BASE}/accounts`, draft(extra));
      toast.success(t('{email} is connected', { email: a.email }));
      onDone(a);
    } catch (e) {
      setError({ text: e.message, code: e.code || null, detail: e.hint || null });
      if (e.code === 'cert') {
        try { setCert({ ...(await post(`${BASE}/cert`, { ...imap, kind: 'imap' })), kind: 'imap' }); } catch { /* bleibt beim Fehlertext */ }
      }
    }
    setBusy(false);
  };
  // Prüfen ohne zu speichern: Eingang und Ausgang getrennt, mit Grund
  const test = async () => {
    setBusy(true); setError(null);
    try {
      const r = await post(`${BASE}/test`, draft());
      const msg = [r.imap && (r.imap.ok ? t('Incoming: works ({n} folders)', { n: r.imap.folders }) : `${t('Incoming')}: ${t(r.imap.error.text)}`), r.smtp && (r.smtp.ok ? t('Sending: works') : `${t('Sending')}: ${t(r.smtp.error.text)}`)].filter(Boolean).join(' · ');
      if (r.imap && r.imap.ok && (!r.smtp || r.smtp.ok)) toast.success(msg); else setError({ text: msg, code: (r.imap && r.imap.error && r.imap.error.code) || (r.smtp && r.smtp.error && r.smtp.error.code) });
      const bad = r.imap && r.imap.error && r.imap.error.code === 'cert' ? 'imap' : r.smtp && r.smtp.error && r.smtp.error.code === 'cert' ? 'smtp' : null;
      if (bad) setCert({ ...(await post(`${BASE}/cert`, { ...(bad === 'imap' ? imap : smtp), kind: bad })), kind: bad });
    } catch (e) { setError({ text: e.message }); }
    setBusy(false);
  };
  const startOauth = async () => {
    setBusy(true); setError(null);
    try {
      const r = await post(`${BASE}/oauth/start`, { email, ...oauth });
      setRedirect(r.redirectUri); setOauthState(r.state);
      open(r.url);
      clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try {
          const s = await get(`${BASE}/oauth/result?state=${encodeURIComponent(r.state)}`);
          if (s.pending) return;
          clearInterval(poll.current);
          if (s.ok) connect({ oauthState: r.state }); else { setError({ text: s.error || t('Sign-in didn’t work') }); setBusy(false); }
        } catch { /* weiter warten */ }
      }, 2000);
    } catch (e) { setError({ text: e.message }); setBusy(false); }
  };
  const addCatcher = async () => {
    setBusy(true);
    try { const a = await post(`${BASE}/accounts`, { local: 'catcher' }); toast.success(t('Mail catcher connected')); onDone(a); } catch (e) { setError({ text: e.message }); }
    setBusy(false);
  };
  const authOptions = (found && found.auth) || [];
  const oauthHint = authOptions.includes('oauth2');
  const step = found || manual ? 'login' : 'email';

  return (
    <Modal title="Connect an e-mail account" subtitle="Gmail, Outlook, web.de, GMX, iCloud, your own domain …" size="wide" onClose={onClose}
      footer={step === 'email'
        ? <><Btn onClick={onClose}>Cancel</Btn><Btn onClick={() => setManual(true)}>Enter manually</Btn><Btn className="primary" icon={Search} busy={busy} disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)} onClick={doDiscover}>Continue</Btn></>
        : <><Btn onClick={onClose}>Cancel</Btn>{method === 'password' && <Btn busy={busy} onClick={test}>Test</Btn>}
          {method === 'oauth2'
            ? <Btn className="primary" icon={KeyRound} busy={busy} disabled={!oauth.clientId} onClick={startOauth}>Sign in with the provider</Btn>
            : <Btn className="primary" icon={Check} busy={busy} disabled={!pass || !imap.host} onClick={() => connect()}>Connect</Btn>}</>}>
      <div className="stack ma-wizard">
        {step === 'email' && (
          <>
            <Field label="E-mail address"><input className="input" type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} onKeyDown={(e) => { if (e.key === 'Enter' && /@/.test(email)) doDiscover(); }} placeholder="name@example.com" /></Field>
            <InfoTip>{t('Hostwerk looks up the settings itself – at your provider (autoconfig), in Mozilla’s provider directory (the same Thunderbird uses), via your domain’s mail server and DNS. Only the domain is sent to Mozilla, not your address.')}</InfoTip>
            {catcher && !hasCatcher && (
              <div className="ma-local card">
                <div className="card-body row-tight">
                  <Inbox size={18} aria-hidden="true" />
                  <div className="grow"><b>Mail catcher</b><div className="small muted">{catcher.running ? t('Read the mails your projects send like a normal mailbox.') : t('Switch on IMAP for the mail catcher first (E-mail → Mail catcher).')}</div></div>
                  <Btn className="sm" disabled={!catcher.running} busy={busy} onClick={addCatcher}>Connect</Btn>
                </div>
              </div>
            )}
            {local.filter((x) => x.kind === 'mailserver').map((x) => (
              <div key={x.id} className="ma-local card">
                <div className="card-body row-tight">
                  <Server size={18} aria-hidden="true" />
                  <div className="grow"><b>{x.name}</b><div className="small muted">{t('Mailbox on your own mail server')}{x.domain ? ` · @${x.domain}` : ''}</div></div>
                  <Btn className="sm" onClick={() => { setEmail(x.domain ? `@${x.domain}` : ''); setImap(x.imap); if (x.smtp) setSmtp(x.smtp); setManual(true); }}>Use</Btn>
                </div>
              </div>
            ))}
            {error && <Callout kind="err" dismissible={false}>{t(error.text)}</Callout>}
          </>
        )}
        {step === 'login' && (
          <>
            {found && found.found && (
              <div className="row-tight ma-found">
                <Globe size={16} aria-hidden="true" />
                <span className="grow"><b>{found.provider && found.provider.name ? found.provider.name : found.domain}</b> · <span className="muted">{t('Settings found {source}', { source: t(SOURCE[found.source] || found.source) })}</span></span>
                <Btn className="xs ghost" onClick={() => setManual((m) => !m)}>{manual ? 'Hide servers' : 'Show servers'}</Btn>
              </div>
            )}
            {found && !found.found && <Callout kind="info" dismissible={false}>{found.offline ? t('Offline mode is on – enter the servers yourself.') : t('No settings found for {domain} – enter the servers from your provider’s help page.', { domain: found.domain })}</Callout>}
            {found && found.enable && (
              <Callout kind="warn" dismissible={false} title={t('Switch on access first')}>
                {found.enable.text || t('Your provider wants you to allow access by mail programs in its web settings first.')}{' '}
                <a href={found.enable.url} onClick={(e) => { e.preventDefault(); open(found.enable.url); }}>{t('Open the setting')} <ExternalLink size={12} aria-hidden="true" /></a>
              </Callout>
            )}
            <div className="ma-form-grid">
              <Field label="E-mail address"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} /></Field>
              <Field label="Name in the list"><input className="input" value={name} placeholder={email} onChange={(e) => setName(e.target.value)} /></Field>
            </div>
            <Seg value={method} onChange={setMethod} options={[{ id: 'password', label: 'Password or app password', icon: Lock }, { id: 'oauth2', label: 'Sign in with the provider (OAuth)', icon: KeyRound }]} />
            {method === 'password' && (
              <>
                <div className="ma-form-grid">
                  <Field label="User name"><input className="input" value={user} placeholder={email} onChange={(e) => setUser(e.target.value.trim())} autoComplete="username" /></Field>
                  <Field label="Password"><input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" onKeyDown={(e) => { if (e.key === 'Enter' && pass) connect(); }} /></Field>
                </div>
                {(oauthHint || (found && found.docs && found.docs.length > 0)) && (
                  <Callout kind="info" dismissible={false} title={t('With two-step login you need an app password')}>
                    {t('Many providers (Google, Yahoo, iCloud, GMX, web.de …) don’t accept your normal password from mail programs. Create an app password in your account’s security settings and paste it here.')}
                    {(found && found.docs || []).slice(0, 3).map((d) => <div key={d.url}><a href={d.url} onClick={(e) => { e.preventDefault(); open(d.url); }}>{d.text || d.url} <ExternalLink size={12} aria-hidden="true" /></a></div>)}
                  </Callout>
                )}
                <InfoTip>{t('The password is stored encrypted with Hostwerk’s key and is never shown again.')}</InfoTip>
              </>
            )}
            {method === 'oauth2' && (
              <>
                <Callout kind="info" dismissible={false} title={t('Your own app ID')}>
                  {t('Google and Microsoft only allow OAuth for registered apps. Hostwerk doesn’t ship its own registration – it would need constant upkeep and could be blocked any time. Register a free app once (Google Cloud Console: “Desktop app”; Microsoft Entra: “Mobile and desktop”) with this redirect address and paste its ID here.')}
                </Callout>
                <div className="row-tight ma-redirect">
                  <span className="mono grow ellipsis">{redirect || `${location.origin}/api/x/mail-accounts/pub/oauth`}</span>
                  <Btn className="xs ghost icon" icon={Copy} title="Copy redirect address" aria-label="Copy redirect address" onClick={() => copy(redirect || `${location.origin}/api/x/mail-accounts/pub/oauth`)} />
                </div>
                <div className="ma-form-grid">
                  <Field label="Client ID"><input className="input mono" value={oauth.clientId} onChange={(e) => setOauth({ ...oauth, clientId: e.target.value.trim() })} spellCheck={false} /></Field>
                  <Field label="Client secret (if your app has one)"><input className="input mono" type="password" value={oauth.clientSecret} onChange={(e) => setOauth({ ...oauth, clientSecret: e.target.value.trim() })} /></Field>
                </div>
                <details className="ma-adv">
                  <summary>Advanced: sign-in addresses</summary>
                  <div className="stack">
                    <Field label="Authorization URL"><input className="input mono" value={oauth.authURL} onChange={(e) => setOauth({ ...oauth, authURL: e.target.value.trim() })} /></Field>
                    <Field label="Token URL"><input className="input mono" value={oauth.tokenURL} onChange={(e) => setOauth({ ...oauth, tokenURL: e.target.value.trim() })} /></Field>
                    <Field label="Scope"><input className="input mono" value={oauth.scope} onChange={(e) => setOauth({ ...oauth, scope: e.target.value })} /></Field>
                  </div>
                </details>
                {!oauthHint && <InfoTip>{t('The provider directory names no OAuth sign-in for this address – a password or app password is usually the way.')}</InfoTip>}
                {busy && oauthState && <p className="small muted" role="status">{t('Waiting for the sign-in in your browser …')}</p>}
              </>
            )}
            {(manual || !(found && found.found)) && (
              <div className="ma-form-grid">
                <ServerFields label={t('Incoming mail (IMAP)')} value={imap} onChange={setImap} />
                <ServerFields label={t('Outgoing mail (SMTP)')} value={smtp} onChange={setSmtp} smtp />
              </div>
            )}
            {error && (
              <Callout kind="err" dismissible={false}>
                {t(error.text)}{error.detail ? <div className="small mono muted">{error.detail}</div> : null}
                {error.code === 'cert' && cert && <div><Btn className="xs" icon={ShieldAlert} onClick={() => setCert({ ...cert })}>Look at the certificate</Btn></div>}
              </Callout>
            )}
          </>
        )}
      </div>
      {cert && <CertDialog cert={cert} onClose={() => setCert(null)} onTrust={async (fp) => { setTrustFp((x) => ({ ...x, [cert.kind]: fp })); setError(null); toast.success(t('Certificate noted – connect again.')); }} />}
    </Modal>
  );
}

/** Konto bearbeiten: Name, Absender, Farbe, Signatur, Aliasse, Server, Passwort, Zertifikat, Entfernen */
export function AccountSettings({ account, onClose, onChanged }) {
  const a = account;
  const [f, setF] = useState({ name: a.name, displayName: a.displayName, color: a.color, signature: a.signature, notify: a.notify, saveSent: a.saveSent || 'auto', aliases: a.aliases || [] });
  const [srv, setSrv] = useState({ imap: { ...a.imap }, smtp: a.smtp ? { ...a.smtp } : { security: 'starttls', port: 587 } });
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [cert, setCert] = useState(null);
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f };
      const changedSrv = ['host', 'port', 'security'].some((k) => srv.imap[k] !== a.imap[k] || (a.smtp ? srv.smtp[k] !== a.smtp[k] : !!srv.smtp.host));
      if (changedSrv || pass) Object.assign(body, { imap: srv.imap, smtp: srv.smtp.host ? srv.smtp : null, auth: a.auth.type === 'oauth2' ? { type: 'oauth2' } : { type: 'password', user: a.auth.user, pass } });
      await put(`${BASE}/accounts/${a.id}`, body);
      toast.success(t('Saved'));
      onChanged(); onClose();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: t('Remove {email} from Hostwerk?', { email: a.email }), text: t('Hostwerk forgets the account, its settings and its cached mails. Nothing is deleted on the mail server.'), confirm: t('Remove'), danger: true }))) return;
    try { await del(`${BASE}/accounts/${a.id}`); onChanged(); onClose(); } catch (e) { toast.error(e.message); }
  };
  const showCert = async (kind) => { try { setCert({ ...(await get(`${BASE}/accounts/${a.id}/cert?kind=${kind}`)), kind }); } catch (e) { toast.error(e.message); } };
  return (
    <Modal title={a.email} subtitle="Account settings" size="wide" onClose={onClose}
      footer={<><Btn className="danger ghost" icon={Trash2} onClick={remove}>Remove account</Btn><span className="grow" /><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" busy={busy} onClick={save}>Save</Btn></>}>
      <div className="stack ma-account-settings">
        <div className="ma-form-grid">
          <Field label="Name in the list"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Your name as sender"><input className="input" value={f.displayName} placeholder={a.email} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
        </div>
        <Field label="Colour">
          <div className="row-tight ma-colors" role="radiogroup" aria-label={t('Colour')}>
            {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={f.color === c} className={`ma-color${f.color === c ? ' on' : ''}`} style={{ background: c }} title={c} aria-label={c} onClick={() => setF({ ...f, color: c })} />)}
          </div>
        </Field>
        <Field label="Signature" hint={t('Plain text or simple HTML – added under new mails and replies.')}>
          <textarea className="input ma-sig" rows={4} value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} />
        </Field>
        <Field label="Other sender addresses (aliases)">
          <div className="stack ma-aliases">
            {f.aliases.map((x, i) => (
              <div key={i} className="row-tight">
                <input className="input" placeholder={t('Name')} value={x.name} onChange={(e) => setF({ ...f, aliases: f.aliases.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) })} aria-label={t('Name')} />
                <input className="input" type="email" placeholder="alias@example.com" value={x.address} onChange={(e) => setF({ ...f, aliases: f.aliases.map((y, j) => (j === i ? { ...y, address: e.target.value.trim() } : y)) })} aria-label={t('Address')} />
                <Btn className="xs ghost icon" icon={X} title="Remove alias" aria-label="Remove alias" onClick={() => setF({ ...f, aliases: f.aliases.filter((y, j) => j !== i) })} />
              </div>
            ))}
            <div><Btn className="xs" icon={Plus} onClick={() => setF({ ...f, aliases: [...f.aliases, { name: f.displayName || '', address: '' }] })}>Add alias</Btn></div>
          </div>
        </Field>
        <SettingRow title="Notify me about new mails" text=""><Switch checked={f.notify} onChange={(v) => setF({ ...f, notify: v })} label={t('Notify me about new mails')} /></SettingRow>
        <Field label="Keep sent mails" hint={t('Gmail files sent mails itself – Hostwerk notices that.')}>
          <select className="select" value={f.saveSent} onChange={(e) => setF({ ...f, saveSent: e.target.value })}>
            <option value="auto">{t('Automatically (not with Gmail)')}</option><option value="always">{t('Always put a copy into “Sent”')}</option><option value="never">{t('Never – the server does it')}</option>
          </select>
        </Field>
        <details className="ma-adv">
          <summary>Servers and login</summary>
          <div className="stack">
            <div className="ma-form-grid">
              <ServerFields label={t('Incoming mail (IMAP)')} value={srv.imap} onChange={(v) => setSrv({ ...srv, imap: v })} />
              <ServerFields label={t('Outgoing mail (SMTP)')} value={srv.smtp} onChange={(v) => setSrv({ ...srv, smtp: v })} smtp />
            </div>
            {a.auth.type === 'password'
              ? <Field label="New password" hint={t('Leave empty to keep the stored one.')}><input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></Field>
              : <p className="small muted">{t('Signed in with OAuth (app ID {id}).', { id: (a.auth.oauth && a.auth.oauth.clientId) || '–' })}</p>}
            <div className="row-tight">
              <Btn className="xs" icon={ShieldCheck} onClick={() => showCert('imap')}>Certificate (incoming)</Btn>
              {a.smtp && <Btn className="xs" icon={ShieldCheck} onClick={() => showCert('smtp')}>Certificate (outgoing)</Btn>}
              {(a.imap.trusted || (a.smtp && a.smtp.trusted)) && <Btn className="xs ghost" onClick={async () => { await del(`${BASE}/accounts/${a.id}/trust?kind=${a.imap.trusted ? 'imap' : 'smtp'}`); toast.success(t('Trust withdrawn')); onChanged(); }}>Withdraw trust</Btn>}
              <Btn className="xs ghost" icon={RefreshCw} onClick={async () => { await post(`${BASE}/accounts/${a.id}/reconnect`); toast.success(t('Connecting again …')); }}>Connect again</Btn>
            </div>
          </div>
        </details>
      </div>
      {cert && (cert.reason
        ? <CertDialog cert={cert} onClose={() => setCert(null)} onTrust={async (fp) => { await post(`${BASE}/accounts/${a.id}/trust`, { kind: cert.kind, fingerprint256: fp }); toast.success(t('Certificate trusted')); onChanged(); }} />
        : <Modal title="Certificate" subtitle={`${cert.host}:${cert.port}`} onClose={() => setCert(null)} footer={<Btn onClick={() => setCert(null)}>Close</Btn>}>
          <dl className="ma-cert"><dt>Issued to</dt><dd>{cert.subject}</dd><dt>Issued by</dt><dd>{cert.issuer}</dd><dt>Valid</dt><dd>{fullDate(cert.validFrom)} – {fullDate(cert.validTo)}</dd><dt>SHA-256</dt><dd className="mono ma-fp">{cert.fingerprint256}</dd></dl>
          <p className="small"><ShieldCheck size={14} aria-hidden="true" /> {t('The certificate is valid.')}</p>
        </Modal>)}
    </Modal>
  );
}

export { Mail };
