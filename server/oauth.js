'use strict';
/*
 * Anmeldung per OAuth 2.0 (XOAUTH2 für IMAP und SMTP) – Autorisierungscode mit PKCE, Rücksprung zu Hostwerk.
 *
 * Ehrlich: Google und Microsoft geben OAuth nur an registrierte Apps. Eine fest eingebaute App-ID von Hostwerk müsste
 * dauernd gepflegt (Prüfung bei Google, Verifizierung, Fristen) und könnte jederzeit gesperrt werden – genau die Wartung,
 * die diese Erweiterung vermeiden soll. Deshalb trägst du (einmal) eine EIGENE App-ID ein; Endpunkte und Rechte (scope)
 * kommen aus Mozillas ISPDB bzw. der OpenID-Beschreibung des Anbieters, nicht aus einer eigenen Liste.
 * Alternative ohne OAuth: App-Passwort (Google, Yahoo, iCloud, GMX/web.de mit 2FA …).
 */
const crypto = require('crypto');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class OAuth {
  /** deps: { fetch, now } */
  constructor(deps = {}) {
    this.fetch = deps.fetch || globalThis.fetch;
    this.now = deps.now || (() => Date.now());
    this.pending = new Map(); // state → { verifier, cfg, at, result }
  }

  /** Anmelde-Adresse bauen. cfg: { clientId, clientSecret?, authURL, tokenURL, scope, redirectUri, email } */
  start(cfg) {
    for (const k of ['clientId', 'authURL', 'tokenURL', 'scope', 'redirectUri']) if (!cfg[k]) throw Object.assign(new Error(`OAuth: “${k}” is missing.`), { status: 400 });
    if (!/^https:\/\//.test(cfg.authURL) || !/^https:\/\//.test(cfg.tokenURL)) throw Object.assign(new Error('OAuth addresses must start with https://.'), { status: 400 });
    // Alte, nie abgeschlossene Versuche nach 15 Minuten vergessen
    for (const [k, v] of this.pending) if (this.now() - v.at > 15 * 60 * 1000) this.pending.delete(k);
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    this.pending.set(state, { verifier, cfg, at: this.now(), result: null });
    const u = new URL(cfg.authURL);
    const p = { response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: cfg.scope, state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' };
    if (cfg.email) p.login_hint = cfg.email;
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
    return { url: u.toString(), state };
  }

  async tokenRequest(tokenURL, params) {
    const body = new URLSearchParams(params).toString();
    const r = await this.fetch(tokenURL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    let j = {};
    try { j = await r.json(); } catch { /* leer */ }
    if (!r.ok || !j.access_token) throw Object.assign(new Error(`OAuth: ${j.error_description || j.error || `HTTP ${r.status}`}`), { status: 401, code: 'auth' });
    return j;
  }

  /** Rücksprung: { state, code, error } → Token. Ergebnis bleibt unter state abrufbar (die Oberfläche fragt nach). */
  async callback({ state, code, error, error_description: desc }) {
    const p = this.pending.get(String(state || ''));
    if (!p) throw Object.assign(new Error('This sign-in link has expired – start again in Hostwerk.'), { status: 400 });
    if (error) { p.result = { ok: false, error: String(desc || error).slice(0, 300) }; return p.result; }
    const { cfg } = p;
    try {
      const j = await this.tokenRequest(cfg.tokenURL, { grant_type: 'authorization_code', code: String(code || ''), redirect_uri: cfg.redirectUri, client_id: cfg.clientId, code_verifier: p.verifier, ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}) });
      if (!j.refresh_token) throw new Error('The provider sent no refresh token (offline access missing in the scope?).');
      p.result = { ok: true, tokens: { accessToken: j.access_token, refreshToken: j.refresh_token, expires: this.now() + (Number(j.expires_in) || 3600) * 1000 } };
    } catch (e) { p.result = { ok: false, error: e.message }; }
    return p.result;
  }
  /** Ergebnis abholen (einmalig) */
  take(state) {
    const p = this.pending.get(String(state || ''));
    if (!p || !p.result) return null;
    this.pending.delete(String(state));
    return { ...p.result, cfg: p.cfg };
  }

  /** Frisches Zugangs-Token. o: { clientId, clientSecret?, tokenURL, scope, refreshToken, accessToken?, expires? } → { accessToken, expires, refreshToken } */
  async refresh(o) {
    if (o.accessToken && o.expires && o.expires - this.now() > 120000) return { accessToken: o.accessToken, expires: o.expires, refreshToken: o.refreshToken, changed: false };
    const j = await this.tokenRequest(o.tokenURL, { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId, ...(o.clientSecret ? { client_secret: o.clientSecret } : {}) });
    return { accessToken: j.access_token, expires: this.now() + (Number(j.expires_in) || 3600) * 1000, refreshToken: j.refresh_token || o.refreshToken, changed: true };
  }
}

/** SASL-XOAUTH2-Zeichenkette (für Tests und SMTP-Prüfung) */
const xoauth2 = (user, token) => Buffer.from(`user=${user}\x01auth=Bearer ${token}\x01\x01`).toString('base64');

module.exports = { OAuth, xoauth2 };
