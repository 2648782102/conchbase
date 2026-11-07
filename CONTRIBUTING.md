# Contributing

Contributions should preserve the runtime/client boundary and document changes to the public API, configuration, or permission model.

Before opening a pull request:

1. Keep changes scoped to one runtime capability or contract.
2. Update the architecture or API documentation when behavior changes.
3. Run `npm run check` and `npm run build`.
4. Describe security effects and compatibility considerations in the pull request.

Do not add secrets, user data, or machine-specific configuration to the repository.
