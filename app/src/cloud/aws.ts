// Small AWS clients written with fetch (the SDK would triple the bundle): Cognito identity credentials for the
// live MQTT view, and the app's own HTTP API.
import type { CloudConfig } from './config';
import type { Credentials } from './sigv4';

type F = typeof fetch;
const doFetch: F = (...a) => fetch(...a);

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const loginKey = (cfg: CloudConfig) => `cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
const identityUrl = (cfg: CloudConfig) => (cfg.identityBase ?? `https://cognito-identity.${cfg.region}.amazonaws.com`).replace(/\/+$/, '') + '/';

async function identityCall<T>(cfg: CloudConfig, target: string, body: unknown, f: F): Promise<T> {
  const r = await f(identityUrl(cfg), { method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityService.${target}` }, body: JSON.stringify(body) });
  if (!r.ok) throw new ApiError(r.status, `Cognito ${target} failed (${r.status})`);
  return (await r.json()) as T;
}

/** The identity id of this user in the identity pool (the owner prefix of every MQTT topic). */
export async function getIdentityId(cfg: CloudConfig, idToken: string, f: F = doFetch): Promise<string> {
  const r = await identityCall<{ IdentityId: string }>(cfg, 'GetId', { IdentityPoolId: cfg.identityPoolId, Logins: { [loginKey(cfg)]: idToken } }, f);
  return r.IdentityId;
}

/** Temporary AWS credentials (about an hour) limited by the identity pool's role to this user's own topics. */
export async function getCredentials(cfg: CloudConfig, idToken: string, identityId: string, f: F = doFetch): Promise<{ creds: Credentials; expiresAt: number }> {
  const r = await identityCall<{ Credentials: { AccessKeyId: string; SecretKey: string; SessionToken: string; Expiration: number } }>(cfg, 'GetCredentialsForIdentity', { IdentityId: identityId, Logins: { [loginKey(cfg)]: idToken } }, f);
  const c = r.Credentials;
  return { creds: { accessKeyId: c.AccessKeyId, secretKey: c.SecretKey, sessionToken: c.SessionToken }, expiresAt: c.Expiration * 1000 };
}

/** The app's HTTP API. Every call carries the user's ID token. */
export class Api {
  constructor(private readonly cfg: CloudConfig, private readonly token: () => Promise<string | null>, private readonly f: F = doFetch) {}

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const t = await this.token();
    if (!t) throw new ApiError(401, 'Sign in first.');
    const r = await this.f(this.cfg.apiUrl + path, { method, headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let j: unknown = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!r.ok) throw new ApiError(r.status, (j as { error?: string }).error ?? `The cloud answered ${r.status}.`);
    return j as T;
  }

  me() { return this.request<{ sub: string; email: string | null; identityId: string | null; devices: DeviceRow[] }>('GET', '/v1/me'); }
  link(identityId: string) { return this.request<{ identityId: string }>('POST', '/v1/me/link', { identityId }); }
  days(from: string, to: string) { return this.request<{ days: DayRow[] }>('GET', `/v1/days?from=${from}&to=${to}`); }
  events(from: number, to: number) { return this.request<{ events: CloudEventRow[] }>('GET', `/v1/events?from=${from}&to=${to}`); }
  telemetry(thing: string, from: number, to: number) { return this.request<{ telemetry: Record<string, unknown>[] }>('GET', `/v1/telemetry?thing=${encodeURIComponent(thing)}&from=${from}&to=${to}`); }
  syncPut(records: Record<string, unknown[]>) { return this.request<{ stored: number }>('PUT', '/v1/sync', records); }
  syncGet<K extends string>(kind: K, since = 0) { return this.request<Record<K, Record<string, unknown>[]>>('GET', `/v1/sync?kind=${kind}&since=${since}`); }
  // sharing with a doctor (patient side)
  makeShareCode(name: string) { return this.request<{ code: string; expiresAt: number }>('POST', '/v1/share', { name }); }
  shares() { return this.request<{ doctors: ShareRow[] }>('GET', '/v1/share'); }
  revokeShare(doctor: string) { return this.request<{ removed: boolean }>('DELETE', `/v1/share?doctor=${encodeURIComponent(doctor)}`); }
  // doctor side (needs the "doctors" group; each patient needs the patient's consent)
  addPatient(code: string) { return this.request<{ patientId: string; label: string }>('POST', '/v1/doctor/patients', { code }); }
  patients() { return this.request<{ patients: PatientRow[] }>('GET', '/v1/doctor/patients'); }
  patient(id: string, days = 30) { return this.request<PatientDetail>('GET', `/v1/doctor/patient?id=${encodeURIComponent(id)}&days=${days}`); }
  removePatient(id: string) { return this.request<{ removed: boolean }>('DELETE', `/v1/doctor/patients?id=${encodeURIComponent(id)}`); }
  deleteMe(account: boolean) { return this.request<{ deleted: number; account: boolean }>('DELETE', `/v1/me${account ? '?account=true' : ''}`); }
}

export interface DeviceRow { thing?: string; online?: boolean; lastSeen?: number; fw?: string; tzMin?: number; rate?: number; sk?: string }
export interface DayRow { day: string; score?: number | null; episodes?: number; falls?: number; monitoredS?: number; tremorS?: number; restingBpm?: number | null; restingSpo2?: number | null; maxEpisodeScore?: number | null }
export interface CloudEventRow { ts: number; type: string; thing?: string; ep?: { start: number; end: number; durationS: number; axes: number[]; pattern: string; ampDps: number; freqHz: number; score: number; bpm: number | null }; fall?: { t: number; path: string; peakG: number; outcome: string }; level?: number; ax?: number; f?: number }

export interface ShareRow { doctor: string; email: string | null; since: number }
export interface PatientDay { day: string; score: number | null; episodes: number; falls: number; monitoredS: number; restingBpm: number | null; restingSpo2: number | null }
export interface PatientRow { id: string; label: string; since: number; devices: DeviceRow[]; days: PatientDay[]; falls7: number; lastFallTs: number | null }
/** An episode the patient's app uploaded (Sync): the same fields as the app's own Episode record. */
export interface SyncedEpisode { id: string; start: number; end?: number; durationS: number; freqHz?: number; ampDps?: number; peakAmpDps?: number; score?: number; axes?: number[]; pattern?: string; bpm?: number | null; walkingFrac?: number }
export interface SyncedVital { id: string; t: number; bpm: number; spo2: number | null; quality?: string }
export interface PatientDetail { id: string; label: string; since: number; devices: DeviceRow[]; days: DayRow[]; events: CloudEventRow[]; episodes: SyncedEpisode[]; vitals: SyncedVital[] }
