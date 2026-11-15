import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { resolveWorktreeEnv } from './worktree-env.mjs';

// Parallel sessions: the main checkout keeps 4318, every linked worktree gets a
// stable port and its own database derived from its branch. See
// docs/PARALLEL_DEVELOPMENT.md. An explicit CONCHBASE_PORT / PORT still wins.
const session = resolveWorktreeEnv(process.cwd(), process.env);
const port = Number(session.port);
const host = session.host;
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
    [
      `Port ${host}:${port} is already in use (session "${session.slug}").`,
      'Stop the other Runtime, or run with an explicit port:',
      `  CONCHBASE_PORT=4360 npm run dev`,
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.stderr.write([
  '',
  `  session  ${session.slug}${session.main ? ' (main checkout)' : ''}`,
  `  bind     ${host}:${port}`,
  `  database ${session.databasePath}`,
  `  workspace ${session.workspaceRoot}`,
  '',
].join('\n'));

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
      // Isolation defaults. An explicit value in the parent environment still
      // wins, because the spread above runs first.
      CONCHBASE_DB: process.env.CONCHBASE_DB ?? session.databasePath,
      CONCHBASE_WORKSPACE_ROOT: process.env.CONCHBASE_WORKSPACE_ROOT ?? session.workspaceRoot,
    },
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
