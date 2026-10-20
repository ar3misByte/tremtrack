import { describe, expect, it } from 'vitest';
import { setupCode, setupConfig, setupLink } from '../../../tools/aws/setup-code.mjs';
import { parseSetup } from './config';

// What `cdk deploy` prints (outputs.json) and what IoT Core answers, for a made-up account.
const outputs = {
  Region: 'ap-south-1', UserPoolId: 'ap-south-1_AbC123xyz', UserPoolClientId: 'abcdefghij1234567890klmnop', IdentityPoolId: 'ap-south-1:3f2c1a7e-0000-4000-8000-123456789abc',
  CognitoDomain: 'tremor-123456789012.auth.ap-south-1.amazoncognito.com', ApiUrl: 'https://abc123.execute-api.ap-south-1.amazonaws.com/',
};
const endpoint = 'a1b2c3d4e5f6g7-ats.iot.ap-south-1.amazonaws.com';

describe('the setup link tools/aws/app-link.mjs prints', () => {
  const cfg = setupConfig(outputs, 'ap-south-1', endpoint);

  it('is accepted by the app exactly as printed: as a link, a code, or JSON', () => {
    for (const text of [setupLink('https://user.github.io/head-tremor', cfg), setupCode(cfg), JSON.stringify(cfg)]) {
      const r = parseSetup(text);
      expect(r.ok, text.slice(0, 60)).toBe(true);
      if (r.ok) expect(r.config).toEqual({ ...cfg });
    }
  });

  it('drops the trailing slash of the API address and builds a link with the app path kept', () => {
    expect(cfg.apiUrl).toBe('https://abc123.execute-api.ap-south-1.amazonaws.com');
    expect(setupLink('https://user.github.io/head-tremor', cfg)).toMatch(/^https:\/\/user\.github\.io\/head-tremor\/#\/cloud\?cfg=[A-Za-z0-9_-]+$/);
    expect(setupLink('https://user.github.io/head-tremor/#/live', cfg)).toMatch(/^https:\/\/user\.github\.io\/head-tremor\/#\/cloud\?cfg=/);
  });
});
