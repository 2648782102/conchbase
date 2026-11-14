import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';

const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? '127.0.0.1';

function portInUse(hostname, portNumber) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port: portNumber });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

if (await portInUse(host, port)) {
  process.stderr.write(
    `Port ${host}:${port} is already in use. Stop the old runtime before starting this branch.\n`,
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli.ts', 'serve'],
  { stdio: 'inherit', env: { ...process.env, HOST: host, PORT: String(port) } },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
