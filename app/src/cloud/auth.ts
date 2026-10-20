// Sign-in with the Cognito hosted login page, authorization-code flow with PKCE (no client secret exists).
// The app is a static site: it redirects to the login page, receives `?code=…` back, and exchanges it for tokens.
//
// Tokens are kept in this browser's localStorage so the sign-in survives a restart (the refresh token lasts
// as long as the Cognito app client allows). Anyone who can run script on this origin could read them; the app
// loads no third-party scripts. "Sign out" deletes them. The hosted login page keeps its own cookie, so the next
// sign-in on this browser may not ask for the password again until that session expires.
import type { CloudConfig } from './config';

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export interface AuthDeps {
  redirectUri: string;
  fetch?: typeof fetch;
  storage?: KV;                 // tokens
  session?: KV;                 // PKCE verifier + state, for the length of one sign-in
  now?: () => number;
  random?: (n: number) => Uint8Array;
}
export interface Tokens { idToken: string; accessToken: string; refreshToken: string | null; expiresAt: number }
export interface Claims { sub: string; email: string | null; exp: number }

export const TOKENS_KEY = 'htm.cloud.tokens.v1';
export const PKCE_KEY = 'htm.cloud.pkce.v1';
const SKEW_MS = 60_000;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const p = token.split('.')[1];
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
  } catch { return null; }
}

const memory = (): KV => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const wrap = (s: Storage | undefined): KV => {
  if (!s) return memory();
  return {
    getItem: (k) => { try { return s.getItem(k); } catch { return null; } },
    setItem: (k, v) => { try { s.setItem(k, v); } catch { /* blocked */ } },
    removeItem: (k) => { try { s.removeItem(k); } catch { /* blocked */ } },
  };
};
export const browserStorage = (): KV => wrap(typeof localStorage === 'undefined' ? undefined : localStorage);
export const browserSession = (): KV => wrap(typeof sessionStorage === 'undefined' ? undefined : sessionStorage);

export class Auth {
  private f: typeof fetch;
  private store: KV;
  private session: KV;
  private now: () => number;
  private rnd: (n: number) => Uint8Array;
  private refreshing: Promise<Tokens | null> | null = null;

  constructor(readonly cfg: CloudConfig, private readonly d: AuthDeps) {
    this.f = d.fetch ?? ((...a) => fetch(...a));
    this.store = d.storage ?? browserStorage();
    this.session = d.session ?? browserSession();
    this.now = d.now ?? Date.now;
    this.rnd = d.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  }

  private base() { return (this.cfg.authBase ?? `https://${this.cfg.domain}`).replace(/\/+$/, ''); }

  /** Where to send the browser to sign in. Remembers the PKCE verifier and state for the return trip. */
  async loginUrl(): Promise<string> {
    const verifier = b64url(this.rnd(64));
    const state = b64url(this.rnd(16));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    this.session.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    const q = new URLSearchParams({ response_type: 'code', client_id: this.cfg.clientId, redirect_uri: this.d.redirectUri, scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256' });
    return `${this.base()}/oauth2/authorize?${q}`;
  }

  /** Handles the return from the login page. `null` = the URL carries no sign-in result. */
  async completeLogin(href: string): Promise<{ ok: true } | { ok: false; error: string } | null> {
    const q = new URL(href).searchParams;
    const err = q.get('error');
    if (err) { this.session.removeItem(PKCE_KEY); return { ok: false, error: q.get('error_description') ?? err }; }
    const code = q.get('code');
    if (!code) return null;
    let pk: { verifier: string; state: string } | null = null;
    try { pk = JSON.parse(this.session.getItem(PKCE_KEY) ?? 'null'); } catch { /* damaged */ }
    this.session.removeItem(PKCE_KEY);
    if (!pk || pk.state !== q.get('state')) return { ok: false, error: 'The sign-in answer did not match this browser session. Try signing in again.' };
    const t = await this.token({ grant_type: 'authorization_code', client_id: this.cfg.clientId, code, redirect_uri: this.d.redirectUri, code_verifier: pk.verifier });
    return t ? { ok: true } : { ok: false, error: 'The sign-in could not be completed. Try again.' };
  }

  private async token(body: Record<string, string>, keepRefresh: string | null = null): Promise<Tokens | null> {
    let r: Response;
    try { r = await this.f(`${this.base()}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }); }
    catch { return null; }
    if (!r.ok) return null;
    const j = (await r.json()) as { id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number };
    if (!j.id_token || !j.access_token) return null;
    const exp = (decodeJwt(j.id_token)?.exp as number | undefined) ?? 0;
    const t: Tokens = { idToken: j.id_token, accessToken: j.access_token, refreshToken: j.refresh_token ?? keepRefresh, expiresAt: exp ? exp * 1000 : this.now() + (j.expires_in ?? 3600) * 1000 };
    this.store.setItem(TOKENS_KEY, JSON.stringify(t));
    return t;
  }

  tokens(): Tokens | null { try { return JSON.parse(this.store.getItem(TOKENS_KEY) ?? 'null'); } catch { return null; } }
  isSignedIn() { const t = this.tokens(); return !!t && (!!t.refreshToken || t.expiresAt > this.now()); }

  claims(): Claims | null {
    const t = this.tokens();
    const c = t && decodeJwt(t.idToken);
    return c && typeof c.sub === 'string' ? { sub: c.sub, email: typeof c.email === 'string' ? c.email : null, exp: Number(c.exp) } : null;
  }

  /** A valid ID token (refreshing it when it is about to expire), or null when the user must sign in again. */
  async idToken(): Promise<string | null> {
    const t = this.tokens();
    if (!t) return null;
    if (t.expiresAt - this.now() > SKEW_MS) return t.idToken;
    if (!t.refreshToken) { this.signOut(); return null; }
    this.refreshing ??= this.token({ grant_type: 'refresh_token', client_id: this.cfg.clientId, refresh_token: t.refreshToken }, t.refreshToken).finally(() => { this.refreshing = null; });
    const n = await this.refreshing;
    if (!n) { this.signOut(); return null; }
    return n.idToken;
  }

  signOut() { this.store.removeItem(TOKENS_KEY); this.session.removeItem(PKCE_KEY); }
}
