#!/usr/bin/env node
/**
 * A minimal stdio plugin used by the plugin-loader tests.
 *
 * The protocol is one JSON object per line in each direction: `{callId, type,
 * toolId, args}` in, `{callId, ok, summary}` out. There is no handshake — spawn
 * success is readiness — so this stub only has to answer a request.
 */
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });

input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { callId, toolId, args } = request;
  /*
   * The Runtime namespaces a plugin's tools as `<pluginId>_<toolId>`, so the
   * name that arrives here is the namespaced one. Matching the bare `echo` is
   * the mistake a plugin author makes first; this stub accepts both so the
   * fixture cannot hide which name really travels.
   */
  if (toolId === 'echo' || toolId.endsWith('_echo')) {
    process.stdout.write(`${JSON.stringify({ callId, ok: true, summary: `echo:${String(args?.text ?? '')}` })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ callId, ok: false, errorCode: 'unknown_tool' })}\n`);
});
