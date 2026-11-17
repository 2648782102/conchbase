/**
 * A fetch stub that answers only the model catalog.
 *
 * `BossModeService` resolves a model reference before it hands the turn to a
 * parser, so every Boss test needs a reachable catalog even when the parser is
 * scripted and no completion is ever requested. Pointing those tests at a live
 * Magpie port made them pass on a developer machine and fail in CI, so they
 * inject this instead. Any request beyond the catalog is a bug in the test and
 * fails loudly rather than escaping to the network.
 */
export function catalogOnlyFetch(modelId = 'fixture-model'): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.endsWith('/v1/models')) {
      throw new Error(`Unexpected request in a catalog-only test: ${url}`);
    }
    return new Response(JSON.stringify({
      data: [{ id: modelId, display_name: 'Fixture Model' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}
