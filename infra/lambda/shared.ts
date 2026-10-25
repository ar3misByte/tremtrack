// Shared helpers for the Lambdas: single-table keys, the DynamoDB document client, local days.
// Table design: docs/DATA_MODEL.md ("Cloud: DynamoDB single table").
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const TABLE = process.env.TABLE ?? 'tremor-local';
export const DEFAULT_TZ_MIN = 330;          // India Standard Time, used until a device reports its offset

export const K = {
  user: (owner: string) => `U#${owner}`,              // everything that belongs to one user (owner = Cognito identity id)
  profile: (sub: string) => `P#${sub}`,               // user pool sub -> identity id link
  devices: 'DEVICES',                                  // registry of devices, for the hourly aggregator
  tel: (thing: string, ts: number) => `T#${thing}#${String(ts).padStart(13, '0')}`,
  telPrefix: (thing: string) => `T#${thing}#`,
  event: (ts: number, thing: string, seq: number) => `E#${String(ts).padStart(13, '0')}#${thing}#${seq}`,
  day: (d: string) => `DAY#${d}`,
  device: (thing: string) => `D#${thing}`,
  notify: (kind: string) => `N#${kind}`,
  share: (code: string) => `SHARE#${code}`,           // a one-time code a patient gives their doctor (sk 'CODE')
  doctor: (sub: string) => `DOC#${sub}`,              // a doctor's patients: sk PT#<owner>; the patient's side is U#owner / ACC#<doctor sub>
};

/** Kinds of records the app syncs (PUT /v1/sync), with their sort-key builders. */
export const SYNC_KINDS = {
  episodes: (r: { id: string; start: number }) => `EP#${pad(r.start)}#${r.id}`,
  sessions: (r: { id: string; start: number }) => `SE#${pad(r.start)}#${r.id}`,
  tags: (r: { id: string; t: number }) => `TG#${pad(r.t)}#${r.id}`,
  meds: (r: { id: string }) => `MD#${r.id}`,
  doses: (r: { id: string }) => `DS#${r.id}`,
  vitals: (r: { id: string; t: number }) => `RV#${pad(r.t)}#${r.id}`,
  falls: (r: { id: string; t: number }) => `FE#${pad(r.t)}#${r.id}`,
} as const;
export type SyncKind = keyof typeof SYNC_KINDS;
export const SYNC_PREFIX: Record<SyncKind, string> = { episodes: 'EP#', sessions: 'SE#', tags: 'TG#', meds: 'MD#', doses: 'DS#', vitals: 'RV#', falls: 'FE#' };
function pad(n: number) { return String(Math.round(n)).padStart(13, '0'); }

/** Local calendar day (YYYY-MM-DD) for a UTC timestamp and a fixed offset in minutes. */
export function localDay(ts: number, tzMin: number): string {
  return new Date(ts + tzMin * 60_000).toISOString().slice(0, 10);
}
/** UTC ms of local midnight starting `day` for the offset. */
export function dayStartUtc(day: string, tzMin: number): number {
  return Date.parse(day + 'T00:00:00Z') - tzMin * 60_000;
}

let client: DynamoDBDocumentClient | null = null;
export function ddb(): DynamoDBDocumentClient {
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return client;
}

export const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level, msg, ...extra }));
