import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';

// The CLI reads CONCHBASE_HOST / CONCHBASE_PORT. PORT and HOST stay supported
// as short aliases so a plain `PORT=4400 npm run dev` still binds where it says.
const port = Number(process.env.CONCHBASE_PORT ?? process.env.PORT ?? 4318);
const host = process.env.CONCHBASE_HOST ?? process.env.HOST ?? '127.0.0.1';
const unrestricted = process.argv.includes('--unrestricted');

/**
 * ADR 0068/0069. `--unrestricted` is a deliberate, visible opt-in: it turns off
 * the approval gate and raises the loop budget. Everything else still applies —
 * Agent capability grants, bounded configuration, sanitized child environments,
 * result caps, and the deadline.
 */
if (unrestricted) {
  process.env.CONCHBASE_EXECUTION_MODE ??= 'unrestricted';
  process.env.CONCHBASE_MAX_ITERATIONS ??= '24';
  process.env.CONCHBASE_MAX_TOOL_CALLS_PER_TURN ??= '8';
  process.env.CONCHBASE_LOOP_DEADLINE_MS ??= '600000';
}

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

if (unrestricted) {
  process.stderr.write([
    '',
    '  ⚠  完全放开模式',
    '     工具被授权后直接执行，不会停下来等审批。',
    '     循环预算：',
    `       iterations=${process.env.CONCHBASE_MAX_ITERATIONS}`,
    `       toolCallsPerTurn=${process.env.CONCHBASE_MAX_TOOL_CALLS_PER_TURN}`,
    `       deadlineMs=${process.env.CONCHBASE_LOOP_DEADLINE_MS}`,
    '     请只在沙箱机器或一次性工作区使用。',
    '',
  ].join('\n'));
}

const child = spawn(
  process.execPath,
  [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli.ts', 'serve'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      CONCHBASE_HOST: host,
      CONCHBASE_PORT: String(port),
    },
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
