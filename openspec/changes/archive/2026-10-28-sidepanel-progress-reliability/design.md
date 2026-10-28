## Context

The extension has a single side panel whose message plumbing predates the multi-tab, MV3-suspend-aware architecture:

- **Routing by live tab.** `SidePanel` keeps `tabId` in state, and `useActiveTabInfo` (`src/sidepanel/hooks/useActiveTabInfo.ts:135–152`) re-pins it on every `tabs.onActivated`/`onUpdated`. Every handler in `messageWorker` (`src/sidepanel.tsx:168, 258, 263, 270, 285, 299, 322, 345`) drops messages whose `data.tabId` differs from that live value, and the chrome.storage completion fallback compares against it too (~460–464). The scroll loop already solved this class of bug for _outgoing_ traffic: Fix A pinned a press-time tab snapshot (`useScrapingDownloader.ts:231–266`) after the "one press → five sessions" incident. Incoming traffic never got the same treatment.
- **Resume arms the scrape Effect.** `onRestartDownload` (`src/sidepanel.tsx:670–724`) sets `isScraping(true)` before sending `RESUME_SERVER_DOWNLOAD`. Effect 1 (`useScrapingDownloader.ts:513–526`) treats any false→true transition as a fresh press: it resets the single-fire gate and calls `scrape()`, which creates a NEW server session (`SERVER_CREATE_SESSION`, ~344–384) and scrolls the tab while the background separately replays the checkpoint into the original session. Because `DOWNLOAD_INTERRUPTED` (`src/sidepanel.tsx:361–383`) resets `downloadResponse` but not `downloadOptions`, Effect 2 (~537–609) still sees a "completed run with options" and can fire a second full `START_DOWNLOAD` when `isScraping` falls.
- **Heartbeats without a listener.** `download-core.ts` emits `status.uploadProgress` every 15 s during upload waits (~849–861 fresh flow, ~1395–1416 resume flow) with the comment "so the UI can detect a dead worker". Grep of `src/sidepanel*` finds no consumer. MV3 workers are killed after ~30 s idle; if that happens mid-wait, the panel freezes on the last frame.
- **Lifecycle gap.** `performStartupCleanup()` (`src/background/cleanupHandlers.ts:222–282`) — which detects `isDownloadInProgress`, reads checkpoints, and pushes `DOWNLOAD_INTERRUPTED` to the panel — is registered ONLY on `self.addEventListener("activate", …)` (~77–80). MV3 `activate` fires on install/update only; a warm-killed worker woken by any event runs top-level module code but never `activate`, so interrupted-download handling is skipped. (There is no `chrome.runtime.onStartup` path in the current source — the exemplar task description's mention of one is stale.)
- **Shared debounce timer.** `sendMessage` (`src/common/chrome.ts:65–91`) uses one module-level `let i` timer for all non-force calls; a second non-force call within ~1 s cancels the first caller's pending send, whose promise then never settles. All `download-listener.ts` terminal pushes use `force=false` (COMPLETE ~29–43, CANCELLED ~74–83 and ~150–159, FAILED ~90–100); only COMPLETE has a `chrome.storage.local` fallback (~16–26), consumed by the panel's storage listener.
- **Fire-and-forget pushes.** `download-core.ts` wires `uploadQueue.onProgress` (~513–523), `onSessionFull` (~527–536), and both heartbeats to a `sendMessage` callback that (via `listenMessage`'s `addMessage`, `src/common/chrome.ts:113–115`) reaches `sendMessageToPanel` with `force=true`. With the panel closed, `chrome.runtime.sendMessage` rejects ("Receiving end does not exist") and nobody handles it → unhandled rejections in the service worker.

Test infrastructure: vitest (`tests/unit/*.test.ts(x)`, `npm test` = `tsc --noEmit && vitest run`).

## Goals / Non-Goals

**Goals:**

- Terminal download states (complete / failed / cancelled / interrupted / server error) always resolve the panel's in-progress UI, regardless of which tab is active.
- Exactly one download flow per user action: one resume click → exactly one server flow, zero new sessions from the resume path.
- A dead service worker is detected by the panel within a bounded time and surfaced through the existing interrupted-download card.
- Interrupted-download handling runs on every service-worker wake after a mid-download kill.
- No terminal message is silently dropped by the send debounce or by a closed panel; background pushes never produce unhandled rejections.
- Pause/Resume/Stop controls always target the download's own tab.

**Non-Goals:**

- No redesign of the Fix A outgoing-traffic pinning (it works; resume reuses the same pattern).
- No server-side changes (heartbeat cadence, session semantics, checkpoint format stay as-is).
- No multi-download UI (the panel continues to track one download at a time; concurrent downloads from other tabs remain out of scope).
- No new watchdog for the scraping phase (scroll steps are panel-driven, so the panel already notices silence there via its own loop).
- No persistent notification system beyond the existing interrupt card + `CHECK_INTERRUPTED_DOWNLOAD` discovery on panel open.

## Decisions

### D1 — Route messages by download identity, not the live active tab

The panel pins a **download identity** when a flow starts: `{ originTabId, serverSessionId }` — originTabId from the press-time snapshot (same value Fix A already pins for outgoing traffic; serverSessionId from `SERVER_CREATE_SESSION`/resume). `messageWorker` compares incoming `data.tabId` (and, where present, `options.serverSessionId`) against the pinned identity instead of live `tabId` state. Rules:

- **Progress messages** (`PANEL_MESSAGE`, `PAGEPOCKET_*`) apply only when they match the tracked download — cross-download interference stays filtered.
- **Terminal messages** (`DOWNLOAD_COMPLETE`, `DOWNLOAD_FAILED`, `DOWNLOAD_CANCELLED`, `DOWNLOAD_INTERRUPTED`, `status.serverError`) are always evaluated; when they match the tracked download they resolve the UI even if the user is on another tab (this is the fix — the current guard drops them precisely because the live tab moved).
- **Storage fallback** uses the same pinned identity.
- **Controls:** `DownloadStatus` receives the pinned origin tab (not live `tabId`) so `SCRAPER_PAUSE`/`SCRAPER_RESUME` (and Stop, already pinned via `targetRef`) act on the download's own tab.

- _Why:_ the background already tags pushes with the download's origin tabId (`listenMessage` attaches the incoming message's tabId), so the identity is available at no protocol cost; live-tab filtering was only ever correct when the panel happened to still be looking at the download's tab.
- _Alternative:_ strip tabId filtering entirely (terminal "broadcast") — rejected: two concurrent downloads would then cross-resolve each other's UI.

### D2 — Resume never scrapes; one flow per user action

`onRestartDownload` MUST NOT flip `isScraping` for the resume path. It sends `RESUME_SERVER_DOWNLOAD` and tracks the outcome in a dedicated resume state — no `setIsScraping(true)`, hence Effect 1 never starts `scrape()`, never creates a session, never scrolls. Guards:

- The resume click path is excluded from Effect 2's auto-`START_DOWNLOAD` (the existing `downloadStartedRef` single-fire gate pattern, `useScrapingDownloader.ts:231–266`, is mirrored: a resume run is not a scrape run).
- The `DOWNLOAD_INTERRUPTED` handler clears `downloadOptions` (like it already clears `downloadResponse`), so a stale options object cannot re-arm Effect 2 later.
- The resume-failure fallback ("full restart") may legitimately start a scrape — but exactly one: it goes through the same single-run gate as a fresh press.

- _Why:_ resume's whole point is reusing the existing server session; the current code re-enters the scrape pipeline and races it against the background resume, producing duplicate sessions and a hijacked tab.

### D3 — Watchdog thresholds: 3 missed 15 s heartbeats (≈45 s)

While `serverModeState.phase` is `uploading` or `assembling`, the panel arms a watchdog: **any** received message belonging to the tracked download (progress push, heartbeat `status.uploadProgress`, `status.assemblyProgress`, terminal) resets a timer; **45 s of silence** (3 missed 15 s heartbeats — margin above the 15 s cadence and above MV3's ~30 s idle kill) transitions the panel to the interrupted state: same `interruptData` card, same `status.downloadInterrupted` copy, same Resume/Restart actions as `DOWNLOAD_INTERRUPTED`. The watchdog disarms on any terminal state, on a new download, and whenever no download is in progress. The background heartbeat cadence (15 s) is unchanged.

- _Why 45 s:_ 2× the heartbeat period tolerates one lost message; it is also comfortably above the ~30 s MV3 idle kill, so detection is fast but cannot false-positive on a single dropped push.
- _Alternative:_ panel-side polling of `CHECK_DOWNLOAD_LIVE` — rejected as primary (adds traffic and still depends on a live worker to answer); kept as a possible secondary confirmation later.

### D4 — Per-call send timers + storage fallback for ALL terminal messages

`sendMessage` (`src/common/chrome.ts`) drops the shared module-level timer: each non-force call owns its timer (e.g. a small per-call closure or WeakMap keyed by call), so one caller's debounce can never cancel another's pending send, and every promise settles. Additionally, `download-listener.ts` writes `chrome.storage.local` fallback records for `DOWNLOAD_CANCELLED` and `DOWNLOAD_FAILED` (mirroring the existing `downloadComplete` record, ~16–26), and the panel's `storage.onChanged` handler is extended to consume them — so a terminal state survives both a cancelled push and a closed panel (rediscovered when the panel reopens / storage fires).

- _Why storage fallback for terminal only:_ progress frames are ephemeral by design; a lost progress frame self-corrects with the next one, but a lost terminal frame strands the UI forever.

### D5 — Startup cleanup on first wake, not on `activate`

`initializeCleanupHandlers()` (which already runs at module import on every worker start, `cleanupHandlers.ts:361–363`) additionally triggers `performStartupCleanup()` once per worker lifetime behind an idempotent guard (the existing `handlersInitialized` pattern). The `activate` registration is kept (fresh installs/updates still fire it) but becomes redundant rather than load-bearing. `performStartupCleanup`/`handleInterruptedDownload` are already safe to run when nothing was interrupted (they check `isDownloadInProgress` first) and already push `DOWNLOAD_INTERRUPTED` to a connected panel — so a warm wake now delivers the frozen card the panel was missing. Repeated wakes each run the guard fresh (once per lifetime of that worker instance), and the underlying operations are idempotent (flag cleared, checkpoints cleared only when delivered).

### D6 — Push helpers catch-and-ignore delivery failures

The push call sites in `download-core.ts` (`uploadQueue.onProgress`, `onSessionFull`, both heartbeats) wrap the fire-and-forget send so rejections are caught and logged at debug level (mirror `listenMessage`'s existing catch, `src/common/chrome.ts:117–135`). A failed push NEVER affects the download pipeline. Combined with D4's storage fallbacks, a push that fails because the panel is closed is recovered through storage / `CHECK_INTERRUPTED_DOWNLOAD` on reopen.

## Risks / Trade-offs

- [Pinned identity vs. legacy messages without tabId] → messages with `data.tabId === undefined` (e.g. some resume-path pushes) are treated as belonging to the tracked download; terminal interrupts from cleanup already arrive unscoped by design.
- [Watchdog false positive on a long GC pause or transient event-loop stall] → 45 s gives 3 heartbeat periods of margin; the interrupt card is recoverable (Resume), so a rare false positive costs one click, versus the current infinite spinner.
- [Per-call timers remove the debounce's coalescing] → the coalescing had no legitimate consumer (all terminal pushes are distinct messages that must all be delivered); per-call timers restore intended semantics. Overlap risk is covered by the "two rapid terminal sends both delivered" test.
- [First-wake cleanup runs more often than `activate` did] → it is guarded once per worker lifetime and its body is already idempotent (`isDownloadInProgress` check, deliver-or-keep checkpoints); the extra cost on ordinary wakes is one `chrome.storage.local.get`.
- [Clearing `downloadOptions` on interrupt] → the restart fallback path re-reads the options it needs before clearing; Effect 2 loses the ability to auto-fire after an interrupt, which is exactly the defect being removed.

## Migration Plan

1. Land panel-side fixes (D1–D3, D6-panel consumers, D4 storage consumer) and background fixes (D4 fallbacks, D5 wake cleanup, D6 catches) in the same release — the watchdog (D3) assumes the heartbeat that already exists, and D5 assumes the checkpoint/discovery path that already exists.
2. No data migration; storage keys are additive (`downloadCancelled`, `downloadFailed` fallback records).
3. Rollback = previous extension build; no server or storage-format dependencies.

## Open Questions

- None blocking.
