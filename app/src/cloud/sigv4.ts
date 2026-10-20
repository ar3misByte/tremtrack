// AWS Signature Version 4 with WebCrypto, just enough to connect to AWS IoT Core over a signed WebSocket URL.
// (The AWS SDK would add far more code than this feature needs; the signing is verified against the SDK in sigv4.test.ts.)

export interface Credentials { accessKeyId: string; secretKey: string; sessionToken?: string }

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b instanceof Uint8Array ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function hmac(key: BufferSource, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
export async function sha256Hex(data: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', enc.encode(data))); }

/** 20150830T123600Z */
export const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

export async function signingKey(secretKey: string, date8: string, region: string, service: string): Promise<Uint8Array<ArrayBuffer>> {
  let k = await hmac(enc.encode('AWS4' + secretKey), date8);
  for (const part of [region, service, 'aws4_request']) k = await hmac(k, part);
  return k;
}

/** Signature (hex) of a canonical request, for the scope date/region/service. */
export async function signCanonicalRequest(secretKey: string, amz: string, region: string, service: string, canonicalRequest: string): Promise<string> {
  const date8 = amz.slice(0, 8);
  const scope = `${date8}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, await sha256Hex(canonicalRequest)].join('\n');
  return hex(await hmac(await signingKey(secretKey, date8, region, service), sts));
}

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * wss://<endpoint>/mqtt?... signed for AWS IoT Core. The session token is appended AFTER the signature
 * (IoT Core does not include it in the signed query string).
 */
export async function presignIotWebSocket(endpoint: string, region: string, creds: Credentials, now = new Date()): Promise<string> {
  const service = 'iotdevicegateway';
  const amz = amzDate(now);
  const date8 = amz.slice(0, 8);
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${creds.accessKeyId}/${date8}/${region}/${service}/aws4_request`],
    ['X-Amz-Date', amz],
    ['X-Amz-SignedHeaders', 'host'],
  ].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
  const canonical = ['GET', '/mqtt', query, `host:${endpoint}`, '', 'host', await sha256Hex('')].join('\n');
  const sig = await signCanonicalRequest(creds.secretKey, amz, region, service, canonical);
  return `wss://${endpoint}/mqtt?${query}&X-Amz-Signature=${sig}${creds.sessionToken ? `&X-Amz-Security-Token=${rfc3986(creds.sessionToken)}` : ''}`;
}
