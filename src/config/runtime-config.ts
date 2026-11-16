const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_URL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export const EXECUTION_MODES = Object.freeze(['restricted', 'unrestricted'] as const);
export type ExecutionMode = typeof EXECUTION_MODES[number];

export interface LoopBudget {
  readonly maxIterations: number;
  readonly maxToolCallsPerTurn: number;
  readonly deadlineMs: number;
}

const LOOP_BUDGET_LIMITS = Object.freeze({
  maxIterations: { fallback: 6, min: 1, max: 64 },
  maxToolCallsPerTurn: { fallback: 4, min: 1, max: 16 },
  deadlineMs: { fallback: 120_000, min: 1_000, max: 1_800_000 },
});

function boundedInteger(
  raw: string | undefined,
  name: string,
  limits: { fallback: number; min: number; max: number },
): number {
  if (raw === undefined) return limits.fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${limits.min} and ${limits.max}.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
    throw new Error(`${name} must be an integer between ${limits.min} and ${limits.max}.`);
  }
  return value;
}

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
  skillsDirectory?: string;
  allowToolWrites?: boolean;
  /**
   * ADR 0095. Read-only git tools. Opt-in because they execute a subprocess;
   * every other built-in tool is a filesystem call.
   */
  enableGitTools?: boolean;
  /**
   * The only directory tool calls may read or write. Defaults to the process
   * working directory, which is convenient for development and dangerous for
   * writes: a model that runs `workspace_write` would otherwise be able to
   * overwrite the repository the Runtime itself lives in.
   */
  workspaceRoot: string;
  executionMode: ExecutionMode;
  loopBudget: LoopBudget;
  /**
   * ADR 0081. How long a project may receive no observable activity before the
   * Runtime closes it. Operator configuration only: a model, task, or client
   * can never change the retention policy.
   */
  projectIdleMs: number;
  /** ADR 0100: non-preemptive global work capacity. */
  globalActiveWork: number;
  perProjectActiveWork: number;
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
  const executionModeValue = env.CONCHBASE_EXECUTION_MODE ?? 'restricted';
  if (!EXECUTION_MODES.includes(executionModeValue as ExecutionMode)) {
    throw new Error('CONCHBASE_EXECUTION_MODE must be restricted or unrestricted.');
  }
  const executionMode = executionModeValue as ExecutionMode;
  const workspaceRoot = env.CONCHBASE_WORKSPACE_ROOT ?? process.cwd();
  if (!workspaceRoot.startsWith('/')) {
    throw new Error('CONCHBASE_WORKSPACE_ROOT must be an absolute path.');
  }
  const allowToolWrites = env.CONCHBASE_ALLOW_TOOL_WRITES === '1';
  const enableGitTools = env.CONCHBASE_ENABLE_GIT_TOOLS === '1';
  if (allowToolWrites && env.CONCHBASE_WORKSPACE_ROOT === undefined) {
    throw new Error(
      'CONCHBASE_ALLOW_TOOL_WRITES=1 requires CONCHBASE_WORKSPACE_ROOT. '
      + 'Writing into the process working directory can overwrite the Runtime itself.',
    );
  }
  const loopBudget: LoopBudget = Object.freeze({
    maxIterations: boundedInteger(
      env.CONCHBASE_MAX_ITERATIONS,
      'CONCHBASE_MAX_ITERATIONS',
      LOOP_BUDGET_LIMITS.maxIterations,
    ),
    maxToolCallsPerTurn: boundedInteger(
      env.CONCHBASE_MAX_TOOL_CALLS_PER_TURN,
      'CONCHBASE_MAX_TOOL_CALLS_PER_TURN',
      LOOP_BUDGET_LIMITS.maxToolCallsPerTurn,
    ),
    deadlineMs: boundedInteger(
      env.CONCHBASE_LOOP_DEADLINE_MS,
      'CONCHBASE_LOOP_DEADLINE_MS',
      LOOP_BUDGET_LIMITS.deadlineMs,
    ),
  });
  const globalActiveWork = boundedInteger(
    env.CONCHBASE_GLOBAL_ACTIVE_WORK,
    'CONCHBASE_GLOBAL_ACTIVE_WORK',
    { fallback: 8, min: 1, max: 32 },
  );
  const perProjectActiveWork = boundedInteger(
    env.CONCHBASE_PER_PROJECT_ACTIVE_WORK,
    'CONCHBASE_PER_PROJECT_ACTIVE_WORK',
    { fallback: 2, min: 1, max: 16 },
  );
  const projectIdleMs = boundedInteger(
    env.CONCHBASE_PROJECT_IDLE_MS,
    'CONCHBASE_PROJECT_IDLE_MS',
    { fallback: 30 * 60 * 1000, min: 60_000, max: 86_400_000 },
  );
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
    ...(env.CONCHBASE_SKILLS_DIR ? { skillsDirectory: env.CONCHBASE_SKILLS_DIR } : {}),
    ...(allowToolWrites ? { allowToolWrites: true } : {}),
    ...(enableGitTools ? { enableGitTools: true } : {}),
    workspaceRoot,
    executionMode,
    loopBudget,
    projectIdleMs,
    globalActiveWork,
    perProjectActiveWork,
    allowAuthenticatedRemoteBinding,
    ...(authTokenDigest ? { authTokenDigest } : {}),
  };
}
