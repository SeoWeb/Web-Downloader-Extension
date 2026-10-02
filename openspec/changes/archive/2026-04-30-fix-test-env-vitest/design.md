## Context

The test suite runs under Vitest (configured in `vite.config.ts` with `globals: true`) but several test files were written for Jest. The `jest.*` → `vi.*` migration covered the API calls but didn't address the environment setup differences between Jest and Vitest.

Four test files are affected:
- `tests/unit/server-download.test.ts` — 23 failures (chrome undefined)
- `tests/unit/message-handler.test.ts` — 17 failures (require() can't resolve ESM)
- `tests/unit/local-mode-compatibility.test.ts` — 10 failures (shouldUseServerMode signature + require())
- `tests/unit/server-client.test.ts` — 2 failures (wrong server URL + gzip timeout)

## Goals / Non-Goals

**Goals:**

- Make all unit tests pass under Vitest
- Zero changes to production source code
- Minimal test logic changes — only fix infrastructure issues

**Non-Goals:**

- Adding new test coverage
- Fixing the e2e test (`extension-installation.test.cjs`)
- Changing the download-engine or server-client implementations

## Decisions

### D1: Add setupFiles to vitest config

**Choice**: Add `setupFiles: ['./tests/setup.cjs']` to `vite.config.ts` test config.

**Rationale**: The `setup.cjs` file already exists and creates the `globalThis.chrome` mock and `MockCompressionStream`. Vitest just needs to be told to load it. This fixes both the `chrome undefined` error in server-download tests and the gzip timeout in server-client tests.

### D2: Replace require() with import-based mock access

**Choice**: In `message-handler.test.ts` and `local-mode-compatibility.test.ts`, import the mocked module statically and use the import to access mock functions, instead of using `require()` at runtime.

**Rationale**: Vitest's `vi.mock()` hoists and applies to ESM imports, but `require()` at runtime tries to resolve the actual module through Node's CJS resolver — which fails for `.ts` source files. The fix is to import the mocked module and access the mock functions from the import binding. After `vi.mock()`, the import binding resolves to the mock factory's return value.

**Implementation**: Replace the `mock()` helper that does `require(...)` with a direct import:
```ts
// Before (Jest pattern):
function mock(method: string): jest.Mock {
  return (require("../../src/background/server-client") as any).serverClient[method];
}

// After (Vitest pattern):
import { serverClient } from "../../src/background/server-client";
function mock(method: string): vi.Mock {
  return (serverClient as any)[method] as vi.Mock;
}
```

### D3: Update shouldUseServerMode test calls

**Choice**: Pass a `tabId` argument to `shouldUseServerMode()` and `setForceLocalMode()` in tests.

**Rationale**: The production code at `download-core.ts:57-58` changed `shouldUseServerMode` to accept an optional `tabId`:
```ts
export function shouldUseServerMode(tabId?: number): boolean {
  return IS_SERVER_MODE && !!tabId && !forceLocalModes.get(tabId);
}
```
Without `tabId`, `!!tabId` is `false` and the function always returns `false`. Tests need to pass a tab ID (e.g., `1`) and use the two-argument `setForceLocalMode(tabId, value)` signature.

### D4: Create .env.test for Vitest environment override

**Choice**: Create a `.env.test` file with `VITE_SERVER_URL=https://test-server.example.com`.

**Rationale**: Vitest loads `.env.test` automatically when running tests (see Vitest docs on env variables). This replaces the Jest transformer (`vite-env-transform.cjs`) which only worked with Jest's compilation pipeline. The `.env.test` file is the standard Vitest approach and doesn't require any config changes.

## Detailed Design

### Fix 1: setupFiles in vite.config.ts

In `vite.config.ts`, change:
```ts
test: {
  globals: true,
},
```
to:
```ts
test: {
  globals: true,
  setupFiles: ['./tests/setup.cjs'],
},
```

### Fix 2: Import-based mock access

In both `message-handler.test.ts` and `local-mode-compatibility.test.ts`:

1. Remove the `mock()` helper function that uses `require()`
2. Add a static import: `import { serverClient } from "../../src/background/server-client"`
3. Replace `mock("methodName")` calls with `(serverClient as any).methodName` or create a simpler helper that accesses the imported mock

Also remove the `as jest.Mock` / `as vi.Mock` type cast on `require()` returns — use the imported binding instead.

### Fix 3: shouldUseServerMode tabId

In `local-mode-compatibility.test.ts`, update all calls:

- `setForceLocalMode(true)` → `setForceLocalMode(1, true)` (and `false` → `setForceLocalMode(1, false)`)
- `shouldUseServerMode()` → `shouldUseServerMode(1)`
- `clearForceLocalMode()` isn't used in tests but would become `clearForceLocalMode(1)`

### Fix 4: .env.test

Create `tests/.env.test` (or project root `.env.test`):
```
VITE_SERVER_URL=https://test-server.example.com
```

Vitest automatically loads `.env.test` when running in test mode.
