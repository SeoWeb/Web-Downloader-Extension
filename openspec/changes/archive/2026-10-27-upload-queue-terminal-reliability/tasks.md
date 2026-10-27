## 1. Queue liveness fixes (`src/background/upload-queue.ts`)

- [x] 1.1 (F1, F2 — D1) Introduce a single terminal-exit tail (e.g. `settleActiveTask()`/`finishTask()` helper) that ends with `notifyProgress()` followed by `if (this.pending.length > 0) this.scheduleProcessing()`, and route the success path (`:453-465`) and every `handleTaskError` exit through it: abort (`:484-500`), `AuthenticationError` (`:504-517`), first-413 (`:528-549`), second-413 (`:550`), 429-exhausted (`:576-587`), and generic terminal failure (`:613-629`)
- [x] 1.2 (F1) Verify the 429-retries-exhausted and `AuthenticationError` branches now reschedule: with all active tasks exiting via either branch and `pending.length > 0`, pending tasks start and `waitForAll()` resolves instead of timing out
- [x] 1.3 (F2) Verify the second-concurrent-413 branch now calls `notifyProgress()`: when it lands on the last active task, `doneWaiters` resolve and `waitForAll()` settles instead of hanging until the drain timeout
- [x] 1.4 (F3 — D3) Reorder `waitForAll()` guards (`:333-337`) so `if (this.cancelled) throw` runs BEFORE `if (this.isDone()) return`; keep `cancel()`'s rejection of already-registered waiters (`:245-250`) unchanged so waiters reject whether they were registered before or after the cancel
- [x] 1.5 (F4 — D2) Add `MAX_RETRY_AFTER_MS = 60_000`: in the 429 branch (`:554-575`), honor `Retry-After` up to the cap, and fail the task terminally (same accounting/logging as 429-exhaustion, without consuming retry budget) when the server asks for more than the cap
- [x] 1.6 (F4 — D2) Rewrite `sleep()` (`:684-686`) as chunked waits (≤ 1s per `setTimeout`, re-checking `this.cancelled` between chunks) so cancellation during backoff is honored promptly and a long wait is not a single far-future timer
- [x] 1.7 (F5 — D4) Guard `notifyProgress()` (`:672-682`): wrap `this.onProgress?.(...)` in try/catch (log once, swallow), keep waiter resolution outside the try, and confirm the success path mutates all counters/`active`/blob state before invoking the callback
- [x] 1.8 (F7 — D6) Make `cancel()`'s summary warn (`:254-257`) conditional on `activeCount + pendingCount > 0` so cancelling an already-drained queue is silent

## 2. Cleanup consistency (queue manifest + caller hygiene)

- [x] 2.1 (F6 — D5) Add `resourceUrlMap.delete(task.id)` to the `AuthenticationError` path (`:504-517`) and to both 413 branches (`:520-551`), including every 413-drained pending task, so permanently-failed and 413-drained URLs are excluded from `getResourceUrls()`
- [x] 2.2 (F6) Confirm the abort path keeps its entries (reachable only via `cancel()`; user-stopped downloads should stay resumable) and document that choice in a code comment
- [x] 2.3 (F7 — D6) In `executeDownloadServerMode`'s finally (`src/background/download-core.ts:1084-1088`), skip `uploadQueue.cancel()` when the drain completed cleanly (no abort fired, `waitForAll` not timed out) while keeping the call as a safety net for error/abort paths; the abort-listener wiring (`:502-508`) stays for genuine user stops
- [x] 2.4 Trace the checkpoint saves (`download-core.ts:697-703`, `:826-833`) against the new `getResourceUrls()` output: a session that hit 413 persists no 413-drained URLs, so `resumeServerDownload` (`:1375-1393`) cannot re-trigger 413 on the resumed session

## 3. Multi-task regression tests (`tests/unit/upload-queue.test.ts`)

- [x] 3.1 (F8a) All active tasks exhaust 429 retries while pending tasks remain → pending tasks start and complete; `waitForAll()` resolves well under any timeout; failedCount == number of exhausted tasks only
- [x] 3.2 (F8b) Concurrent 413s where the second 413 terminates on the last active task → waiters resolve promptly, `onSessionFull` fired exactly once, drained pending counted once
- [x] 3.3 (F8c) `cancel()` during a backoff sleep (incl. a long `Retry-After` sleep) → no leaked counters (failedCount counted once per task), waiters settle (rejected), no retry fires after wakeup
- [x] 3.4 (F8d) `waitForAll()` rejects on a queue cancelled BEFORE the call (currently resolves via the `isDone()` early return) and still rejects for waiters registered before cancel (existing test `:635` stays green)
- [x] 3.5 (F8e) Throwing `onProgress` in the success path → completedCount incremented exactly once, failedCount untouched, queue continues processing remaining tasks, no `blob === null` retry
- [x] 3.6 (F8f) Oversized `Retry-After` (e.g. 3600s) → task fails terminally without a hour-long sleep (fake timers advance instantly), concurrency slot freed, entry excluded from `getResourceUrls()`
- [x] 3.7 (F6) Checkpoint-manifest symmetry: auth-failed and 413-drained tasks absent from `getResourceUrls()`; successful and user-cancelled tasks present

## 4. Verification

- [x] 4.1 `npm run test:unit` (or repo equivalent): new regression tests pass; all 44 existing `upload-queue` tests stay green; full unit suite green
- [x] 4.2 `npm run typecheck` and `npm run lint` clean for both touched files
- [x] 4.3 Manual server-mode download (success path): no `[UploadQueue] Queue cancelled: 0 active + 0 pending` warning in the SW console after completion
- [x] 4.4 Manual/adversarial check of the externally reported stall: simulate all-active-429-exhaustion against a throttling server (or via test 3.1) and confirm the archive finalizes including previously-pending resources, with no 30-minute dead wait
- [x] 4.5 Update `openspec/specs/upload-timeouts/spec.md` by folding this change's deltas into the live capability spec at archive time; note the `stop-cancel-semantics` dependency in that change's proposal when it is drafted
