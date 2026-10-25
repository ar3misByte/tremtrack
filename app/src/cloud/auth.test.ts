import { describe, expect, it } from 'vitest';
import { Auth, decodeJwt, PKCE_KEY, TOKENS_KEY, type KV } from './auth';
import type { CloudConfig } from './config';

const cfg: CloudConfig = {
  region: 'ap-south-1', userPoolId: 'ap-south-1_AbC123xyz', clientId: 'abcdefghij1234567890klmnop',
  domain: 'tremor-123456789012.auth.ap-south-1.amazoncognito.com', identityPoolId: 'ap-south-1:3f2c1a7e-0000-4000-8000-123456789abc',
  apiUrl: 'https://abc123.execute-api.ap-south-1.amazonaws.com', iotEndpoint: 'a1b2c3d4e5f6g7-ats.iot.ap-south-1.amazonaws.com',
};
const mem = (): KV & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;

function setup(responses: ((url: string, init: RequestInit) => { status?: number; body: unknown })[], t0 = 1_800_000_000_000) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  let i = 0;
  const clock = { t: t0 };
  const storage = mem(), session = mem();
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    const r = responses[Math.min(i++, responses.length - 1)](url, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
  const auth = new Auth(cfg, { redirectUri: 'https://app.example/', fetch: fetchFn, storage, session, now: () => clock.t, random: (n) => Uint8Array.from({ length: n }, (_, k) => (k * 7 + 3) % 256) });
  return { auth, calls, storage, session, clock };
}

describe('sign-in (hosted UI, PKCE)', () => {
  it('builds the authorize URL with a S256 challenge and remembers verifier and state', async () => {
    const { auth, session } = setup([]);
    const url = new URL(await auth.loginUrl());
    expect(url.origin + url.pathname).toBe(`https://${cfg.domain}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: cfg.clientId, redirect_uri: 'https://app.example/', scope: 'openid email profile', code_challenge_method: 'S256' });
    const { verifier, state } = JSON.parse(session.m.get(PKCE_KEY)!);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(url.searchParams.get('state')).toBe(state);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    expect(url.searchParams.get('code_challenge')).toBe(btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  });

  it('exchanges the code once, with the verifier, and stores the tokens', async () => {
    const id = jwt({ sub: 's-1', email: 'me@example.com', exp: 1_800_003_600 });
    const { auth, calls, storage, session } = setup([() => ({ body: { id_token: id, access_token: 'acc', refresh_token: 'ref', expires_in: 3600 } })]);
    const url = new URL(await auth.loginUrl());
    const state = url.searchParams.get('state')!;
    const verifier = JSON.parse(session.m.get(PKCE_KEY)!).verifier;
    const r = await auth.completeLogin(`https://app.example/?code=abc&state=${state}`);
    expect(r).toEqual({ ok: true });
    expect(calls[0].url).toBe(`https://${cfg.domain}/oauth2/token`);
    expect(Object.fromEntries(calls[0].body)).toEqual({ grant_type: 'authorization_code', client_id: cfg.clientId, code: 'abc', redirect_uri: 'https://app.example/', code_verifier: verifier });
    expect(JSON.parse(storage.m.get(TOKENS_KEY)!)).toMatchObject({ idToken: id, accessToken: 'acc', refreshToken: 'ref', expiresAt: 1_800_003_600_000 });
    expect(session.m.has(PKCE_KEY)).toBe(false);
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.claims()).toEqual({ sub: 's-1', email: 'me@example.com', exp: 1_800_003_600, groups: [] });
    expect(await auth.completeLogin(`https://app.example/?code=abc&state=${state}`)).toMatchObject({ ok: false });   // the verifier is single use
  });

  it('rejects a wrong state, an error answer, and URLs without a result', async () => {
    const { auth } = setup([() => ({ body: {} })]);
    await auth.loginUrl();
    expect(await auth.completeLogin('https://app.example/?code=abc&state=forged')).toMatchObject({ ok: false });
    expect(await auth.completeLogin('https://app.example/?error=access_denied&error_description=User+cancelled')).toEqual({ ok: false, error: 'User cancelled' });
    expect(await auth.completeLogin('https://app.example/#/live')).toBeNull();
  });

  it('refreshes an expiring token once, even for concurrent callers, and keeps the refresh token', async () => {
    const old = jwt({ sub: 's', exp: 1_800_000_030 }), fresh = jwt({ sub: 's', email: 'me@example.com', exp: 1_800_007_200 });
    const { auth, calls, storage } = setup([() => ({ body: { id_token: fresh, access_token: 'acc2', expires_in: 3600 } })]);
    storage.setItem(TOKENS_KEY, JSON.stringify({ idToken: old, accessToken: 'acc', refreshToken: 'ref', expiresAt: 1_800_000_030_000 }));
    const [a, b] = await Promise.all([auth.idToken(), auth.idToken()]);
    expect(a).toBe(fresh); expect(b).toBe(fresh);
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0].body)).toEqual({ grant_type: 'refresh_token', client_id: cfg.clientId, refresh_token: 'ref' });
    expect(auth.tokens()!.refreshToken).toBe('ref');
  });

  it('signs out when the refresh is refused or the browser is offline', async () => {
    const old = jwt({ sub: 's', exp: 1_800_000_030 });
    const s1 = setup([() => ({ status: 400, body: { error: 'invalid_grant' } })]);
    s1.storage.setItem(TOKENS_KEY, JSON.stringify({ idToken: old, accessToken: 'a', refreshToken: 'ref', expiresAt: 1_800_000_030_000 }));
    expect(await s1.auth.idToken()).toBeNull();
    expect(s1.auth.isSignedIn()).toBe(false);
    const s2 = setup([() => { throw new Error('offline'); }]);
    s2.storage.setItem(TOKENS_KEY, JSON.stringify({ idToken: old, accessToken: 'a', refreshToken: 'ref', expiresAt: 1_800_000_030_000 }));
    expect(await s2.auth.idToken()).toBeNull();
  });

  it('returns a still-valid token without calling the network, and signs out for good', async () => {
    const ok = jwt({ sub: 's', exp: 1_800_003_600 });
    const { auth, calls, storage } = setup([]);
    storage.setItem(TOKENS_KEY, JSON.stringify({ idToken: ok, accessToken: 'a', refreshToken: 'r', expiresAt: 1_800_003_600_000 }));
    expect(await auth.idToken()).toBe(ok);
    expect(calls).toHaveLength(0);
    auth.signOut();
    expect(auth.tokens()).toBeNull();
    expect(await auth.idToken()).toBeNull();
  });

  it('decodes JWT payloads and survives garbage', () => {
    expect(decodeJwt(jwt({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeJwt('nonsense')).toBeNull();
  });
});
