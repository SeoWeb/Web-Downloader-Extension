## Why

A 2026-10 multi-agent audit of the asset-fetch pipeline (`src/utils/RequestQueue.ts`, `src/utils/RequestScheduler.ts`, `src/utils/DomainLimiter.ts`) confirmed five defects. The most serious: the retry system is defeated. `RequestQueue.failRequest()` invokes the request's `onError` unconditionally, even when the retry logic has just scheduled a detached retry for a transient failure. Every file handler (images, CSS, JS, documents) settles its handler promise on the first `onError`, so a retried asset is recorded as failed — missing from the archive and counted in `resourcesFailed` — even though the detached retry later re-fetches it successfully into an already-settled promise. Retries never actually rescue an asset into the archive; they only burn bandwidth and pollute the dedup cache.

The remaining defects make the scheduler unreliable or wasteful: `clear()` strands in-flight settlement (latent today behind a gate, but a trap for any future caller), `processQueue`'s catch-and-ignore can strand the queue until an unrelated event, `DomainLimiter.getWaitTime()` returns 0 on connection-pool saturation so the queue polls at its minimum tick, and `pause()` does not stop the scheduler's 1 ms self-rescheduling loop.

## What Changes

- **Retry owns the failure signal:** `failRequest()` invokes `request.onError` only when the request is terminally failed (non-retryable, retries exhausted, cancelled, or timed out). When a retry is scheduled, the handler is not settled; the re-enqueued retry carries the same `onComplete`/`onError` callbacks, so its final outcome (resolve on retry success, `onError` after exhaustion) settles the handler exactly once. Existing `retryTimers` tracking/cleanup (`clear()` / `clearDownload()`) is preserved.
- **Settle-before-drop teardown:** `RequestQueue.clear()` and `RequestScheduler.clear()` settle every in-flight request (`onError` with a `cancelled`-category error, domain-limiter slot released) before dropping their tracking maps, instead of aborting the fetches and silently dropping the entries their later rejections would settle through.
- **Queue liveness after internal errors:** `processQueue`'s dequeue-loop `catch` logs and calls `scheduleProcessing()` instead of ignoring, so an internal throw can no longer strand a non-empty scheduler; the dead `startedCount` variable is removed and the deferred-wait condition made explicit.
- **Real wait on pool saturation:** `DomainLimiter.getWaitTime()` returns a real estimated wait (small bounded backoff) when the connection pool is saturated, instead of 0 — the queue then waits instead of polling at its minimum tick until a slot frees.
- **Pause-aware scheduler:** pausing the queue stops the scheduler's 1 ms self-rescheduling loop (not only the queue's own timer); resume restarts processing. Only `shutdown()` stops the loop today.

## Capabilities

### New Capabilities

(none — all requirements land in the existing `download-fetch-pipeline` capability)

### Modified Capabilities

- `download-fetch-pipeline`: retry integrity (a retried request that eventually succeeds is never reported failed; `onError` fires at most once, after the final attempt); teardown settles every in-flight handler promise; the queue reschedules after internal errors; a paused queue performs no busy work; and the fair-scheduling wait computation is extended to connection-pool saturation.

## Impact

- **Code:** `src/utils/RequestQueue.ts` (`failRequest`, `clear`, `processQueue`), `src/utils/RequestScheduler.ts` (`clear`, pause gating of the processing loop), `src/utils/DomainLimiter.ts` (`getWaitTime`).
- **Behavior:** retried assets that succeed are archived and counted as success (previously: recorded failed); `onError` is deferred to the terminal outcome; `clear()` during in-flight fetches settles handler promises instead of hanging them and no longer leaks domain-limiter connection slots; paused queues stop consuming timers.
- **No interface changes:** the handler-facing `onComplete`/`onError` contract, retry classification (`isRetryableError`), request options, manifest, storage, and server APIs are unchanged.
- **Tests:** `tests/unit/request-queue.test.ts`, `tests/unit/domain-limiter.test.ts`, and a new focused suite (retry integrity, teardown settlement, liveness, pause) under `tests/unit/`.
