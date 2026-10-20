export interface SetupConfig { region: string; userPoolId: string; clientId: string; domain: string; identityPoolId: string; apiUrl: string; iotEndpoint: string }
export function setupConfig(out: Record<string, string>, region: string, iotEndpoint: string): SetupConfig;
export function setupCode(cfg: SetupConfig): string;
export function setupLink(appUrl: string, cfg: SetupConfig): string;
