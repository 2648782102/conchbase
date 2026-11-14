const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_URL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface RuntimeConfig {
  host: string;
  port: number;
  databasePath: string;
  magpieBaseUrl: string;
  magpieAppKey?: string;
  defaultModel: string;
  organizationIntentModel?: string;
  bossModel?: string;
  mcpConfigPath?: string;
  allowAuthenticatedRemoteBinding: boolean;
  authTokenDigest?: string;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const host = env.CONCHBASE_HOST ?? '127.0.0.1';
  const portValue = env.CONCHBASE_PORT ?? '4318';
  const port = Number(portValue);
  const allowAuthenticatedRemoteBinding = env.CONCHBASE_ALLOW_AUTHENTICATED_REMOTE_BINDING === '1';
  const authTokenDigest = env.CONCHBASE_AUTH_TOKEN_DIGEST;

  if (!LOOPBACK_HOSTS.has(host) && !allowAuthenticatedRemoteBinding) {
    throw new Error('This runtime only supports loopback binding until authenticated pairing is enabled.');
  }
  if (!LOOPBACK_HOSTS.has(host) && !authTokenDigest) {
    throw new Error('Authenticated remote binding requires CONCHBASE_AUTH_TOKEN_DIGEST.');
  }
  if (authTokenDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(authTokenDigest)) {
    throw new Error('CONCHBASE_AUTH_TOKEN_DIGEST must be sha256:<64 lowercase hex>.');
  }

  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CONCHBASE_PORT must be an integer between 1 and 65535.');
  }

  const magpieBaseUrl = env.CONCHBASE_MAGPIE_URL ?? 'http://127.0.0.1:3425';
  let parsedMagpieUrl: URL;
  try {
    parsedMagpieUrl = new URL(magpieBaseUrl);
  } catch {
    throw new Error('CONCHBASE_MAGPIE_URL must be a loopback HTTP URL.');
  }
  if (
    parsedMagpieUrl.protocol !== 'http:'
    || !LOOPBACK_URL_HOSTS.has(parsedMagpieUrl.hostname.replace(/^\[|\]$/g, ''))
    || parsedMagpieUrl.username !== ''
    || parsedMagpieUrl.password !== ''
  ) {
    throw new Error('CONCHBASE_MAGPIE_URL must be a loopback HTTP URL.');
  }

  const magpieAppKey = env.CONCHBASE_MAGPIE_APP_KEY;
  if (magpieAppKey !== undefined && !/^magpie-[a-zA-Z0-9_-]+$/.test(magpieAppKey)) {
    throw new Error('CONCHBASE_MAGPIE_APP_KEY has an invalid format.');
  }
  return {
    host,
    port,
    databasePath: env.CONCHBASE_DB ?? '.conchbase/runtime.sqlite',
    magpieBaseUrl,
    ...(magpieAppKey ? { magpieAppKey } : {}),
    defaultModel: env.CONCHBASE_MODEL ?? 'workbuddy/blind-model-h',
    ...(env.CONCHBASE_ORGANIZATION_INTENT_MODEL
      ? { organizationIntentModel: env.CONCHBASE_ORGANIZATION_INTENT_MODEL }
      : {}),
    ...(env.CONCHBASE_BOSS_MODEL ? { bossModel: env.CONCHBASE_BOSS_MODEL } : {}),
    ...(env.CONCHBASE_MCP_CONFIG ? { mcpConfigPath: env.CONCHBASE_MCP_CONFIG } : {}),
    allowAuthenticatedRemoteBinding,
    ...(authTokenDigest ? { authTokenDigest } : {}),
  };
}
