## Context

The server-mode upload queue (`src/background/upload-queue.ts`) runs up to 12 concurrent uploads with retry/backoff, 429/413 handling, cancellation, and a `waitForAll()` drain barrier awaited by `executeDownloadServerMode()` (`src/background/download-core.ts:869-875`, timeout `min(remaining * 30s, 30 min)`). A 2026-10 multi-agent audit (externally corroborated by Perch Scan) verified that several terminal paths break the queue's two core liveness invariants — "an emptied `active` slot lets pending work start" and "a drained queue resolves its waiters":

- 429-retries-exhausted (`upload-queue.ts:576-587`) and `AuthenticationError` (`:504-517`) delete from `active` and return without `scheduleProcessing()`; success (`:462-465`) and generic failure (`:626-629`) do reschedule. With all 12 slots lost to these two branches and `pending.length > 0`, nothing ever starts the pending tasks.
- The second concurrent 413 branch (`:520-551`, `return` at `:550`) skips `notifyProgress()`, and `notifyProgress()` is also what resolves `doneWaiters` (`:676-681`) — so the queue can reach `isDone() === true` with waiters still parked.
- `waitForAll()` (`:333-337`) checks `isDone()` before `this.cancelled`; since `cancel()` empties both collections (`:231`, `:239`), the `cancelled` throw is unreachable after a cancel and waiters resolve successfully, contradicting the doc contract (`:329-331`).
- `getRetryAfterFromError()` (`:738-743`) converts server `Retry-After` seconds→ms with no cap (own backoff is capped at `MAX_BACKOFF_MS = 8000`), and `sleep()` (`:684-686`) is a bare `setTimeout` — an MV3 worker reaped mid-sleep loses the retry while the slot stays parked in `active`.
- `notifyProgress()` (`:672-682`) calls `this.onProgress?.(...)` unguarded; the production callback (`download-core.ts:513-523`) wraps `sendMessage` and throws when the extension context is invalidated, which double-counts a completed task as failed and can skip `scheduleProcessing()`.
- `resourceUrlMap` entries are deleted only on 429-exhaustion (`:581`) and generic failure (`:618`) — not on abort/auth/413 paths — so checkpoints (`download-core.ts:697-703`, `:826-833`) carry permanently-failed and 413-drained URLs into resume (`download-core.ts:1375-1393`).
- `executeDownloadServerMode`'s finally (`download-core.ts:1084-1088`) cancels the queue unconditionally, so every fully successful download logs `[UploadQueue] Queue cancelled: 0 active + 0 pending uploads aborted (N had completed successfully)` (`:254-257`).
- `tests/unit/upload-queue.test.ts` has 44 tests, all single-task; none would catch any of the above.

## Goals / Non-Goals

**Goals:**

- The queue can never stall: every path that removes a task from `active` resumes processing and resolves waiters (pending uploads always start; `waitForAll()` always settles).
- `waitForAll()` honors its documented contract: rejects on a cancelled queue, resolves on drain, rejects on timeout.
- Bounded, MV3-tolerant backoff: server `Retry-After` cannot park a slot longer than a sane cap; sleeps remain cancellation-responsive.
- Counter integrity: a task is counted exactly once regardless of `onProgress` failures.
- Clean checkpoints: permanently-failed and 413-drained resources never leak into resume.
- Honest logs: no cancel warning after fully successful downloads.
- Multi-task regression tests locking all of this in.

**Non-Goals:**

- Reworking cancel semantics for the download lifecycle (stop vs. pause vs. resume) — that is the follow-up change `stop-cancel-semantics`, which builds on D3 here.
- Persisting queue state across MV3 worker restarts (checkpoint/resume already covers recovery at the session level).
- Changing server-client retry classification, `MAX_RETRIES`, concurrency limits, or the checkpoint file format.
- Making `Retry-After`-sleeps alarm-based via `chrome.alarms` (in-memory queue cannot survive a worker restart anyway; chunked sleeps + the safety net are sufficient — see D2).

## Decisions

### D1 — Terminal-path safety net (single exit contract), not per-branch patches

Every code path in `UploadQueue` that removes a task from `active` MUST end, after all cleanup and logging, with exactly the same tail: `notifyProgress()` followed by `if (this.pending.length > 0) this.scheduleProcessing()`. The cleanest implementation is a single private helper (e.g. `finishTask(task, {failed})` or a `settleActiveTask()` tail) used by the success path and every terminal branch of `handleTaskError` (abort, auth, both 413 branches, 429-exhausted, generic), so the invariant is structural rather than remembered per branch.

- _Why:_ piecemeal fixes to the 429-exhausted and auth branches would fix today's symptom and leave the invariant unenforced — the second-413 branch shows how easily a new branch forgets the tail. A shared tail also fixes finding 2 for free (the second 413 calls `notifyProgress()`, which resolves `doneWaiters`), and makes future branches correct by construction. The abort branch currently skips rescheduling too; it is only reachable after `cancel()` emptied `pending`, but routing it through the same tail is harmless and removes the special case.
- _Alternatives:_ (a) patch only the two reported branches (rejected: leaves the class of bug open); (b) reschedule unconditionally inside `notifyProgress()` (rejected: conflates notification with scheduling and makes the notify call from `cancel()` trigger unexpected processing); (c) move scheduling into a `queueMicrotask` watchdog that polls `active`/`pending` (rejected: hides invariant violations behind a poller instead of fixing the paths).

### D2 — Retry-After cap policy: honor ≤ 60s, terminate beyond; chunked sleeps

Introduce `MAX_RETRY_AFTER_MS = 60_000`. For a 429 with a server `Retry-After`: values ≤ 60s are honored as today; values > 60s fail the task terminally (same accounting and logging as 429-retries-exhausted) instead of sleeping — the task's own retry budget is not consumed by a nap that would monopolize a concurrency slot for minutes to hours. `Retry-After` remains preferred over exponential backoff when it is within the cap. Additionally, `sleep()` is implemented in short chunks (e.g. ≤ 1s per timer) that re-check `this.cancelled` between chunks, so a cancel during backoff is honored promptly and long waits do not depend on a single far-future `setTimeout` that an MV3 worker reaping would silently drop.

- _Why 60s:_ our own maximum backoff is 8s; a rate-limit window the server expects us to wait out for more than a minute is effectively "this session is throttled" — under the per-resource drain budget (`30s per remaining resource`, capped 30 min) even a 60s pause is generous, and an hour-long park of 1 of 12 slots serializes the whole tail of a large download. Terminal failure is also the honest outcome: the checkpoint then excludes the URL (D5) and resume retries it later, which is exactly what the server is asking for.
- _Alternatives:_ (a) cap-and-clamp (sleep min(Retry-After, 60s)) — rejected: silently disobeys the server's contract while still stalling a slot for up to a minute per retry; (b) `chrome.alarms`-based long sleeps — rejected: the queue, its blobs, and its waiters are all in-memory, so surviving a worker restart is out of scope for this change (checkpoint/resume already owns that recovery); (c) no cap, trust the server — this is the bug.

### D3 — `waitForAll()` checks `cancelled` before `isDone()`; `cancel()` keeps rejecting live waiters

In `waitForAll()`, the guard order becomes: `if (this.cancelled) throw` FIRST, then `if (this.isDone()) return`. This makes the documented contract ("Rejects if the queue is cancelled") reachable for waiters that arrive after a cancel, which today resolve successfully via the `isDone()` early-return because `cancel()` always empties `pending` + `active`. `cancel()` keeps its existing behavior of rejecting already-registered `doneWaiters` (`:245-250`) unchanged — together the two sides guarantee: a waiter registered before cancel rejects (via `cancel()`), a waiter registered after cancel rejects (via the reordered guard), and a waiter on a healthy queue settles exactly when the queue drains (via D1's notify tail).

- _Why both sides:_ fixing only the guard leaves a small window irrelevant in practice today but wrong under future cancel-semantics changes; fixing only `cancel()` leaves the dead branch. The follow-up change `stop-cancel-semantics` (stop vs. pause distinction) builds on exactly this ordering, so the invariant is established here and documented for it.
- _Alternatives:_ (a) resolve (not reject) post-cancel waiters and drop the contract — rejected: silently reports success for a queue that was cancelled mid-flight; callers like `download-core.ts:877-883` treat resolution as "all uploads accounted for"; (b) only reorder the guard — keeps two mechanisms where one guard + one rejection path each have a clear role.

### D4 — Guarded `onProgress` + count-before-notify ordering

`notifyProgress()` wraps `this.onProgress?.(this.getProgress())` in try/catch (a throwing callback is logged once and swallowed — progress reporting must never be able to kill an upload), while waiter resolution (`:676-681`) stays outside the try so it can never be skipped by the callback. In the success path, all state mutation (`completedCount++`, `bytesUploaded`, `active.delete`, blob release) completes BEFORE `notifyProgress()` is invoked, and the reschedule tail (D1) runs after it in a position where a callback throw cannot skip it — guaranteed by the guard, but the ordering is kept so even the counter snapshot passed to the callback is already consistent. Net effect: a throwing `onProgress` (e.g. invalidated extension context in `download-core.ts:513-523`) can no longer push a completed task back through `handleTaskError`, so the completedCount/failedCount double-count and the spurious `blob === null` retry disappear.

- _Alternatives:_ (a) make the `download-core.ts` callback itself throw-proof — rejected: leaves the queue one callback swap away from the same bug, and the queue owns the invariant; (b) debounce/queue progress events asynchronously — rejected: hides ordering hazards instead of removing them and adds lag to UI progress.

### D5 — `resourceUrlMap` cleanup symmetry: exclude everything that will never upload

`resourceUrlMap.delete(task.id)` is added to every terminal path that today lacks it: `AuthenticationError` (`:504-517`), both 413 branches (the failing task AND every 413-drained pending task, `:520-551`), and queue-wide `cancel()` cleanup of pending tasks is left as-is (user-initiated stop intentionally keeps URLs for manual resume). The abort path keeps its entries too: a per-task abort is only reachable via `cancel()`, whose entries resume semantics want preserved. Result: `getResourceUrls()` — consumed by checkpoint saves (`download-core.ts:697-703`, `:826-833`) — contains only resources a resumed session can meaningfully re-upload; 413-drained URLs no longer re-trigger 413 on the resumed session.

- _Alternatives:_ (a) filter at checkpoint-save time by re-deriving failures from progress counters — rejected: the queue already knows exactly which task IDs died and why; a second source of truth would drift; (b) also purge on user cancel — rejected: changes resume semantics for user-stopped downloads, which is `stop-cancel-semantics` territory.

### D6 — Cancel-after-success is silent (and skipped when clean)

Two coordinated tweaks: (1) `UploadQueue.cancel()` emits the `[UploadQueue] Queue cancelled: …` warn only when it actually aborted something (`activeCount + pendingCount > 0`); cancelling an already-drained queue stays a no-op with no log. (2) `executeDownloadServerMode`'s finally (`download-core.ts:1084-1088`) still calls `cancel()` unconditionally as a safety net, but the download path passes/derives whether the drain completed cleanly and skips the call when it did (the abort-listener wiring at `:502-508` remains for genuine user stops). Either measure alone kills the spurious warn; both together keep the safety net honest for future edits.

- _Why keep the unconditional call as fallback:_ removing it entirely would trade a cosmetic log for a real leak risk if a future early-return bypasses the drain; silencing the drained case is the low-risk half of the fix.
- _Alternatives:_ log-level demotion only (debug) — rejected: the warn is genuinely useful when something WAS aborted; it was only noise when nothing was.

## Risks / Trade-offs

- [Safety-net tail could double-schedule processing] → `scheduleProcessing()` is already idempotent via the `processing` flag (`:372-377`); the tail is safe to call from every branch.
- [Terminating on huge `Retry-After` fails uploads a patient queue could have uploaded] → deliberate trade-off (D2): the alternative parks slots and risks the 30-min drain timeout losing MANY resources; resume re-fetches terminated URLs because they are… excluded — resume recovers them via the server's 429 response on a later session, and the panel's failed-count surfaces the loss.
- [Guarded `onProgress` could mask real bugs in the UI messaging layer] → the catch logs the error once per occurrence; counters/queue correctness take priority over message delivery.
- [Reordered `waitForAll` guards change observable behavior] → only for waiters on an already-cancelled queue, which the contract always said must reject; one existing test (`:635`) covers the pre-cancel registration path and stays green.
- [Purging 413-drained URLs from checkpoints] → a resume of a session that hit 413 will no longer re-attempt those files — intended: they would 413 again; the session is finalized with partial data exactly like the original run.

## Migration Plan

1. Implement queue-internal fixes (D1–D5) in `upload-queue.ts` with the new multi-task regression tests passing.
2. Implement the caller-side cancel hygiene (D6) in `download-core.ts`.
3. Run the full unit suite + typecheck + lint; manually verify one successful download logs no cancel warning and one 429-throttled download still finalizes with all resources.
4. Rollback: single-commit revert; no persisted-state or server compatibility concerns.

## Open Questions

- None blocking. Exact chunk size for D2 sleeps (1s proposed) is left to implementation judgment.
