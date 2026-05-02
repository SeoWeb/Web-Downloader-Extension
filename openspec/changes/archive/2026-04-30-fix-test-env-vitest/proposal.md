## Why

The test suite has 52 pre-existing failures across 4 test files. The root cause is that these tests were written for Jest but now run under Vitest. The migration replaced `jest.*` calls with `vi.*` but left behind several Jest-specific patterns that Vitest doesn't support:

1. `setup.cjs` initializes `globalThis.chrome` and `MockCompressionStream`, but `vite.config.ts` has no `setupFiles` entry — so the mock never loads and `globalThis.chrome` is `undefined` at test time
2. Tests use `require()` to access mocked modules at runtime, which works in Jest's CJS environment but fails under Vitest's ESM module resolution
3. `shouldUseServerMode()` was updated to require a `tabId` parameter (per-tab force-local tracking), but tests still call it without one
4. `vite-env-transform.cjs` is a Jest transformer that replaces `import.meta.env.VITE_SERVER_URL` with a test value — Vitest resolves it from `.env` instead, giving the production URL

## What Changes

- Add `setupFiles: ['./tests/setup.cjs']` to the Vitest config
- Replace `require()` calls in mock helpers with static imports of the mocked module
- Update tests to pass `tabId` to `shouldUseServerMode()` and `setForceLocalMode()`
- Replace the Jest transformer with a Vitest-compatible env override (`.env.test` file or vitest `env` config)

## Capabilities

### Modified Capabilities

- `extension-server-client`: Test environment properly initializes browser globals and mocks
- `download-engine`: Tests updated for the current `shouldUseServerMode(tabId)` signature

### Non-Goals

- Fixing the `extension-installation.test.cjs` e2e test (separate concern — it has no test suite)
- Adding new test coverage — only fixing existing tests to pass
- Changing any production source code
