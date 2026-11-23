#!/usr/bin/env node
/**
 * CLI entry point for the live provider contract probe.
 *
 * Usage:
 *   CONCHBASE_PROVIDER_ENDPOINTS='{"openai-compatible":{"baseUrl":"http://127.0.0.1:3425","appKey":"..."}}' \
 *     CONCHBASE_MODEL=model-id npm run probe:provider
 *
 * The published command runs the compiled Runtime. Build with `npm run build`
 * after changing Runtime code.
 */
import { runProviderContract } from '../dist/cli/provider-contract-probe.js';

// Local gateways must not be sent through an operator's outbound proxy.
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.ALL_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

process.exitCode = await runProviderContract();
