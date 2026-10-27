---
name: find-code-problems
description: Hunt for bugs in this codebase using the multi-agent parallel audit method that found the upload-queue stall family (Oct 2026). Use when the user asks to find problems, bugs, or defects in the code, review code for issues, verify an external bug report (email / scanner output / user report), or asks "is this bug real?".
---

# Find Code Problems

Read-only audit discipline: an audit **never modifies source code**. Findings go to the user (and, if asked, into OpenSpec changes). The main agent stays in PM mode — every audit step below is executed by delegating to subagents (max 5 concurrent).

## Step 1 — Verify external bug reports against the code FIRST

When handed a bug report from outside (email, scanner, another tool, user paste), do **not** assume it is real or spam. Dispatch one `explore` subagent to confirm or refute it with exact file:line evidence, trigger path, and downstream consequences. Real products (e.g. Perch Scan) email genuine findings as marketing hooks — the only test is the code. Report the verdict ("real product, real bug" / "real product, bogus finding") with evidence.

## Step 2 — Parallel, area-scoped delegation

Split the codebase into 3–5 non-overlapping areas and run one subagent per area simultaneously:

1. **Core async queues / state machines** (e.g. `src/background/upload-queue.ts`, `download-core.ts`)
2. **Server backend** (`server/app/**` — routes, services, rate limiters, lifecycle)
3. **Extension messaging / UI / MV3 lifecycle** (content scripts, sidepanel, service worker, ports)
4. **Cross-cutting async-pattern sweep** (whole repo, grep-driven: waiters, catch blocks, timers, maps)
5. _(optional)_ Whatever the codebase layout suggests

Give every agent the **same output contract**: each finding needs exact file + line numbers, short excerpt, concrete trigger condition, consequence, severity (high/medium/low), confidence (certain/likely/possible). Demand **explicit clean-area statements** so silence is meaningful. Ban style nits and speculation without a trigger path.

## Step 3 — Seed every prompt with a verified reference pattern

Include one **confirmed** bug (mechanism + file:line) in each agent's prompt: "a verified bug of this class is X — find more of this class." Concrete seeds dramatically raise recall. Known seeds from the 2026-10 audit (keep updated as fixes land):

- Terminal paths in `upload-queue.ts` released the active slot but skipped `scheduleProcessing()` / `notifyProgress()` → queue stalls, waiters time out, archive assembles incomplete.
- `RequestQueue` retry: `onError` fired on first failure while a detached retry still ran → assets counted failed despite successful retry.

## Step 4 — The defect-class checklist (put relevant classes in every prompt)

- **Missing "kick" on a terminal path**: state changes (slot released, counter bumped, status set) but the required reschedule / notify / waiter-resolve / counter-update is skipped on _some_ exit paths only. Compare ALL terminal paths of a state machine side by side.
- **Waiters that can wait forever**: every `await` resolved by callback/event — check each resolution path is reachable from each terminal mode (success, each failure class, abort, timeout).
- **Dead/unreachable guards**: conditions that can never be true due to earlier code (e.g. `isDone()` checked before `cancelled` when cancel always empties the queue); wrong check order.
- **Success reported before durability**: HTTP 200 sent before DB commit (dependency-teardown commits), counters advanced before the operation resolves, `scrollIndex++` as an argument evaluated before the awaited call.
- **Cleanup asymmetry**: resources acquired without try/finally release; Maps/dicts pruned on success paths only; blob URLs / timers / listeners / asyncio tasks leaked on failure paths.
- **Swallowed errors**: empty `catch` / bare `except`, log-and-continue that also skips state cleanup or rescheduling; errors swallowed such that a _later_ failure mode stalls instead of failing fast.
- **Stop/cancel semantics**: abort signals created but never `.abort()`ed; cancel exceptions swallowed by broad catches so loops keep working; flows proceeding to finalize/complete after cancel; cancel-rejection dead code.
- **Retry systems defeated**: failure callback fired while a detached retry still runs (result lands in a settled promise); retries that never rescue the artifact.
- **Timers / backoff**: uncleared `setTimeout` handles, uncapped server-supplied `Retry-After`, bare `setTimeout` reliance in MV3 service workers (worker may be reaped mid-sleep), `create_task` results dropped.
- **Races**: check-then-write without re-check after await (TOCTOU), upload-vs-finalize races, listener resolved by any event instead of the matching one (unfiltered tab "complete").
- **UI stranding**: message filters (tabId guards) that drop terminal states; watchdog/heartbeat that is sent but never consumed; cleanup wired to lifecycle events that don't fire in MV3 (`activate` vs `onStartup`); shared module-level debounce timers cancelling concurrent sends.
- **Server honesty**: silent partial success (skip-with-warning then mark `ready`, deficit only logged); limiter budget burned on dedup'd calls; huge `Retry-After` the client ignores; unbounded request bodies; per-process singletons assumed global (multi-worker latent).

## Step 5 — Dedupe, synthesize, prioritize

Overlapping findings across agents are expected — merge them (keep the most precise file:line). Produce:

1. A prioritized table (high / medium / low) grouped by defect class, each row: bug → file:line → consequence.
2. A fix-wave plan: small high-value correctness fixes first, semantics next, hangs, server honesty, low batch last — with a suggested regression-test gap list (audits of this codebase found all queue tests were single-task, which is why the stalls slipped through).

## Step 6 — Turn findings into OpenSpec changes (when asked)

Cover **every** finding, including low ones. Group by area into multiple changes (e.g. queue reliability / stop-cancel semantics / hang elimination / UI messaging / retry integrity / server honesty), each mapping findings to existing `openspec/specs/*` capabilities. Follow `openspec-propose` conventions and validate with `openspec validate <change> --strict`.
