// The app's cloud setup, as the link / code the Cloud screen takes (app/src/cloud/config.ts reads and validates it).
// Nothing in it is secret: pool ids, the public app-client id, URLs.
export function setupConfig(out, region, iotEndpoint) {
  return {
    region,
    userPoolId: out.UserPoolId,
    clientId: out.UserPoolClientId,
    domain: out.CognitoDomain,
    identityPoolId: out.IdentityPoolId,
    apiUrl: String(out.ApiUrl).replace(/\/+$/, ''),
    iotEndpoint,
  };
}

export function setupCode(cfg) {
  return Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64url');
}

/** appUrl: where the app is served (https://user.github.io/head-tremor/ or the CloudFront address). */
export function setupLink(appUrl, cfg) {
  const base = String(appUrl).replace(/#.*$/, '').replace(/\/?$/, '/');
  return `${base}#/cloud?cfg=${setupCode(cfg)}`;
}
