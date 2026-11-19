# Validation plan

Validation should answer one question: can this personal Agent do useful work
without losing state, hiding side effects, or exposing secrets?

## Every code change

Run the narrowest relevant test first, then:

```sh
npm run check
npm test
npm run build
```

Use fake local providers and temporary workspaces in automated tests. Never use
real credentials, private user data, or public-network calls in CI.

## Runtime test layers

1. **Pure domain tests:** parsers, validators, state transitions, digests,
   budgets, and redaction.
2. **Provider contract tests:** catalog, streaming, cancellation, tool calls,
   error categories, malformed responses, and size limits through fake HTTP.
3. **Persistence tests:** migrations, restart, interrupted work, retry,
   idempotency, event cursors, backup, and restore.
4. **HTTP tests:** request validation, response envelopes, capability discovery,
   authentication, error mapping, and no private-file access.
5. **Scenario tests:** real Runtime with fake provider plus temporary workspace;
   assert filesystem effects, provider trace, durable events, and final reply.
6. **Paired tests:** real Conchbase HTTP plus dynamically loaded Pagurus API
   clients for important end-to-end workflows.
7. **Manual/live checks:** real browser, configured local provider, narrow and
   wide layouts, keyboard navigation, disconnect/reconnect, and upgrade/restore.
8. **Soak checks:** long conversations, repeated restart, event growth, memory
   retention, concurrent bounded work, and provider flakiness.

## Required cases for Agent features

- ordinary successful answer;
- provider unavailable, authentication error, rate limit, timeout, malformed
  output, and context-limit error;
- cancellation before provider call, during streaming, and during a tool;
- duplicate request/idempotency replay;
- restart before, during, and after a durable checkpoint;
- tool timeout, tool failure, oversized output, path escape, and prompt
  injection in tool output;
- denied approval, approved action, stale approval, and repeated approval;
- secret-like values absent from prompts, events, logs, errors, database bytes,
  and client responses;
- Agent edit after task creation does not change the task's pinned revision;
- memory deletion remains effective after restart.

## Definition of done

A feature is done when its user-visible path works, its failure path is
understandable, its state survives the required restart boundary, its focused
tests pass, the normal suite passes, and `CURRENT_STATE.md`/`PROJECT_PLAN.md`
still describe reality.

Do not inflate the status document with every test case. Test names and source
files are the detailed evidence; this document defines the required layers.
