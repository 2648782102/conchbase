const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface RuntimeConfig {
  host: string;
  port: number;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const host = env.CONCHBASE_HOST ?? '127.0.0.1';
  const portValue = env.CONCHBASE_PORT ?? '4318';
  const port = Number(portValue);

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('This scaffold only supports loopback binding until API authentication is implemented.');
  }

  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CONCHBASE_PORT must be an integer between 1 and 65535.');
  }

  return { host, port };
}
