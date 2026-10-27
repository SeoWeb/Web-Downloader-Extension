## Context

Asset fetches flow through a shared singleton `RequestQueue` (`src/utils/RequestQueue.ts`). File handlers (`src/background/fileHandlers/{images,css,js,documents}.ts`) enqueue each fetch with `onComplete`/`onError` callbacks that settle a per-asset promise (the `enqueueRequest` helper resolves `{ok: true, result}` or `{ok: false, error}` on whichever callback fires first — e.g. `images.ts:29-41`); the handler then writes the asset to the archive or records it in the failure tally that surfaces as `resourcesFailed`.

The queue wraps user listeners (`setupEventListeners`, `RequestQueue.ts:426-484`): its `onError` decides retries (`request.retryCount < maxRetries && isRetryableError`, lines 459-474) and `retryRequest` (lines 1029-1058) schedules a **detached** `setTimeout` re-enqueue of the same request object, tracked in `retryTimers` (lines 152-155, cancelled by `clear()` at 311-317 and `clearDownload()` at 354-360). The scheduler (`RequestScheduler.ts`) holds its own active map and fires the wrapped listeners; the domain limiter (`DomainLimiter.ts`) gates per-domain rate, crawl-delay, and a 12-slot connection pool.

The 2026-10 multi-agent audit confirmed five defects, all verified against current source:

1. **Retry defeated (MED).** `failRequest()` (lines 947-972) invokes `activeRequest.request.onError(error)` unconditionally (lines 966-968) — even though `scheduler.failRequest()` on line 963 has already fired the wrapped listener, which scheduled a detached retry for retryable errors. The handler settles as failed immediately; the orphan retry later fetches successfully into the settled promise (`completeRequest` line 936-938) and caches the result into the dedup cache (lines 450-457). Retries never rescue an asset into the archive.
2. **`clear()` strands in-flight settlement (MED, latent).** `clear()` (lines 311-335) aborts each controller then synchronously drops `activeRequests` (line 323). Each aborted fetch's later rejection hits the `failRequest` early-return (lines 948-951, map entry gone): `request.onError`, `scheduler.failRequest`, and `scheduleProcessing()` are all skipped, and `domainLimiter.completeRequest()` never runs — the limiter's connection-pool slot leaks permanently. `RequestScheduler.clear()` (lines 271-294) likewise drops its active map without settling anything. Today the callers gate `clear()` on "no download in progress" (`download.ts:30-39`, `download-core.ts:447-456`), so nothing awaits the lost settlements — but the handlers' `Promise.allSettled` has no timeout, so any future caller (or gate regression) hangs the download forever.
3. **`processQueue` catch-and-ignore (MED).** The dequeue loop's `try/catch { // Ignore }` (lines 599-601): a throw from `getAdaptiveConcurrency()` (line 564), `shouldThrottleRequest()` (577), `DomainLimiterFactory.getLimiter()` (586), or `getNextRequest()` (570) before anything is started or deferred leaves `deferredCount === 0` and `globalThrottleBlocked === false`, so none of the tail reschedule branches (lines 614-633) fire — a non-empty scheduler strands until an unrelated enqueue/completion (the scheduler's own 1 ms loop never calls back into the queue's `processQueue`, `RequestScheduler.ts:429-446`). Also `let startedCount = 0;` (line 555) is never incremented, so the guard at line 625 silently means `deferredCount > 0`.
4. **`getWaitTime()` returns 0 on pool saturation (LOW).** `DomainLimiter.getWaitTime()` (lines 88-107) covers the rate window and crawl delay but not the connection pool (`canMakeRequest()` lines 59-61). A pool-blocked request computes `nearestDomainWaitMs = 1` (`RequestQueue.ts:588-591`), and the tail branch clamps to `QUEUE_TICK_MS = 10` (line 31) — the queue polls at its minimum tick until a slot frees instead of waiting on a real estimate.
5. **`pause()` doesn't stop the scheduler loop (LOW).** `RequestQueue.pause()` (lines 287-294) clears only the queue's timer. `RequestScheduler` has no pause: its `scheduleProcessing()` (lines 415-424) self-reschedules at 1 ms and `processQueue()` (lines 429-446) keeps the loop alive while `isEmpty()` is false; only `shutdown()` (lines 299-308) stops it. A CRITICAL memory-pressure pause (`download.ts:41-49`) therefore leaves a 1 ms busy loop for as long as work is queued.

## Goals / Non-Goals

**Goals:**

- A retried request that eventually succeeds is archived and counted as success; a retried request is never reported failed.
- `onError` fires at most once per request, and only after the final attempt is exhausted (or the failure is terminal).
- `clear()` / `clearDownload()` settle every dropped request's handler promise exactly once; no limiter-slot leak.
- The queue reschedules itself after internal errors; a non-empty scheduler can never strand.
- Paused queues consume no timers; pool saturation yields a real wait instead of minimum-tick polling.
- Preserve the existing `retryTimers` tracking/cleanup and the handler-facing callback contract.

**Non-Goals:**

- No change to retry classification: `isRetryableError` categories stay as-is (`cancelled` and `timeout` terminal; 408/429/5xx transient; 4xx terminal).
- No redesign of the handler `enqueueRequest` contract or handler-level failure tallying.
- No new public cancellation API for callers of the queue.
- No change to dedup-cache semantics beyond no longer polluting it with orphaned retry results.

## Decisions

### D1 — Retry owns the failure signal

`failRequest()` becomes the single terminal-outcome gate: it decides retryability **before** any callback fires and invokes `request.onError` only when the outcome is terminal — i.e. when `!(request.retryCount < maxRetries && isRetryableError(error))`. When a retry is scheduled, the handler is left pending; the detached retry re-enqueues the **same request object** (existing `retryRequest` behavior), so its eventual `onComplete` (success) or terminal-attempt `onError` (exhaustion) settles the handler through the exact code paths that exist today.

- _Why the same-object re-enqueue is safe:_ the request's `onComplete`/`onError` closures are the handler's promise settlers; re-running the request re-uses them, so retry success resolves the handler (asset archived) and exhaustion rejects it exactly once (the last attempt is terminal by `retryCount === maxRetries`).
- _Why not settle handlers per-attempt:_ handlers would need a per-attempt API (new surface, all four handlers rewired) for no benefit — callers only care about the final outcome.
- _Consistency guard:_ the wrapped `onError` already forwards to `originalListeners.onError` only on terminal outcomes (lines 469-473); the queue-level `onRetry` notification and `retryTimers` bookkeeping are unchanged. `cancelled`/`timeout` categories stay terminal, so stop/timeout semantics are unaffected.

### D2 — Settle before dropping: teardown settles every in-flight request

`RequestQueue.clear()` settles each in-flight request **before** removing its map entry: invoke `request.onError(new RequestQueueError("Request queue cleared", "cancelled"))` and release the domain-limiter slot (`domainLimiter.completeRequest()`), then drop the entry. `RequestScheduler.clear()` settles its active entries through the same discipline (status `CANCELLED`, callbacks surfaced to the queue rather than silently dropped). The subsequent rejection of each aborted fetch hits the existing `failRequest`/`completeRequest` early-return — which now guarantees **no double settlement** instead of silently swallowing settlement.

- _Why synchronous settle-before-drop over "keep entries and let aborts flow":_ deterministic and testable — after `clear()` returns, every handler promise is already settled and every limiter slot released; the async path would leave a window where nothing owns the settlement.
- `clearDownload()`'s in-flight aborts already settle correctly (the map stays intact, rejections flow through `failRequest`) — no change there.
- The dropped-queued-requests settlement (existing lines 325-334) is kept as-is.

### D3 — Scheduler liveness under pause and failure

Two liveness fixes share one principle: the queue must always own a timer while schedulable work remains.

- `processQueue`'s `catch` logs (`console.warn`) and calls `scheduleProcessing()` — an internal throw can delay a cycle but never strand the scheduler. The dead `startedCount` is removed; the deferred-wait branch is made explicit as "nothing started and something deferred".
- `RequestScheduler` gains pause awareness: a `paused` flag gates `scheduleProcessing()`/`processQueue()` (the self-rescheduling 1 ms loop stops), `RequestQueue.pause()`/`resume()` forward to it, and `shutdown()` keeps its current stop-everything behavior. Resume restarts both the queue's and the scheduler's loops.

### D4 — Real wait on connection-pool saturation

`DomainLimiter.getWaitTime()` returns a small bounded backoff (on the order of 100 ms) when `activeConnections >= connectionPoolSize`, instead of 0. The queue's existing `nearestDomainWaitMs` min/max clamping (lines 588-591, 625-633) then schedules the next cycle at a real estimate, so a saturated pool costs one timer per backoff interval rather than a minimum-tick polling loop.

- _Why a fixed backoff over tracking per-connection start times:_ the pool drains as fetches settle (typically seconds), a coarse estimate is sufficient to stop the burn, and timestamp bookkeeping adds state the limiter does not otherwise need.
- `canMakeRequest()` and pool accounting are unchanged.

### D5 — Prove it with multi-request regression tests

Each fix lands with vitest coverage exercising full queue behavior with fake timers and a mock `fetch` (extending `tests/unit/request-queue.test.ts` / `tests/unit/domain-limiter.test.ts`, plus a focused new suite): transient-5xx retry-to-success (asset counted success, archived, exactly one fetch sequence, no post-settlement callbacks), retry exhaustion (`onError` exactly once after the last attempt), non-retryable 404 (immediate single `onError`), `clear()` with in-flight + queued requests (every handler promise settles once, limiter slots released, no orphan fetch), internal-throw rescheduling, paused-scheduler timer quiescence, and pool-saturation wait.

## Risks / Trade-offs

- [Deferring `onError` changes failure timing] → failures now surface after exhaustion (bounded by backoff × maxRetries). Progress UI already tracks per-attempt completion counts elsewhere; `onRetry` notifications are unchanged, so observers still see liveness.
- [A bug in the retry gate could hide real failures] → the gate is the same predicate already used for scheduling retries; exhaustion and terminal categories fall through to `onError` immediately. Regression tests pin both branches.
- [Settle-before-drop double-fires if an abort rejection races `clear()`] → settlement happens before the map entry is dropped; the early-return then makes the late rejection a no-op by construction (tested).
- [Pause gating could deadlock a paused queue if `resume()` is missed] → resume restarts both loops; `shutdown()` overrides pause exactly as today.
