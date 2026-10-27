## Why

A 2026-10 multi-agent audit (externally corroborated by a Perch Scan user report of stalled server-mode downloads) confirmed a family of reliability bugs in the upload queue (`src/background/upload-queue.ts`) and its caller (`src/background/download-core.ts`). The worst defect: several terminal paths remove a task from `active` and `return` WITHOUT resuming the processing loop, so under 12-way concurrency a download can stall while tasks sit in `pending` forever, burn the full 30-minute drain timeout, and then finalize an archive that is silently missing those resources.

Verified findings (line refs against current source):

- **Terminal paths never reschedule.** The 429-retries-exhausted path (`upload-queue.ts:576-587`) and the `AuthenticationError` path (`upload-queue.ts:504-517`) both do `this.active.delete(task.id)` then `return` without `this.scheduleProcessing()`. Every other exit path reschedules (success `:462-465`, generic terminal failure `:626-629`). If ALL active uploads exit via these two branches while `pending.length > 0`, the queue never starts the pending work: `waitForAll()` (called with a dynamic timeout capped at 30 min, `download-core.ts:869-875`) times out, the catch swallows the error (`download-core.ts:877-883`), and `finalizeSession` assembles the archive without the pending resources. This is the externally reported bug.
- **Second concurrent 413 skips `notifyProgress()`.** In the 413 handler (`upload-queue.ts:520-551`) only the FIRST 413 branch (inside `if (!this.sessionFullDetected)`, notify at `:547`) fires progress/waiter resolution. A second concurrent 413 does `failedCount++`, `active.delete`, `return` (`:550`) with no progress event. With 12 concurrent uploads this is likely; if it lands on the last active task, `isDone()` is true but `doneWaiters` are never resolved → `waitForAll()` hangs until the full timeout.
- **`waitForAll()` cancel-rejection is dead code.** `waitForAll()` (`upload-queue.ts:333-337`) checks `isDone()` before `this.cancelled`, but `cancel()` (`:215-260`) always empties both `pending` and `active`, so after a cancel `isDone()` is always true and waiters resolve successfully instead of rejecting — violating the documented contract ("Rejects if the queue is cancelled", `:331`).
- **Uncapped server `Retry-After` + MV3-unsafe sleep.** Own backoff is capped (`MAX_BACKOFF_MS = 8000`) but a server-supplied `Retry-After` is honored uncapped (`:557-564`, conversion `:738-743`): `Retry-After: 3600` parks a concurrency slot for an hour with the task held in `active`. `sleep()` (`:684-686`) uses a bare `setTimeout`, which does not keep an MV3 service worker alive; a worker reaped mid-sleep loses the retry.
- **Unguarded `onProgress` corrupts counters / can stall.** `notifyProgress()` invokes `this.onProgress?.(...)` unguarded (`:672-682`). In the success path the order is blob=null → `completedCount++` → `active.delete` → `notifyProgress` → `scheduleProcessing` (`:453-465`); if `onProgress` throws (in `download-core.ts:513-523` it wraps `sendMessage`, e.g. invalidated extension context), the error falls into `executeTask`'s catch → the already-completed task is retried → fails on `blob === null` → counted failed TOO (double-counted in both counters); a repeat throw at a terminal-path notify also skips `scheduleProcessing()`.
- **`resourceUrlMap` cleanup asymmetry.** The abort (`:484-500`), auth (`:504-517`), and 413 (`:520-551`) terminal paths never delete from `resourceUrlMap`, while 429-exhausted (`:581`) and generic failure (`:618`) do. Permanently-failed and 413-drained URLs therefore leak into download checkpoints (`download-core.ts:697-703`, `:826-833`); resume re-fetches/re-uploads them (`download-core.ts:1375-1393`) and 413-drained entries re-trigger 413 on the resumed session.
- **Spurious "Queue cancelled: 0 active + 0 pending" warn on every success.** `executeDownloadServerMode`'s finally (`download-core.ts:1084-1088`) calls `uploadQueue.cancel()` unconditionally — even after fully successful downloads — emitting the terminal warn (`upload-queue.ts:254-257`) with 0+0 counts every time.
- **Test gap.** All 44 tests in `tests/unit/upload-queue.test.ts` exercise single-task scenarios; none covers the multi-task stall family above.

## What Changes

- Add a **terminal-path safety net** in `UploadQueue`: every path that removes a task from `active` MUST end with `notifyProgress()` AND `if (this.pending.length > 0) this.scheduleProcessing()` — instead of patching the 429-exhausted/auth branches piecemeal (design D1).
- Guarantee waiter resolution on every terminal path, including the second-concurrent-413 branch; the queue can no longer reach `isDone() === true` with unresolved `doneWaiters`.
- Fix `waitForAll()` ordering: check `cancelled` BEFORE `isDone()` so waiters on a cancelled queue reject per the documented contract (design D3; `cancel()` keeps rejecting already-registered waiters itself).
- Cap server-supplied `Retry-After` at 60s; a `Retry-After` beyond the cap fails the task terminally instead of sleeping, and long sleeps are chunked so cancellation is honored promptly (design D2).
- Wrap the `onProgress` callback in try/catch and reorder the success path so counting, `active` cleanup, and rescheduling cannot be skipped by a throwing callback (design D4).
- Make `resourceUrlMap` cleanup symmetric: permanently-failed (auth, 429-exhausted, generic) and 413-detected/drained tasks are excluded from `getResourceUrls()` so checkpoints stay resumable without re-triggering 413 (design D5).
- Silence the spurious cancel warn: `executeDownloadServerMode`'s finally only cancels the queue when the download did not complete cleanly, and `cancel()` of an already-drained queue is silent (design D6).
- Add multi-task regression tests to `tests/unit/upload-queue.test.ts` covering: 429-exhaustion with pending tasks remaining; concurrent 413 where the second terminates last; cancel during backoff; `waitForAll` rejection on a cancelled queue; throwing `onProgress`; oversized `Retry-After`.

## Capabilities

### New Capabilities

(none — all requirements land in the existing `upload-timeouts` capability)

### Modified Capabilities

- `upload-timeouts`: the upload-queue drain requirement gains guarantees that pending uploads start after any terminal failure of active uploads, that `waitForAll()` waiters resolve on every terminal path (including concurrent 413) and reject on a cancelled queue, and that cancellation of a drained queue stays silent; new requirements bound server `Retry-After`, protect upload counters from double-counting when progress callbacks throw, and exclude permanently-failed/413-drained resources from download checkpoints.

## Impact

- **Code:** `src/background/upload-queue.ts` (safety net, notify/waiter guarantees, `waitForAll` ordering, `Retry-After` cap + chunked sleep, guarded `onProgress`, `resourceUrlMap` symmetry, silent idle cancel) and `src/background/download-core.ts` (conditional/silent `uploadQueue.cancel()` in the `executeDownloadServerMode` finally, `:1084-1088`).
- **Tests:** `tests/unit/upload-queue.test.ts` — new multi-task regression section; existing single-task suites must stay green.
- **User-visible behavior:** server-mode downloads no longer stall for up to 30 minutes before finalizing with missing resources when 429s exhaust or auth fails; resumed sessions no longer re-upload 413-drained resources; success paths no longer log a misleading "Queue cancelled" warning.
- **Dependency:** the planned change `stop-cancel-semantics` builds directly on the `waitForAll()`/`cancel()` ordering fix (D3) — its cancel-semantics rework should be layered on top of this change, not in parallel with it.
- **No server changes**, no manifest/permission changes, no checkpoint-format changes (only which entries are written).
