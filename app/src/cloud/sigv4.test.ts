import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SignatureV4 } from '@smithy/signature-v4';
import { amzDate, presignIotWebSocket, sha256Hex, signCanonicalRequest } from './sigv4';

class NodeSha256 {
  private h;
  constructor(secret?: string | Uint8Array) { this.h = secret ? createHmac('sha256', secret) : createHash('sha256'); }
  update(d: string | Uint8Array) { this.h.update(d); }
  async digest() { return new Uint8Array(this.h.digest()); }
  reset() { /* single use */ }
}

describe('SigV4', () => {
  it('matches the AWS test-suite vector (get-vanilla)', async () => {
    const canonical = ['GET', '/', '', 'host:example.amazonaws.com', 'x-amz-date:20150830T123600Z', '', 'host;x-amz-date', await sha256Hex('')].join('\n');
    expect(await signCanonicalRequest('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830T123600Z', 'us-east-1', 'service', canonical))
      .toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('gives the same signature as the AWS SDK signer for the same request', async () => {
    const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
    const date = new Date(Date.UTC(2026, 9, 20, 8, 15, 30));
    const signer = new SignatureV4({ service: 'iotdevicegateway', region: 'ap-south-1', credentials: creds, sha256: NodeSha256 as never, applyChecksum: false });
    const req = await signer.sign({ method: 'GET', protocol: 'https:', hostname: 'abc-ats.iot.ap-south-1.amazonaws.com', path: '/mqtt', headers: { host: 'abc-ats.iot.ap-south-1.amazonaws.com' }, query: {} }, { signingDate: date });
    const sdkSig = /Signature=([0-9a-f]{64})/.exec(req.headers.authorization as string)![1];
    const amz = amzDate(date);
    const canonical = ['GET', '/mqtt', '', 'host:abc-ats.iot.ap-south-1.amazonaws.com', `x-amz-date:${amz}`, '', 'host;x-amz-date', await sha256Hex('')].join('\n');
    expect(await signCanonicalRequest(creds.secretAccessKey, amz, 'ap-south-1', 'iotdevicegateway', canonical)).toBe(sdkSig);
  });

  it('formats dates the AWS way', () => { expect(amzDate(new Date(Date.UTC(2015, 7, 30, 12, 36, 0, 123)))).toBe('20150830T123600Z'); });

  it('builds the IoT WebSocket URL: signed query first, session token appended after the signature', async () => {
    const url = new URL(await presignIotWebSocket('abc-ats.iot.ap-south-1.amazonaws.com', 'ap-south-1', { accessKeyId: 'AKIDEXAMPLE', secretKey: 'secret', sessionToken: 'tok/en+1=' }, new Date(Date.UTC(2026, 9, 20, 8, 0, 0))));
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/mqtt');
    expect([...url.searchParams.keys()]).toEqual(['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-SignedHeaders', 'X-Amz-Signature', 'X-Amz-Security-Token']);
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20261020/ap-south-1/iotdevicegateway/aws4_request');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261020T080000Z');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('tok/en+1=');
    expect(url.search).toContain('X-Amz-Credential=AKIDEXAMPLE%2F20261020%2Fap-south-1');
  });

  it('signs the canonical request the URL describes (a verifier recomputes the same signature)', async () => {
    const endpoint = 'abc-ats.iot.ap-south-1.amazonaws.com';
    const now = new Date(Date.UTC(2026, 9, 20, 8, 0, 0));
    const url = new URL(await presignIotWebSocket(endpoint, 'ap-south-1', { accessKeyId: 'AK', secretKey: 'sk' }, now));
    const query = [...url.searchParams.entries()].filter(([k]) => k !== 'X-Amz-Signature').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const canonical = ['GET', '/mqtt', query, `host:${endpoint}`, '', 'host', await sha256Hex('')].join('\n');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(await signCanonicalRequest('sk', amzDate(now), 'ap-south-1', 'iotdevicegateway', canonical));
  });
});
