const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface RuntimeConfig {
  host: string;
  port: number;
  databasePath: string;
  magpieBaseUrl: string;
  magpieAppKey?: string;
  defaultModel: string;
}

const LOOPBACK_URL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const host = env.CONCHBASE_HOST ?? '127.0.0.1';
  const portValue = env.CONCHBASE_PORT ?? '4318';
  const port = Number(portValue);

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('This runtime only supports loopback binding until API authentication is implemented.');
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
  const defaultModel = env.CONCHBASE_MODEL ?? '';
  const databasePath = env.CONCHBASE_DB ?? '.conchbase/runtime.sqlite';

  return {
    host,
    port,
    databasePath,
    magpieBaseUrl,
    ...(magpieAppKey ? { magpieAppKey } : {}),
    defaultModel,
  };
}
