# Security policy

Please do not publish credentials, private user data, or an unpatched vulnerability in a public issue. Use GitHub's private vulnerability reporting for this repository when enabled, or contact the maintainers through the account profile.

Conchbase is early software. The phase-1 API is loopback-only and unauthenticated for local development; do not expose it to a network or untrusted local process. It is not a production agent runtime. Provider credentials stay in Magpie's own configuration.
