## Context

A server-mode download runs through three phases — scrape/upload, upload drain (`uploadQueue.waitForAll`), and finalize + assembly polling (`downloadWithFallback` → `pollAssemblyStatus`). Stop is wired through `SCRAPER_STOP` (`message.ts:339-343`) → `abortActiveDownload(tabId)` (`download-state.ts:86-94`), which aborts only the per-tab download controller. What that controller's abort actually stops depends on where the flow is, and today it is different in every place:

- **Main path, upload phase:** the abort listener (`download-core.ts:496-509`) only calls `uploadQueue.cancel()`. The `waitForAll` catch ("Queue may be cancelled — continue anyway", `:877-883`) then flows into `finalizeSession` + `status.complete` (`:902`, `:959`, `:1000`): a partial archive is delivered and reported as a **successful** download. This is documented as intended at `:878-880` — but the _status_ is a lie, and the user asked to stop, not to receive a partial result labeled complete.
- **Main path, assembly phase:** `pollAssemblyStatus` supports a caller signal (8th param of `downloadWithFallback`, `server-download.ts:389`; abort check at `:146`, abortable sleeps at `:175`/`:200`), and the main path passes `context.assemblyAbortController.signal` (`download-core.ts:947`) — but nothing ever aborts that controller (`download-state.ts:33,56`; no `.abort()` call anywhere). Stop during assembly does nothing.
- **Resume path, re-fetch phase:** the resume creates its own per-tab controller (`download-core.ts:1201-1205`) and cancels the queue on abort (`:1367`), but cancel is swallowed downstream: `enqueue()` throws (`upload-queue.ts:173-174`), the per-entry catch hides it (`:1389-1392`), the fetches ignore the signal (`:1377-1379`), and the emptied queue makes `waitForAll()` resolve (`upload-queue.ts:333-337` checks `isDone()` before `cancelled`). Net: Stop changes nothing except wasting minutes; the archive ships as `status.complete`.
- **Resume path, assembly phase:** both resume-side `downloadWithFallback()` calls (`:1125-1138`, `:1246-1264`) omit the signal parameter, so polling cannot be interrupted before a successful poll or the 35-minute cap (`server-download.ts:85`).
- **Resume path, wait failures:** the resume `waitForAll()` block has try/finally only (`:1397-1417`); a timeout or cancel rejection rethrows out of `resumeServerDownload` (`:1450`) and the caller reports a failed resume (`message.ts:313-326`) — unlike the main path, which catches and finalizes partial (`:877-883`).

Dependency: `upload-queue-terminal-reliability` fixes `waitForAll()`'s dead cancel-rejection (`upload-queue.ts:333-337` — `isDone()` is checked before `cancelled`, and `cancel()` always empties the maps, so post-cancel waits resolve instead of rejecting). This change consumes that fix: call sites can rely on a cancel producing an observable rejection.

Related vocabulary that already exists: the `status.cancelled` locale key ("Download was cancelled", `src/i18n/locales/en.json:143`), `status.serverDownloadReady` as an independent download-affordance message (`download-core.ts:989-998`), the AbortError rethrow in `downloadWithFallback` that deliberately skips the fallback offer (`server-download.ts:401-406`), and `AbortSignal.any` (manifest `minimum_chrome_version: 116`).

## Goals / Non-Goals

**Goals:**

- One stop contract, honored identically in every phase and on both paths (main + resume): stop interrupts in-flight work promptly and never terminates as `status.complete`.
- The user keeps what was already captured: the partial archive is surfaced when the server can produce it.
- Stop during assembly polling interrupts promptly (the polling sleep wakes on abort).
- A resume queue timeout/cancel finalizes partial data instead of failing the whole resume (parity with the main path).
- Checkpoint/resume semantics stay unambiguous: checkpoints mean "unintentional interruption", never "user stopped this".

**Non-Goals:**

- Cancelling server-side assembly — once finalize is sent, server work is committed; the extension only stops _its own_ work and opportunistically probes the outcome.
- Changing the upload queue's cancellation mechanics (owned by `upload-queue-terminal-reliability`).
- Changing the main path's finalize-partial behavior for NON-stop terminations (session-full, upload failures → completion with `failedCount`) — that contract stays.
- Progress reporting/UI layout beyond reusing existing message keys.

## Decisions

### D1 — Unified stop contract: interrupt, salvage, report `cancelled` (never `complete`)

Pressing Stop means: **stop waiting, keep what arrived, never dress the result up as success.** Concretely, in every phase:

1. **Interrupt:** the stop signal aborts all client-side work — handler fetches/scraping (scraping phase), the resume fetch/enqueue loop (resume re-fetch), the upload queue (upload drain), and assembly polling (assembly).
2. **Salvage:** after interruption the flow takes one cheap, bounded salvage step:
   - _Upload phase:_ send `scrapeComplete` if not yet sent, then `finalizeSession` with whatever arrived (both idempotent). No further uploads, no waiting on the queue beyond its immediate cancel-rejection.
   - _Assembly phase:_ a single `getSessionStatus` probe — if the archive is already `ready`, its URL is surfaced; if not, nothing further is polled.
3. **Report:** terminal status is always `status.cancelled` (the existing locale key), extended with the partial-archive `downloadUrl` when the server produced one (delivered as the existing `status.serverDownloadReady` affordance alongside `status.cancelled`, mirroring how the pair already coexist for success at `download-core.ts:989-1000`). A stop during scraping (nothing to salvage) reports plain `status.cancelled` — not `status.failedWithError`.

_Why not a hard abort that skips finalize:_ the server session already holds completed uploads; skipping finalize throws that away and orphans the session to retention cleanup — pure data loss, and for cloud sessions the pushed page would never appear. Salvage costs one idempotent request and preserves the main path's existing flow shape (finalize-after-cancel is already documented there), keeping the diff small. _Why `cancelled` instead of `complete`-with-partial:_ `status.complete` after Stop tells the user their intent was ignored; `cancelled` + an available partial archive tells the truth and still gives them the artifact. _Why not keep polling after stop:_ the user asked to stop waiting; a post-stop poll loop (even bounded) recreates finding 2's complaint. One immediate probe is not polling.

### D2 — Signal plumbing: two signals per download, both real

- **User-stop signal** (existing): main path `context.abortController`, resume path the per-tab controller from `download-core.ts:1203-1204`. Aborting it must: cancel the upload queue (existing listeners `:502-508`, `:1367`), abort the resume fetch loop (new — pass it into every fetch via `AbortSignal.any([stopSignal, AbortSignal.timeout(60_000)])`, check `stopSignal.aborted` before each iteration and after each enqueue, and break the loop on AbortError instead of swallowing it like per-resource failures), and **abort `assemblyAbortController`** (new listener next to the queue-cancel listeners at `:502-508`/`:1367`; the resume path gets its own assembly controller since it does not build a `DownloadContext`).
- **Assembly-poll signal** (existing but currently dead): `context.assemblyAbortController` on the main path, a fresh controller on the resume path. Passed as the 8th argument to `downloadWithFallback()` at BOTH resume-side call sites (`finalizeAndPollAssembly` gains a `signal` parameter; the assembling branch passes it directly). It aborts when the user stops (per above) or when the flow tears down, so `pollAssemblyStatus`'s abortable sleep (`server-download.ts:568-586`) wakes immediately.
- **Error discrimination:** AbortError is distinguished from real failures using the same convention `downloadWithFallback` already uses (`server-download.ts:401-406` rethrows AbortError without the fallback offer). Callers catch AbortError → salvage → `status.cancelled`; everything else keeps today's error paths. The resume fetch loop's per-entry catch must specifically NOT swallow the user-abort AbortError (it may skip individual failed resources as before).

### D3 — Cancel-rejection propagation: catch-and-continue on both paths, two distinct outcomes

- The resume path wraps its `waitForAll()` (`download-core.ts:1397-1417`) in the same catch-and-continue the main path has (`:877-883`): **any** rejection (timeout or cancel) proceeds to salvage/finalize instead of failing the resume.
- The terminal status then depends on WHY the wait ended:
  - _User-stop cancel-rejection_ → D1 contract: finalize partial, report `status.cancelled`.
  - _Non-stop timeout_ (or drained-with-failures) → today's semantics: finalize partial, report `status.complete` with `failedCount` (the resume already computes this at `:1422`). A flaky network must not relabel a user-visible success as a cancellation.
- **Dependency:** this contract is only fully observable once `upload-queue-terminal-reliability` makes `waitForAll()` reject on a cancelled queue (`cancelled` checked before `isDone()` at `upload-queue.ts:333-337`). Until then, a post-cancel wait resolves and the flow still finalizes + reports cancelled (the stop flag is observed independently of the rejection), so ordering of the two changes is safe either way — but the tests for cancel-rejection behavior gate on that fix.
- **Caller mapping (`message.ts:313-326`):** an AbortError escaping `resumeServerDownload` is user intent — report `status.cancelled`, clear the checkpoint, and do NOT offer Retry/Resume (a stopped download must not resurface as an interruption prompt). Other errors keep today's definitive/transient handling.

### D4 — Checkpoints and stop are disjoint concepts

`clearCheckpoint` stays unconditional in the main-path finally (`download-core.ts:435-437`) and is additionally invoked on the resume-stop path (D3). Checkpoints/`markSessionLive` remain exclusively the service-worker-death recovery mechanism; a deliberately stopped download leaves no Resume affordance. The salvage step needs no checkpoint: `finalizeSession`/`getSessionStatus` are session-addressed and idempotent.

## Risks / Trade-offs

- [Stop during upload now spends one finalize round-trip + one probe instead of exiting instantly] → accepted: it is what delivers the partial archive; both requests are cheap and idempotent.
- [A partial archive may not exist at probe time (server still assembling) → no URL offered] → accepted: the server completes it within retention (cloud pushes still land in PagePocket); forcing the extension to poll would violate the prompt-interrupt contract.
- [D1 changes main-path behavior from "complete" to "cancelled" after a stop] → this is the point of the change; the `failedCount`-bearing complete stays for all non-stop terminations, so no legitimate success is relabeled.
- [Resume timeout previously surfaced as an error the panel could Retry] → now it finalizes partial like the main path; a retry of the _session_ is meaningless once finalized, so this is strictly better than today's dead-end error.
- [Two signals per download can drift apart] → both are created/wired in one place per path and aborted by the same stop listener; teardown aborts the assembly controller so no poll can outlive its flow.
