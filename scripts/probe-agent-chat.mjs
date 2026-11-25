#!/usr/bin/env node
/**
 * Live probe for Agent Chat. Creates a temporary Agent, asks one question,
 * waits for a terminal reply, prints a compact trace, then archives the Agent.
 *
 * Usage:
 *   node scripts/probe-agent-chat.mjs --prompt "..." [--tools workspace_read,workspace_list]
 *                                     [--agent boss] [--base http://127.0.0.1:4318]
 *                                     [--model workbuddy/blind-model-b]
 *                                     [--effort low|medium|high|...]
 *                                     [--auto-approve]
 *   --tools '' explicitly creates an Agent with no tools; omit --tools for the default pair.
 *
 * This is a development probe, not a test: it talks to a running Runtime and
 * costs real model calls.
 */
const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const base = flag('base', 'http://127.0.0.1:4318').replace(/\/$/, '');
const prompt = flag('prompt', '');
const agentKind = flag('agent', 'custom');
const toolList = (args.includes('--tools') ? flag('tools', '') : 'workspace_list,workspace_read').split(',').filter(Boolean);
const modelId = flag('model', 'workbuddy/blind-model-h');
const instructions = flag(
  'instructions',
  '你是文件助手。需要信息时用工具，拿到结果后立即回答，不要重复调用同一个工具。',
);

if (!prompt) {
  console.error('--prompt is required');
  process.exit(1);
}

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return payload;
}

const created = [];
try {
  const agent = agentKind === 'boss'
    ? { id: 'boss-agent', name: 'Boss Agent', created: false }
    : await (async () => {
      const response = await call('POST', '/v1/agents', {
        name: `压测探针-${Date.now().toString(36)}`,
        instructions,
        providerId: 'magpie',
        modelId,
        grantedCapabilities: toolList.map((name) => ({ kind: 'tool', name })),
      });
      return { id: response.agent.id, name: response.agent.current.name, created: true };
    })();
  if (agent.created) created.push(agent.id);

  const effort = flag('effort', '');
  const conversation = await call('POST', '/v1/agent-chat/conversations', {
    agentId: agent.id,
    ...(effort ? { reasoningEffort: effort } : {}),
  });
  const conversationId = conversation.id ?? conversation.conversation?.id;
  const started = Date.now();
  await call('POST', `/v1/agent-chat/conversations/${conversationId}/messages`, {
    text: prompt,
    idempotencyKey: `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });

  const terminal = new Set(['replied', 'failed', 'unavailable', 'succeeded', 'cancelled']);
  let final = null;
  const approved = new Set();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = await call('GET', `/v1/agent-chat/conversations/${conversationId}`);
    const assistant = (view.messages ?? []).filter((message) => message.author === 'assistant');
    const last = assistant.at(-1);
    if (args.includes('--auto-approve') && last?.state === 'waiting_approval' && last.id && !approved.has(last.id)) {
      approved.add(last.id);
      await call('POST', `/v1/agent-chat/conversations/${conversationId}/approval`, {
        assistantMessageId: last.id,
        decision: 'approved',
      });
      continue;
    }
    if (last && terminal.has(last.state)) {
      final = last;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const elapsedMs = Date.now() - started;
  const activity = final?.activity ?? [];
  const turns = activity.filter((entry) => entry.kind === 'turn');
  const tools = activity.filter((entry) => entry.kind === 'tool');
  const reused = tools.filter((entry) => String(entry.label ?? '').includes('复用'));
  const approvals = activity.filter((entry) => entry.kind === 'approval');

  console.log(JSON.stringify({
    agent: agent.name,
    conversationId,
    state: final?.state ?? 'timeout',
    elapsedMs,
    turns: turns.length,
    toolExecutions: tools.length - reused.length,
    toolReused: reused.length,
    approvals: approvals.length,
    approvalsHandled: approved.size,
    error: (final?.error ?? '').slice(0, 200) || null,
    body: (final?.body ?? '').slice(0, 400),
    activity: activity.map((entry) => `${entry.kind}:${entry.state}:${entry.label ?? ''}`),
  }, null, 2));
} finally {
  for (const agentId of created) {
    await call('POST', `/v1/agents/${agentId}/archive`, {}).catch(() => undefined);
  }
}
