# AI contribution rules

- Read `docs/ARCHITECTURE.md` before changing runtime boundaries.
- Conchbase is the execution authority; UI and CLI entry points are clients.
- Never execute a tool without passing through the runtime policy layer.
- Keep external network binding disabled until authentication and pairing are implemented.
- Keep API request, response, and event contracts versioned and documented.
- Do not add provider secrets, real user data, or machine-specific paths.
- Run `npm run check` and `npm run build` after code changes.

