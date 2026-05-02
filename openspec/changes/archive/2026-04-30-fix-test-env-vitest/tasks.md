## 1. Configure Vitest setupFiles

- [x] 1.1 In `vite.config.ts`, add `setupFiles: ['./tests/setup.cjs']` to the `test` config block
- [x] 1.2 Verify: `globalThis.chrome` is defined in tests. Run `tests/unit/server-download.test.ts` and confirm the "Cannot set properties of undefined" errors are gone

## 2. Create .env.test for test environment variables

- [x] 2.1 Create `.env.test` in the project root with `VITE_SERVER_URL=https://test-server.example.com`
- [x] 2.2 Verify: run `tests/unit/server-client.test.ts` and confirm the server URL assertion passes (expects `test-server.example.com`, not `server.pagepocket.app`)

## 3. Fix require()-based mock access in message-handler.test.ts

- [x] 3.1 In `tests/unit/message-handler.test.ts`, add a static import: `import { serverClient } from "../../src/background/server-client"` (this resolves to the `vi.mock()` factory return value at runtime)
- [x] 3.2 Replace the `mock()` helper function (which uses `require()`) with one that accesses `(serverClient as any)[method] as vi.Mock`
- [x] 3.3 Update the `vi.mock()` factory to assign mock functions to a named `serverClient` export so the import binding works
- [x] 3.4 Verify: run `tests/unit/message-handler.test.ts` — all 17 tests should pass

## 4. Fix require()-based mock access in local-mode-compatibility.test.ts

- [x] 4.1 In `tests/unit/local-mode-compatibility.test.ts`, add the same static import pattern as task 3.1
- [x] 4.2 Replace the `mock()` helper function with the import-based version
- [x] 4.3 Update the `vi.mock()` factory to match the same pattern
- [x] 4.4 Fix all `jest.Mock` type references that remain (e.g., `(startDownload as jest.Mock)` → `(startDownload as vi.Mock)`)

## 5. Update shouldUseServerMode calls in local-mode-compatibility.test.ts

- [x] 5.1 Replace all `setForceLocalMode(true)` with `setForceLocalMode(1, true)` and `setForceLocalMode(false)` with `setForceLocalMode(1, false)`
- [x] 5.2 Replace all `shouldUseServerMode()` calls with `shouldUseServerMode(1)`
- [x] 5.3 Update the `beforeEach` reset to use `setForceLocalMode(1, false)` (or `clearForceLocalMode(1)`)
- [x] 5.4 Verify: run `tests/unit/local-mode-compatibility.test.ts` — all 27 tests should pass

## 6. Verify full test suite

- [x] 6.1 Run `npx vitest run` and confirm 0 failures in the 4 previously-failing test files
- [x] 6.2 Confirm the 2 already-passing test files (`server-storage-adapter.test.ts`, `linked-page-text-extraction.test.ts`) still pass
