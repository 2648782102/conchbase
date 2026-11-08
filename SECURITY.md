# Security policy

Please do not publish credentials, private user data, or an unpatched vulnerability in a public issue. Use GitHub's private vulnerability reporting for this repository when enabled, or contact the maintainers through the account profile.

Conchbase is early software. The phase-1 API is loopback-only and unauthenticated for local development; do not expose it to a network or untrusted local process. It is not a production agent runtime. Provider credentials stay in Magpie's own configuration.

The bounded composition executor does not call a model provider, load Skills/MCP/plugins, resolve secrets, or execute real host tools. The public tool request/approval ledger stores normalized, digest-only request and decision records plus durable audit events; it does not execute tools, grant capabilities, or treat an approval as execution permission. Provider tool-call parsing, real executor isolation, crash-safe side effects, and public tool execution remain separate accepted-contract work.
