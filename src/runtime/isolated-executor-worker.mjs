import { createHash } from 'node:crypto';

const OPERATIONS = new Set(['hash', 'echo_length', 'fixed_matrix']);

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function parseInput(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
    throw new Error('bounded worker input is required');
  }
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('worker input must be an object');
  }
  if (Object.keys(input).sort().join(',') !== 'argumentsDigest,operation,requestId,runId') {
    throw new Error('worker input has unknown fields');
  }
  if (!OPERATIONS.has(input.operation)) throw new Error('operation is not allowlisted');
  for (const key of ['runId', 'requestId', 'argumentsDigest']) {
    if (typeof input[key] !== 'string' || input[key].length === 0 || input[key].length > 240) {
      throw new Error(`${key} is not bounded`);
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.argumentsDigest)) {
    throw new Error('argumentsDigest is not accepted');
  }
  return input;
}

function outputFor(input) {
  const base = `${input.runId}:${input.requestId}:${input.argumentsDigest}`;
  if (input.operation === 'hash') {
    return { resultDigest: digest(`hash:${base}`), outputLength: 64, operation: input.operation };
  }
  if (input.operation === 'echo_length') {
    return { resultDigest: digest(`echo_length:${base}`), outputLength: input.argumentsDigest.length, operation: input.operation };
  }
  const cells = [
    digest(`fixed_matrix:a:${base}`).slice(7, 15),
    digest(`fixed_matrix:b:${base}`).slice(7, 15),
    digest(`fixed_matrix:c:${base}`).slice(7, 15),
    digest(`fixed_matrix:d:${base}`).slice(7, 15),
  ];
  return {
    resultDigest: digest(`fixed_matrix:${base}:${cells.join(':')}`),
    outputLength: cells.length,
    operation: input.operation,
  };
}

try {
  const input = parseInput(process.argv[2]);
  process.stdout.write(`${JSON.stringify({ ok: true, ...outputFor(input) })}\n`);
} catch (cause) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    errorDigest: digest(`worker-error:${cause instanceof Error ? cause.message : 'unknown'}`),
    operation: 'invalid',
  })}\n`);
  process.exitCode = 1;
}
