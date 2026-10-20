// Cloud setup: which AWS stack the app talks to. Nothing here is secret (pool ids, a public client id, URLs);
// it is produced by `node tools/aws/app-link.mjs` after a deployment and entered once as a link or code.
//
// A setup link comes from outside the app, so it is validated strictly: every host must be an AWS host for the
// stated region, unless it is a local test server on this computer. A crafted link therefore cannot point the
// sign-in at somebody else's server.

export interface CloudConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Cognito domain host, e.g. tremor-123456789012.auth.ap-south-1.amazoncognito.com */
  domain: string;
  identityPoolId: string;
  /** HTTP API base URL */
  apiUrl: string;
  /** IoT Core data endpoint (ATS) host */
  iotEndpoint: string;
  /** Local test backend only (tools/cloudmock): replace the AWS URLs. Ignored unless the host is localhost. */
  authBase?: string;
  identityBase?: string;
  mqttUrl?: string;
}

export const CONFIG_KEY = 'htm.cloud.config.v1';

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const isLocal = (u: string) => { try { const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'; } catch { return false; } };

export function validateConfig(x: unknown): { ok: true; config: CloudConfig } | { ok: false; error: string } {
  if (typeof x !== 'object' || x === null) return { ok: false, error: 'The setup is not valid JSON.' };
  const o = x as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const region = s('region');
  if (!REGION.test(region)) return { ok: false, error: 'region is missing or malformed.' };
  const userPoolId = s('userPoolId');
  if (!new RegExp(`^${region}_[A-Za-z0-9]+$`).test(userPoolId)) return { ok: false, error: 'userPoolId does not match the region.' };
  const clientId = s('clientId');
  if (!/^[a-z0-9]{10,40}$/.test(clientId)) return { ok: false, error: 'clientId is malformed.' };
  const identityPoolId = s('identityPoolId');
  if (!new RegExp(`^${region}:[0-9a-f-]{36}$`).test(identityPoolId)) return { ok: false, error: 'identityPoolId does not match the region.' };

  const local = ['authBase', 'identityBase', 'mqttUrl'].filter((k) => s(k));
  for (const k of local) if (!isLocal(s(k))) return { ok: false, error: `${k} is only accepted for a server on this computer (localhost).` };
  const testing = local.length > 0;

  const domain = s('domain');
  const apiUrl = s('apiUrl').replace(/\/+$/, '');
  const iotEndpoint = s('iotEndpoint');
  if (!testing || s('authBase') === '') if (!/^[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(domain)) return { ok: false, error: 'domain must be a Cognito domain (…amazoncognito.com).' };
  try {
    const u = new URL(apiUrl);
    const awsApi = u.protocol === 'https:' && new RegExp(`^[a-z0-9]+\\.execute-api\\.${region}\\.amazonaws\\.com$`).test(u.hostname);
    if (!awsApi && !(testing && isLocal(apiUrl))) return { ok: false, error: `apiUrl must be an API Gateway address in ${region}.` };
  } catch { return { ok: false, error: 'apiUrl is not a URL.' }; }
  if (!testing || s('mqttUrl') === '') if (!new RegExp(`^[a-z0-9]+-ats\\.iot\\.${region}\\.amazonaws\\.com$`).test(iotEndpoint)) return { ok: false, error: `iotEndpoint must be an IoT Core endpoint in ${region}.` };

  const config: CloudConfig = { region, userPoolId, clientId, domain, identityPoolId, apiUrl, iotEndpoint };
  for (const k of local) (config as unknown as Record<string, string>)[k] = s(k);
  return { ok: true, config };
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** A setup code for a link or a message: base64url of the JSON. */
export const encodeConfig = (c: CloudConfig) => b64url(new TextEncoder().encode(JSON.stringify(c)));

/** Accepts a whole link, `cfg=…`, a bare code, or raw JSON. */
export function parseSetup(text: string): { ok: true; config: CloudConfig } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: false, error: 'Paste the setup link or code first.' };
  try {
    if (t.startsWith('{')) return validateConfig(JSON.parse(t));
    const m = /(?:^|[?&#])cfg=([A-Za-z0-9_-]+)/.exec(t) ?? /^([A-Za-z0-9_-]{40,})$/.exec(t);
    if (!m) return { ok: false, error: 'No setup code found in that text.' };
    return validateConfig(JSON.parse(new TextDecoder().decode(unb64url(m[1]))));
  } catch { return { ok: false, error: 'The setup code could not be read. Copy the whole link.' }; }
}

export function loadConfig(storage: Pick<Storage, 'getItem'> | null = safeStorage()): CloudConfig | null {
  try {
    const raw = storage?.getItem(CONFIG_KEY);
    if (!raw) return null;
    const v = validateConfig(JSON.parse(raw));
    return v.ok ? v.config : null;
  } catch { return null; }
}
export function saveConfig(c: CloudConfig, storage: Pick<Storage, 'setItem'> | null = safeStorage()) { try { storage?.setItem(CONFIG_KEY, JSON.stringify(c)); } catch { /* storage blocked */ } }
export function clearConfig(storage: Pick<Storage, 'removeItem'> | null = safeStorage()) { try { storage?.removeItem(CONFIG_KEY); } catch { /* ignore */ } }

export function safeStorage(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }
