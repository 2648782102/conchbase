# Security policy

Do not publish credentials, private user data, or an unpatched vulnerability in a public issue. Use GitHub private vulnerability reporting when available.

Conchbase binds to loopback by default. Non-loopback binding requires explicit authenticated configuration and an approved bearer-token digest. Provider credentials stay in the local provider gateway configuration.

The Runtime owns task state, tool permissions, approvals, execution, and durable events. Tool requests and approvals are normalized, bounded, and digest-only until an explicit Runtime capability path allows an action. Provider observations never grant capabilities or execute tools.

Write-only SecretHandle values are sealed at rest with a process-scoped AES-256-GCM key, exposed only to a Runtime-owned fixed adapter, and never returned, logged, or sent to a model, client, event, or UI. Plaintext never enters prompts, task state, durable events, logs, errors, Agent definitions, configuration documents, or browser state. A restart invalidates previously sealed values; stale use requests return a digest-only `denied` receipt.
