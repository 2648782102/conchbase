/**
 * Answers the one operational question the CLI needs: is a Runtime up on this
 * address, and is it healthy? Kept separate from the HTTP server so it can be
 * unit tested with an injected fetch.
 */

export interface RuntimeStatus {
  readonly baseUrl: string;
  readonly running: boolean;
  readonly healthy: boolean;
  readonly version?: string;
  readonly state?: string;
  readonly detail: string;
}

export async function probeRuntimeStatus(options: {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): Promise<RuntimeStatus> {
  const base = options.baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 2_000);
  try {
    const health = await fetchImpl(`${base}/v1/health`, { signal: timeout });
    if (!health.ok) {
      return { baseUrl: base, running: true, healthy: false, detail: `health returned HTTP ${health.status}` };
    }
    const body = await health.json() as { status?: string };
    const healthy = body.status === 'ok';
    let version: string | undefined;
    let state: string | undefined;
    try {
      const runtime = await fetchImpl(`${base}/v1/runtime`, { signal: AbortSignal.timeout(2_000) });
      if (runtime.ok) {
        const info = await runtime.json() as { version?: string; state?: string };
        version = info.version;
        state = info.state;
      }
    } catch {
      // Version/state are optional detail; health already answered the question.
    }
    return Object.freeze({
      baseUrl: base,
      running: true,
      healthy,
      ...(version ? { version } : {}),
      ...(state ? { state } : {}),
      detail: healthy ? 'runtime is up and healthy' : `runtime answered but status is ${body.status ?? 'unknown'}`,
    });
  } catch {
    return { baseUrl: base, running: false, healthy: false, detail: 'no runtime is listening on this address' };
  }
}

export function formatRuntimeStatus(status: RuntimeStatus): string {
  if (!status.running) return `Runtime: down (${status.baseUrl}) — ${status.detail}\n`;
  const version = status.version ? ` v${status.version}` : '';
  const state = status.state ? ` state=${status.state}` : '';
  return `Runtime: up${version}${state} (${status.baseUrl}) — ${status.detail}\n`;
}
