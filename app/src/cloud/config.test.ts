import { describe, expect, it } from 'vitest';
import { encodeConfig, loadConfig, parseSetup, saveConfig, validateConfig, CONFIG_KEY, type CloudConfig } from './config';

const good: CloudConfig = {
  region: 'ap-south-1', userPoolId: 'ap-south-1_AbC123xyz', clientId: 'abcdefghij1234567890klmnop',
  domain: 'tremor-123456789012.auth.ap-south-1.amazoncognito.com', identityPoolId: 'ap-south-1:3f2c1a7e-0000-4000-8000-123456789abc',
  apiUrl: 'https://abc123.execute-api.ap-south-1.amazonaws.com', iotEndpoint: 'a1b2c3d4e5f6g7-ats.iot.ap-south-1.amazonaws.com',
};

describe('cloud setup validation', () => {
  it('accepts a real-looking AWS setup', () => { expect(validateConfig(good)).toEqual({ ok: true, config: good }); });

  it('refuses hosts that are not AWS hosts for that region (a crafted link cannot redirect the sign-in)', () => {
    const bad = (patch: Partial<CloudConfig>) => validateConfig({ ...good, ...patch });
    expect(bad({ domain: 'evil.example.com' }).ok).toBe(false);
    expect(bad({ domain: 'x.auth.ap-south-1.amazoncognito.com.evil.com' }).ok).toBe(false);
    expect(bad({ apiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com' }).ok).toBe(false);
    expect(bad({ apiUrl: 'http://abc123.execute-api.ap-south-1.amazonaws.com' }).ok).toBe(false);
    expect(bad({ apiUrl: 'https://evil.example.com' }).ok).toBe(false);
    expect(bad({ iotEndpoint: 'evil.example.com' }).ok).toBe(false);
    expect(bad({ userPoolId: 'us-east-1_AbC123xyz' }).ok).toBe(false);
    expect(bad({ identityPoolId: 'us-east-1:3f2c1a7e-0000-4000-8000-123456789abc' }).ok).toBe(false);
    expect(bad({ authBase: 'https://evil.example.com' }).ok).toBe(false);
    expect(bad({ mqttUrl: 'wss://evil.example.com/mqtt' }).ok).toBe(false);
  });

  it('allows a local test backend only on localhost', () => {
    const local = validateConfig({ ...good, authBase: 'http://localhost:8801', identityBase: 'http://localhost:8801', mqttUrl: 'ws://localhost:8802/mqtt', apiUrl: 'http://localhost:8801', domain: 'x', iotEndpoint: 'x' });
    expect(local.ok).toBe(true);
  });

  it('reads a link, a bare code and raw JSON', () => {
    const code = encodeConfig(good);
    expect(parseSetup(`https://user.github.io/head-tremor/#/cloud?cfg=${code}`)).toEqual({ ok: true, config: good });
    expect(parseSetup(`cfg=${code}`)).toEqual({ ok: true, config: good });
    expect(parseSetup(code)).toEqual({ ok: true, config: good });
    expect(parseSetup(JSON.stringify(good))).toEqual({ ok: true, config: good });
    expect(parseSetup('').ok).toBe(false);
    expect(parseSetup('hello').ok).toBe(false);
    expect(parseSetup('cfg=AAAA').ok).toBe(false);
  });

  it('keeps and reloads the setup, ignoring a damaged entry', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadConfig(store)).toBeNull();
    saveConfig(good, store);
    expect(loadConfig(store)).toEqual(good);
    mem.set(CONFIG_KEY, '{"region":"x"}');
    expect(loadConfig(store)).toBeNull();
    mem.set(CONFIG_KEY, 'not json');
    expect(loadConfig(store)).toBeNull();
  });
});
