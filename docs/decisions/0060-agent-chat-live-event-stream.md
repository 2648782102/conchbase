# Decision 0060: Agent Chat live event stream with resumable cursors

Status: **accepted and implemented Agent Chat live event stream slice**

Date: 2026-11-15 (Asia/Shanghai).

## Context

Agent Chat currently polls `GET /v1/agent-chat/conversations/{conversationId}` every 700 ms. That produces coarse updates: a tool activity, an approval request, or a streamed sentence can appear late or in a burst. It also re-sends the whole conversation on every poll. ADR 0012 already writes durable `task.output_delta` events, ADR 0059 projects them into bounded activity, and event ids are globally monotonic (`evt_000000000001`). What is missing is a transport that delivers those facts promptly and can resume after a dropped connection without losing or duplicating messages.

Polling is still the compatibility path. Any live stream must be additive, must not change Runtime authority, and must not expose tool arguments, file contents, provider reasoning, or private state.

## Decision

1. Conchbase adds one additive SSE path:
   `GET /v1/agent-chat/conversations/{conversationId}/events?after=<eventId>`
   It returns `text/event-stream` with `Cache-Control: no-cache`, `Connection: keep-alive`, and `X-Accel-Buffering: no`.
2. The stream is a projection over the same durable Runtime events used by Agent Chat. Each SSE `message` uses the Runtime event id as its `id:` field and carries a bounded JSON envelope:
   `{ version, conversationId, messageId, eventId, kind, message }`
   where `kind` is one of `message`, `activity`, or `snapshot` and `message` is a complete published `AgentChatMessage`. No partial or client-only message shape is introduced.
3. On connect the server first emits one `snapshot` event containing the current conversation view. If `after` is present and refers to a known event, the snapshot is followed by replay from that cursor, then live updates. If `after` is unknown or belongs to another task, the server responds `400` before writing the stream. If the conversation has no task events yet, the stream stays open for later updates rather than closing.
4. Replay is bounded. A single connection sends at most 500 replayed events and then emits one `snapshot` with a fresh cursor so a client can continue. The server never replays unbounded history over SSE.
5. A `health` frame is sent every 15 seconds. It carries the current cursor and lets clients detect a live connection without inventing a message; comment-only heartbeats are not used. A slow client whose buffered output exceeds 1 MB is disconnected and must reconnect from its cursor. At most 32 streams may be open at once per runtime process; excess connections receive `503`.
6. The transport is read-only. Approval still goes through `POST .../approval`; the SSE stream only reports the resulting state. A dropped connection never cancels a task. Reconnecting with `Last-Event-ID` (or `?after=`) resumes from the last delivered event.
7. The Agent Chat contract advances to `1.8.0` with six published paths. The frozen 47-path `1.0.0` platform, `1.1.0` organization, `1.2.0` execution, `1.3.0` execution-run, `1.4.0` conversation, `1.5.0` Agent Chat, `1.6.0`, and `1.7.0` contracts remain unchanged.
8. Pagurus adds a typed SSE client with automatic reconnect and cursor tracking. It keeps polling as a fallback when `EventSource` is unavailable or the runtime does not advertise `1.8.0`.

## Options

### A. Keep polling only

Consequences: latency and redundant payloads; tool/approval states feel stuck. Rejected as the only transport.

### B. Stream raw task events to the client

Consequences: clients must reimplement projection, and it risks exposing tool arguments or private state. Rejected.

### C. Stream projected Agent Chat messages with resumable cursors and snapshots

Consequences: prompt updates, one projection implementation, bounded replay, safe reconnect. Accepted.

## Validation

- SSE emits a snapshot first, replays from a known cursor without duplicates, and rejects an unknown cursor with `400` before streaming.
- A tool request, approval request, approval decision, streamed output delta, and terminal reply each produce exactly one projected update with a stable event id.
- Reconnect with `Last-Event-ID` resumes after the last delivered id; no message is lost or duplicated.
- Heartbeats appear on an idle stream; the stream never carries tool arguments, file contents, provider reasoning, or private paths.
- Polling remains functional when SSE is disabled.
- Pagurus typed client and conversation panel gate on `agentChatContract: "1.8.0"` / `agentChatPaths: 6`, use SSE when available, and fall back to polling.

## Consequences

Agent Chat gains a Codex-like live conversation with recoverable delivery while remaining a projection of Runtime-owned durable facts. SSE event retention, multi-process fan-out, provider reasoning display, tool-argument display, network tools, and write-capable MCP tools remain outside this boundary.

> Implementation boundary: one additive SSE path, one projected envelope, bounded replay, and a client-side fallback. No public write route and no second source of truth.
