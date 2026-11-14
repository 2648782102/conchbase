#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

const runtimeBase = (process.env.CONCHBASE_VALIDATION_URL ?? 'http://127.0.0.1:4318').replace(/\/+$/, '');
const intentText = process.env.CONCHBASE_VALIDATION_INTENT
  ?? 'Start project local-validation and hire worker validator.';
const idempotencyKey = process.env.CONCHBASE_VALIDATION_KEY ?? `local-${randomUUID()}`;

async function getJson(path) {
  const response = await fetch(`${runtimeBase}${path}`, {
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({ error: 'Invalid JSON response.' }));
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function postJson(path, body) {
  const response = await fetch(`${runtimeBase}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ error: 'Invalid JSON response.' }));
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function boundedReport(report) {
  return {
    organizationContract: report.runtime.organizationContract ?? null,
    organizationPaths: report.runtime.organizationPaths ?? null,
    intentId: report.intent.intentId,
    intentState: report.intent.state,
    projectCount: report.session.projects?.length ?? 0,
    workerCount: report.session.workers?.length ?? 0,
    reportCount: report.session.reports?.length ?? 0,
    attentionCount: report.session.attentionRequests?.length ?? 0,
    eventCount: report.events.events?.length ?? 0,
    eventTypes: [...new Set((report.events.events ?? []).map((event) => event.type))].sort(),
    hasRawEventsInSession: Object.hasOwn(report.session, 'events'),
  };
}

const health = await getJson('/v1/health');
if (health.status !== 'ok') throw new Error('Runtime health is not ok.');

const runtime = await getJson('/v1/runtime');
if (runtime.organizationContract !== '1.1.0' || runtime.organizationPaths !== 18) {
  throw new Error('Runtime does not advertise the additive 1.1.0 organization contract.');
}

await getJson('/v1/model-catalog');
let intent;
try {
  intent = await postJson('/v1/organization/session/intents', {
    intent: { text: intentText, idempotencyKey },
  });
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/HTTP 400/.test(message) && /not accepted|Action type|validation/i.test(message)) {
    process.stdout.write(`${JSON.stringify({
      status: 'upstream-structured-output-rejected',
      detail: 'The live organization intent model returned an out-of-schema action; Runtime rejected it before commit.',
      cause: message.slice(0, 500),
    }, null, 2)}\n`);
    process.exit(2);
  }
  throw cause;
}
const session = await getJson('/v1/organization/session');
const events = await getJson('/v1/organization/events?limit=1000');
if (Object.hasOwn(session, 'events')) {
  throw new Error('Published session leaked raw organization events.');
}
if (!Array.isArray(session.projects) || !Array.isArray(session.workers)) {
  throw new Error('Published session did not contain organization arrays.');
}
if (!events.events?.some((event) => event.type === 'organization.intent_recorded')) {
  throw new Error('Organization intent was not recorded as a durable event.');
}

process.stdout.write(`${JSON.stringify(boundedReport({ health, runtime, intent, session, events }), null, 2)}\n`);
