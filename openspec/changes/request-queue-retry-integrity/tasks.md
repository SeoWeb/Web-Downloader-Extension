## 1. Retry owns the failure signal (`src/utils/RequestQueue.ts`)

- [ ] 1.1 In `failRequest()` (~947-972), compute the retry decision (`request.retryCount < maxRetries && isRetryableError(error)` — same predicate as the wrapped listener at ~459-474) and invoke `activeRequest.request.onError(error)` ONLY when the outcome is terminal; when a retry is scheduled, leave the handler pending
- [ ] 1.2 Verify the detached retry settles the handler through the existing paths: `retryRequest()` (~1029-1058) re-enqueues the same request object, so eventual success settles via `completeRequest()` → `onComplete` (~936-938) and exhaustion settles via the final attempt's `failRequest` → `onError` (retryCount === maxRetries is terminal)
- [ ] 1.3 Confirm single-settlement end to end: no path fires `onComplete`/`onError` twice for one request (handler promise settlers, wrapped `onComplete` dedup-cache write at ~450-457, scheduler stats); late completions into an already-settled handler cannot occur once 1.1 is in place
- [ ] 1.4 Preserve `retryTimers` tracking/cleanup unchanged: declaration (~152-155), timer set/delete in `retryRequest` (~1047-1057), cancellation in `clear()` (~311-317) and `clearDownload()` (~354-360)
- [ ] 1.5 Confirm terminal categories stay terminal: `cancelled` and `timeout` never schedule retries (never defer `onError`); non-retryable 4xx fails immediately on first attempt

## 2. Settle-before-drop teardown (`RequestQueue.clear()`, `RequestScheduler.clear()`)

- [ ] 2.1 In `RequestQueue.clear()` (~311-335), for each in-flight request BEFORE dropping the map: invoke `request.onError(new RequestQueueError("Request queue cleared", "cancelled"))` and release the domain-limiter slot via `DomainLimiterFactory.getLimiter(domain).completeRequest()`; then clear `activeRequests`
- [ ] 2.2 Keep the existing dropped-queued-requests settlement (~325-334) and the retry-timer cancellation (~312-317) unchanged
- [ ] 2.3 In `RequestScheduler.clear()` (~271-294), stop silently dropping active entries: mark them `CANCELLED` and settle them through the queue's teardown path (or return them alongside the queued list) so no dropped request lacks a settlement owner
- [ ] 2.4 Rely on the `failRequest`/`completeRequest` early-returns (~917-921, ~948-951) as the double-settlement guard for the aborted fetches' later rejections; add a comment stating that guarantee
- [ ] 2.5 Confirm `clearDownload()` needs no change: its in-flight aborts settle via the normal failure path (map intact) and limiter slots release through `failRequest` (~953-957)

## 3. `processQueue` liveness (`src/utils/RequestQueue.ts`)

- [ ] 3.1 Replace the dequeue-loop `catch { // Ignore }` (~599-601) with `catch (error) { console.warn(...); this.scheduleProcessing(); }` so an internal throw (from `getAdaptiveConcurrency()` ~564, `shouldThrottleRequest()` ~577, `DomainLimiterFactory.getLimiter()` ~586, `getNextRequest()` ~570) can never strand a non-empty scheduler
- [ ] 3.2 Remove the dead `let startedCount = 0;` (~555, never incremented) and make the deferred-wait branch explicit: schedule the limiter wait when nothing was started (`requestsToStart.length === 0`) and something was deferred (`deferredCount > 0`)

## 4. Pool-saturation wait (`src/utils/DomainLimiter.ts`)

- [ ] 4.1 In `getWaitTime()` (~88-107), return a small bounded backoff (~100 ms) when the connection pool is saturated (`activeConnections >= connectionPoolSize`), instead of falling through to `return 0`
- [ ] 4.2 Verify the queue consumes it via the existing `nearestDomainWaitMs` clamping (`RequestQueue.ts` ~588-591, ~625-633): a pool-blocked domain now schedules a real wait, not the `QUEUE_TICK_MS` minimum tick; `canMakeRequest()` and pool accounting (`startRequest`/`completeRequest`) unchanged

## 5. Pause-aware scheduler (`src/utils/RequestScheduler.ts`, `src/utils/RequestQueue.ts`)

- [ ] 5.1 Add a `paused` flag to `RequestScheduler`: gate `scheduleProcessing()` (~415-424) and `processQueue()` (~429-446) so the 1 ms self-rescheduling loop stops while paused; add `pause()`/`resume()` methods (`shutdown()` keeps clearing everything, overriding pause)
- [ ] 5.2 Forward from `RequestQueue.pause()`/`resume()` (~287-302) to the scheduler so both loops stop/restart together; `resume()` must restart processing of already-queued work

## 6. Regression tests (vitest, `tests/unit/`)

- [ ] 6.1 New `tests/unit/request-retry-integrity.test.ts` (fake timers + mock `fetch`, extending the patterns in `tests/unit/request-queue.test.ts`): transient 5xx on first attempt then success → `onComplete` fires exactly once, `onError` never fires, handler outcome is success (asset counted SUCCESS / failure tally 0), exactly one network fetch sequence (initial attempt + scheduled retry, no duplicate fetch after settlement)
- [ ] 6.2 Retry exhaustion: persistent 5xx with `maxRetries = N` → exactly N+1 fetch attempts and `onError` fires exactly once, after the final attempt
- [ ] 6.3 Non-retryable failure (404): `onError` fires exactly once, immediately on the first attempt, no retry fetch
- [ ] 6.4 `clear()` with in-flight requests + queued requests: every handler promise settles exactly once with a `cancelled`-category error; aborted fetches' late rejections cause no second settlement; domain-limiter `activeConnections` returns to 0; no further fetch is started (retry timers cancelled)
- [ ] 6.5 `processQueue` internal error: stub `getAdaptiveConcurrency` (or `DomainLimiterFactory.getLimiter`) to throw once → `scheduleProcessing()` still runs and queued requests proceed on a later cycle
- [ ] 6.6 Paused scheduler quiescence: `pause()` with queued work → zero scheduler timer callbacks in the observation window; `resume()` → queued requests process
- [ ] 6.7 Pool saturation: extend `tests/unit/domain-limiter.test.ts` — `getWaitTime()` > 0 when `activeConnections >= connectionPoolSize`; queue schedules a wait greater than the minimum tick while pool-blocked
- [ ] 6.8 Run the full suite (`npm test`: `tsc --noEmit && vitest run`) and fix fallout in existing queue/scheduler tests
