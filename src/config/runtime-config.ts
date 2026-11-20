import path from 'node:path';
import { isPermissionLevel, type PermissionLevel } from '../kernel/policy.js';

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

/** Validates a loopback URL used to reach a local model gateway. */
function requireLoopbackUrl(raw: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a loopback HTTP URL.`);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !LOOPBACK_URL_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ''))
    || parsed.username !== ''
    || parsed.password !== ''
  ) {
    throw new Error(`${name} must be a loopback HTTP URL.`);
  }
  return raw;
}

/**
 * Reads `CONCHBASE_PROVIDER_ENDPOINTS` — a JSON object of provider id to
 * `{ baseUrl, appKey? }`.
 *
 * Ids must already be registered, so a typo cannot create a phantom provider
 * that silently never receives traffic. Every URL must be loopback for the same
 * reason Magpie's must be: this product does not yet support remote gateways.
 */
function parseProviderEndpoints(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, { readonly baseUrl: string; readonly appKey?: string }>> | undefined {
  const raw = env.CONCHBASE_PROVIDER_ENDPOINTS;
  if (raw === undefined || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CONCHBASE_PROVIDER_ENDPOINTS must be a JSON object.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CONCHBASE_PROVIDER_ENDPOINTS must be a JSON object.');
  }
  const entries: Record<string, { readonly baseUrl: string; readonly appKey?: string }> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Shape only. Whether an id is a registered provider is a Runtime question,
    // answered by `provider-registry`; validating it here made the config layer
    // depend on `src/runtime`, so the dependency now points one way only. An
    // unknown id is inert at resolve time and is rejected with a clear message.
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`CONCHBASE_PROVIDER_ENDPOINTS names an invalid provider id '${id}'.`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`CONCHBASE_PROVIDER_ENDPOINTS['${id}'] must be an object.`);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.baseUrl !== 'string' || record.baseUrl.length === 0) {
      throw new Error(`CONCHBASE_PROVIDER_ENDPOINTS['${id}'].baseUrl is required.`);
    }
    if (record.appKey !== undefined && (typeof record.appKey !== 'string' || record.appKey.length === 0)) {
      throw new Error(`CONCHBASE_PROVIDER_ENDPOINTS['${id}'].appKey must be a non-empty string.`);
    }
    entries[id] = Object.freeze({
      baseUrl: requireLoopbackUrl(record.baseUrl, `CONCHBASE_PROVIDER_ENDPOINTS['${id}'].baseUrl`),
      ...(typeof record.appKey === 'string' ? { appKey: record.appKey } : {}),
    });
  }
  return Object.freeze(entries);
}

export interface RuntimeConfig {
  host: string;
  port: number;
  databasePath: string;
  magpieBaseUrl: string;
  magpieAppKey?: string;
  /**
   * Endpoints for registered non-default providers, keyed by provider id.
   *
   * Absent means the provider is registered but not reachable: the Runtime
   * reports that clearly rather than routing it to Magpie.
   */
  providerEndpoints?: Readonly<Record<string, { readonly baseUrl: string; readonly appKey?: string }>>;
  defaultModel: string;
  organizationIntentModel?: string;
  bossModel?: string;
  mcpConfigPath?: string;
  skillsDirectory?: string;
  allowToolWrites?: boolean;
  /**
   * Read-only git tools. Opt-in because they execute a subprocess;
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
  /**
   * How much this Runtime trusts its Agents.
   *
   * Resolved once at startup from the operator's environment and never read
   * from a task, Agent revision, model output, or API request. `executionMode`
   * remains for compatibility; this is the value the policy kernel consumes.
   */
  permissionLevel?: PermissionLevel;
  loopBudget: LoopBudget;
  /** the implementation: worker loop iterations per cooperative slice. 0 disables yielding. */
  workerSliceIterations: number;
  /**
   * How long a project may receive no observable activity before the
   * Runtime closes it. Operator configuration only: a model, task, or client
   * can never change the retention policy.
   */
  projectIdleMs: number;
  /** the implementation: non-preemptive global work capacity. */
  globalActiveWork: number;
  perProjectActiveWork: number;
  /**
   * How many Agent-backed tasks may hold a provider call at once.
   *
   * Separate from `globalActiveWork`, which governs organization work items: a
   * burst of queued tasks (for example after a restart) would otherwise open
   * one completion stream per task and exhaust the gateway.
   */
  maxConcurrentTasks?: number;
  /**
   * Automatic snapshotting of the database.
   *
   * On by default because the alternative — an operator who remembers to run
   * `conchbase backup` — is the failure mode that loses data. A short interval
   * is clamped by the scheduler; 0 disables it entirely.
   */
  backupIntervalMs?: number;
  backupKeep?: number;
  backupDirectory?: string;
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

  const magpieBaseUrl = requireLoopbackUrl(
    env.CONCHBASE_MAGPIE_URL ?? 'http://127.0.0.1:3425',
    'CONCHBASE_MAGPIE_URL',
  );

  const magpieAppKey = env.CONCHBASE_MAGPIE_APP_KEY;
  if (magpieAppKey !== undefined && !/^magpie-[a-zA-Z0-9_-]+$/.test(magpieAppKey)) {
    throw new Error('CONCHBASE_MAGPIE_APP_KEY has an invalid format.');
  }

  const providerEndpoints = parseProviderEndpoints(env);
  const executionModeValue = env.CONCHBASE_EXECUTION_MODE ?? 'restricted';
  if (!EXECUTION_MODES.includes(executionModeValue as ExecutionMode)) {
    throw new Error('CONCHBASE_EXECUTION_MODE must be restricted or unrestricted.');
  }
  const executionMode = executionModeValue as ExecutionMode;
  // The permission level is the forward-looking setting; `executionMode` stays
  // accepted so existing deployments keep working. The valid set comes from the
  // kernel rather than a literal here, so adding or removing a level cannot
  // leave the config accepting a value the policy engine does not know.
  const configuredLevel = env.CONCHBASE_PERMISSION_LEVEL?.trim() || undefined;
  const requestedLevel: unknown = configuredLevel
    ?? (executionMode === 'unrestricted' ? 'trusted' : 'standard');
  if (!isPermissionLevel(requestedLevel)) {
    throw new Error('CONCHBASE_PERMISSION_LEVEL must be strict, standard, or trusted.');
  }
  const permissionLevel: PermissionLevel = requestedLevel;
  const workspaceRoot = env.CONCHBASE_WORKSPACE_ROOT ?? process.cwd();
  if (!path.isAbsolute(workspaceRoot) && !path.posix.isAbsolute(workspaceRoot) && !path.win32.isAbsolute(workspaceRoot)) {
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
  const maxConcurrentTasks = boundedInteger(
    env.CONCHBASE_MAX_CONCURRENT_TASKS,
    'CONCHBASE_MAX_CONCURRENT_TASKS',
    { fallback: 4, min: 1, max: 32 },
  );
  // 0 is a deliberate opt-out, so the bound starts at 0 rather than 1.
  const backupIntervalMs = boundedInteger(
    env.CONCHBASE_BACKUP_INTERVAL_MS,
    'CONCHBASE_BACKUP_INTERVAL_MS',
    { fallback: 24 * 60 * 60 * 1000, min: 0, max: 7 * 24 * 60 * 60 * 1000 },
  );
  const backupKeep = boundedInteger(
    env.CONCHBASE_BACKUP_KEEP,
    'CONCHBASE_BACKUP_KEEP',
    { fallback: 7, min: 1, max: 64 },
  );
  const workerSliceIterations = boundedInteger(
    env.CONCHBASE_WORKER_SLICE_ITERATIONS,
    'CONCHBASE_WORKER_SLICE_ITERATIONS',
    { fallback: 0, min: 0, max: 63 },
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
    ...(providerEndpoints ? { providerEndpoints } : {}),
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
    permissionLevel,
    loopBudget,
    workerSliceIterations,
    projectIdleMs,
    globalActiveWork,
    perProjectActiveWork,
    maxConcurrentTasks,
    backupIntervalMs,
    backupKeep,
    ...(env.CONCHBASE_BACKUP_DIR ? { backupDirectory: env.CONCHBASE_BACKUP_DIR } : {}),
    allowAuthenticatedRemoteBinding,
    ...(authTokenDigest ? { authTokenDigest } : {}),
  };
}
