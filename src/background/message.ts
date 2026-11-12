import { sendMessage } from "../common/chrome";
import { MessageAction, messageActions } from "../common/message";
import { scrollDownAndScrape, startDownload } from "./jobs";
import { pauseScraping, resumeScraping, stopScraping } from "./scraper-state";
import {
  abortActiveDownload,
  buildLiveSnapshot,
  isSessionLive,
} from "./download-state";
import {
  readCheckpoint,
  readAllCheckpoints,
  clearCheckpoint,
} from "./download-checkpoint";
import {
  readScraperSnapshot,
  readAllScraperSnapshots,
  clearScraperSnapshot,
} from "./scraper-snapshot";
import {
  resumeServerDownload,
  resumeFromParkedScrape,
  finalizeParkedDownload,
} from "./download-core";
import {
  serverClient,
  ServerUnavailableError,
  AuthenticationError,
} from "./server-client";
import { launchGoogleSignIn, GoogleSignInError } from "./google-auth";

interface ServerSessionState {
  sessionId: string | null;
  scrollIndex: number;
}

const serverSessionStates = new Map<number, ServerSessionState>();

function getServerSessionState(tabId: number): ServerSessionState {
  let state = serverSessionStates.get(tabId);
  if (!state) {
    state = { sessionId: null, scrollIndex: 0 };
    serverSessionStates.set(tabId, state);
  }
  return state;
}

export function deleteServerSessionState(tabId: number): void {
  serverSessionStates.delete(tabId);
}

/**
 * Create a server session and optionally store it as the active session.
 * Shared by INITIALIZE_DIFFERENTIAL_SCRAPING and SERVER_CREATE_SESSION
 * to avoid duplicating session-creation logic.
 */
async function createServerSession(
  url: string,
  options:
    | {
        singleFile?: boolean;
        downloadContentAsMarkdown?: boolean;
        downloadHtml?: boolean;
        downloadContentAsText?: boolean;
        retentionDays?: number;
      }
    | undefined,
  tabId: number,
  setActive: boolean = true,
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  try {
    const sessionId = await serverClient.createSession(url, options);
    if (setActive) {
      setActiveServerSession(tabId, sessionId);
    }
    return { success: true, sessionId };
  } catch (error) {
    if (error instanceof ServerUnavailableError) {
      return { success: false };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Set the active server session ID for HTML chunk uploads during scrolling.
 * Called by download-core.ts when a server session is created.
 */
export function setActiveServerSession(
  tabId: number,
  sessionId: string | null,
): void {
  const state = getServerSessionState(tabId);
  state.sessionId = sessionId;
  state.scrollIndex = 0;
}

/**
 * Get the active server session ID (if any).
 * Used by selectStorageAdapter to reuse a session created during
 * INITIALIZE_DIFFERENTIAL_SCRAPING instead of creating a new one.
 */
export function getActiveServerSessionId(tabId: number): string | null {
  return serverSessionStates.get(tabId)?.sessionId ?? null;
}

/**
 * Check whether HTML chunks have been uploaded during the scrolling phase.
 * Used by executeDownloadServerMode (download-core.ts) to skip the
 * initial HTML upload when chunks have already been streamed to the
 * server via SCROLL_AND_EXTRACT_DIFF or SERVER_UPLOAD_HTML_CHUNK
 * during scrolling (task 13.3).
 */
export function hasStreamedHtmlChunks(tabId: number): boolean {
  const state = serverSessionStates.get(tabId);
  return (
    state !== undefined && state.sessionId !== null && state.scrollIndex > 0
  );
}

export async function sendMessageToPanel(
  action: MessageAction,
  data: any,
  force: boolean = true,
  tabId?: number,
) {
  const payload = tabId !== undefined ? { ...data, tabId } : data;
  return await sendMessage(
    "side-panel",
    {
      action,
      data: payload,
    },
    force,
  );
}

type Message = {
  action: MessageAction;
  data: any;
};

/**
 * Decide whether a resume failure is DEFINITIVE (expired/invalid session —
 * retrying can never succeed) as opposed to transient (network unavailable,
 * server unreachable). D10 / task 4.6: the checkpoint is cleared only on
 * definitive failure; transient failures keep it so recovery can be retried
 * after the panel is closed and reopened.
 */
export function isDefinitiveResumeFailure(err: unknown): boolean {
  // Invalid credentials / registration failures cannot recover by retrying
  if (err instanceof AuthenticationError) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    /cannot be resumed/i.test(msg) || // "Server session is failed/expired…"
    /full restart required/i.test(msg) || // no session data to resume from
    /No server session ID in checkpoint/i.test(msg)
  );
}

/**
 * (stop-cancel-semantics D2) AbortError discriminator — local copy of the
 * convention used by downloadWithFallback (server-download.ts) and
 * download-core's isAbortError: a DOMException/Error named "AbortError" is
 * a user cancellation, not a failure. AbortSignal.timeout() rejects with
 * "TimeoutError" and correctly does NOT match.
 */
function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

// ---------------------------------------------------------------------------
// Parked downloads (multipage-download-fixes D2 / tasks 4.4–4.5)
// ---------------------------------------------------------------------------

/** A parked download's recovery state: the frozen scrape snapshot plus the
 *  phase-`paused` checkpoint (for tab/tabUrl context). */
interface ParkedContext {
  snapshot: NonNullable<Awaited<ReturnType<typeof readScraperSnapshot>>>;
  checkpoint: Awaited<ReturnType<typeof readCheckpoint>>;
}

/**
 * Resolve a parked download's state. Precedence: explicit serverSessionId,
 * then the checkpoint/snapshot matching the given tab id. Deliberately
 * session- or tab-scoped — a lookup that matches NEITHER returns null so one
 * tab's Stop can never finalize another tab's parked download. Returns null
 * when nothing is parked (or the snapshot is missing/corrupt — callers fall
 * back cleanly to an offer of Stop).
 */
async function findParkedContext(
  serverSessionId?: string,
  tabId?: number,
): Promise<ParkedContext | null> {
  // 1. Explicit session id → read that download's snapshot directly.
  if (serverSessionId) {
    const snapshot = await readScraperSnapshot(serverSessionId);
    if (snapshot) {
      return { snapshot, checkpoint: await readCheckpoint(serverSessionId) };
    }
    return null;
  }
  if (tabId === undefined) {
    return null;
  }

  // 2. Tab-scoped match — the panel's paused card carries the checkpoint's
  //    tabId; the snapshot is keyed by the same session that checkpoint
  //    names.
  const snapshots = await readAllScraperSnapshots();
  if (snapshots.length === 0) return null;

  const snapshotForTab = snapshots.find((s) => s.tabId === tabId);
  if (snapshotForTab) {
    return {
      snapshot: snapshotForTab,
      checkpoint: snapshotForTab.serverSessionId
        ? await readCheckpoint(snapshotForTab.serverSessionId)
        : null,
    };
  }

  // Fallback: a paused checkpoint names this tab but the snapshot lookup by
  // its session id is the authoritative pairing.
  const checkpoints = await readAllCheckpoints();
  const byTab = checkpoints.find(
    (c) => c.phase === "paused" && c.tabId === tabId && c.serverSessionId,
  );
  if (byTab?.serverSessionId) {
    const snapshot = await readScraperSnapshot(byTab.serverSessionId);
    if (snapshot) {
      return { snapshot, checkpoint: byTab };
    }
  }
  return null;
}

/**
 * Clear a parked download's recovery state (snapshot + checkpoint). Used on
 * successful park-resume, deliberate park-stop, and definitive failure —
 * mirroring the RESUME_SERVER_DOWNLOAD retention rules.
 */
async function clearParkedState(serverSessionId: string): Promise<void> {
  await clearScraperSnapshot(serverSessionId);
  await clearCheckpoint(serverSessionId);
}

export async function messageWorker(
  action: MessageAction,
  data: any,
  addMessage: (message: Message) => void,
): Promise<any> {
  if (!messageActions) {
    throw new Error("messageActions is not defined");
  }

  switch (action) {
    case messageActions.START_SCROLL:
      return await scrollDownAndScrape(data.tabId);

    case messageActions.START_DOWNLOAD:
      return await startDownload(
        data.html,
        data.tabUrl,
        data.downloadOptions,
        (message: string | { key: string; options?: any }) =>
          addMessage({
            action: messageActions.PANEL_MESSAGE,
            data: { message },
          }),
        data.tabId,
      );

    case messageActions.INITIALIZE_DIFFERENTIAL_SCRAPING:
      // Initialize differential scraping and return assembly job ID
      const assemblyJobId = `assembly-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      try {
        if (data.tabUrl) {
          const result = await createServerSession(
            data.tabUrl,
            {
              singleFile: data.downloadOptions?.singleFile ?? false,
              downloadContentAsMarkdown:
                data.downloadOptions?.downloadContentAsMarkdown ?? false,
              // text-native-downloads 6.1: forward the full format
              // selection alongside singleFile/markdown.
              downloadHtml: data.downloadOptions?.downloadHTML ?? true,
              downloadContentAsText:
                data.downloadOptions?.downloadContentAsText ?? false,
              retentionDays: 1,
            },
            data.tabId,
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
        }

        return {
          success: true,
          assemblyJobId,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.SCROLL_AND_EXTRACT_DIFF:
      // Upload HTML chunk to the server session.
      try {
        if (data.tabId) {
          const sessionState = getServerSessionState(data.tabId);
          if (sessionState.sessionId) {
            // (D3 / task 3.1) Success-only counter advance, mirroring the
            // SERVER_UPLOAD_HTML_CHUNK pattern: evaluate the chunk index
            // WITHOUT incrementing, await the upload, advance only on
            // success. The old `sessionState.scrollIndex++` argument
            // incremented BEFORE the await resolved, so a failed upload
            // (retries exhausted) still counted as streamed —
            // hasStreamedHtmlChunks() went true and download-core skipped
            // the chunk-0 "main" initialization upload, finalizing a
            // session with no main-page HTML.
            const chunkIndex = sessionState.scrollIndex;
            await serverClient.uploadHtmlChunk(
              sessionState.sessionId,
              data.htmlChunk,
              chunkIndex,
              "main",
              // Do NOT send pageUrl for main pages — the server uses the
              // absence of pageUrl to set page_url_hash="main", which the
              // assembler looks up as merge_results.get("main").
              undefined,
            );
            // Advance on SUCCESS only. Math.max keeps the counter monotonic
            // (server "next index" semantics, same as the explicit-index
            // path) even if a concurrent writer moved it forward.
            sessionState.scrollIndex = Math.max(
              sessionState.scrollIndex,
              chunkIndex + 1,
            );
          }
        }
        return {
          success: true,
          assemblyJobId: data.assemblyJobId,
          chunkProcessed: true,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.CHECK_ONLINE_STATUS:
      return true;

    case messageActions.CHECK_INTERRUPTED_DOWNLOAD: {
      // Don't clear the checkpoint here — RESUME_SERVER_DOWNLOAD needs it.
      // The sidepanel reads checkpoint data to populate interruptData, but the
      // actual checkpoint must persist so resume can access resourceUrls etc.
      // (D4) readCheckpoint() returns the newest per-download checkpoint when
      // no session id is given.
      return await readCheckpoint();
    }

    case messageActions.DISMISS_INTERRUPTED_DOWNLOAD: {
      // User dismissed the interrupt UI without resuming — clear the checkpoint
      // so re-opening the panel doesn't show stale interrupt state.
      // (D4 + Fix D.2) Clears ONLY the targeted download's checkpoint when
      // the panel provides its session id. With no id, the panel must pass
      // `all: true` explicitly — a bare undefined no longer wipes every
      // checkpoint (a concurrent download's checkpoint must survive).
      if (data?.serverSessionId) {
        await clearCheckpoint(data.serverSessionId);
      } else if (data?.all === true) {
        await clearCheckpoint(undefined, { all: true });
      } else {
        console.warn(
          "[Dismiss] No serverSessionId provided — refusing to clear all checkpoints",
        );
      }
      return { success: true };
    }

    case messageActions.CHECK_DOWNLOAD_LIVE:
      // (Fix D.1) Liveness query — lets the panel show "download in
      // progress" instead of a Resume/Restart card for a checkpoint whose
      // download is actually still running.
      // (Round 9 — Fix B) Extended snapshot: live flag + the run's
      // upload-queue progress + terminal error. The panel polls this every
      // ~2.5s while a download is tracked, because pushed PANEL_MESSAGEs
      // are dropped when the focused tab changes; lastError lets the final
      // poll surface a failure that its push could not deliver.
      // (multipage-download-fixes 5.1 + 5.2) The answer now carries
      // EVIDENCE: heartbeatFresh from the persisted chrome.storage.session
      // record (refreshed on this poll-ack when live) and serverStatus (a
      // throttled terminal-status probe when not live). The panel's
      // completion/interruption decisions read the evidence, never the
      // in-memory Set alone — the Set dies with the service worker.
      return await buildLiveSnapshot(data?.sessionId);

    case messageActions.RESUME_SERVER_DOWNLOAD: {
      // (D10 / task 4.6) Read the checkpoint but DO NOT clear it before the
      // resume outcome is known. The old flow cleared it up-front, so a
      // transient failure (server unreachable) destroyed all recovery state.
      // Now: clear only on success or definitive failure (expired/invalid
      // session); keep on transient failure.
      // (D4) Target the resume's own checkpoint when the panel provides the
      // server session id.
      let checkpoint = await readCheckpoint(data?.serverSessionId);
      const cameFromStorage = checkpoint !== null;

      if (!checkpoint && data?.serverSessionId) {
        checkpoint = {
          downloadInterrupted: true,
          serverSessionId: data.serverSessionId,
          tabUrl: data.tabUrl,
          tabId: data.tabId,
          phase: data.phase || "scraping",
          timestamp: data.timestamp || Date.now(),
          resourceUrls: data.resourceUrls,
        };
      }

      if (checkpoint) {
        try {
          await resumeServerDownload(checkpoint, (message) => {
            addMessage({
              action: messageActions.PANEL_MESSAGE,
              data: { message },
            });
          });
          // Success — normal completion cleanup (targeted per-download clear,
          // design D4.4 — a concurrent download's checkpoint must survive)
          if (cameFromStorage) {
            await clearCheckpoint(checkpoint.serverSessionId);
          }
          return { success: true };
        } catch (err) {
          // (stop-cancel-semantics D3/D4 / task 3.5) An AbortError escaping
          // resumeServerDownload is user intent — the user pressed Stop.
          // Report the cancellation, clear the checkpoint (a deliberately
          // stopped download must not resurface as a Resume prompt), and
          // return WITHOUT the generic resume-failure payload (no Retry/
          // Restart offer, no panel-side full-restart fallback). Normal
          // resume stops are salvaged and reported inside
          // resumeServerDownload itself; this is the safety net for any
          // abort that escapes without salvage.
          if (isAbortError(err)) {
            if (cameFromStorage) {
              await clearCheckpoint(checkpoint.serverSessionId);
            }
            addMessage({
              action: messageActions.PANEL_MESSAGE,
              data: {
                message: {
                  key: "status.cancelled",
                  options: { serverSessionId: checkpoint.serverSessionId },
                },
              },
            });
            return { success: true };
          }
          // Definitive failure (expired/invalid session) — the checkpoint
          // can never be used again; clear it so the panel offers Restart.
          if (cameFromStorage && isDefinitiveResumeFailure(err)) {
            await clearCheckpoint(checkpoint.serverSessionId);
          }
          // Transient failure — the checkpoint stays in
          // chrome.storage.session so the panel can offer Retry.
          return {
            success: false,
            fallback: true,
            error: err instanceof Error ? err.message : "Resume failed",
          };
        }
      }
      return { success: false, fallback: true, error: "No checkpoint found" };
    }

    case messageActions.SCRAPER_PAUSE:
      pauseScraping(data.tabId);
      return true;

    case messageActions.SCRAPER_RESUME:
      resumeScraping(data.tabId);
      return true;

    // ------------------------------------------------------------------
    // (multipage-download-fixes D2 / task 4.5) Resume-from-park: re-spawn
    // LinkedPageScraper seeded from the persisted snapshot against the same
    // unfinalized server session. Stop-from-park needs no new flow — the
    // SCRAPER_STOP case below detects a parked download when no live
    // scraper exists and finalizes the partial via the salvage path.
    // ------------------------------------------------------------------
    case messageActions.SCRAPER_RESUME_FROM_PARK: {
      const parked = await findParkedContext(
        data?.serverSessionId,
        data?.tabId,
      );
      if (!parked || !parked.snapshot.serverSessionId) {
        // Missing/corrupt snapshot — fall back cleanly: report and offer
        // Stop (the parked Stop path only needs the checkpoint). Never
        // crash the worker.
        const sessionId =
          data?.serverSessionId ?? parked?.checkpoint?.serverSessionId;
        console.warn(
          `[ParkResume] No usable snapshot for session=${sessionId ?? "unknown"}`,
        );
        addMessage({
          action: messageActions.PANEL_MESSAGE,
          data: {
            message:
              "Could not restore the paused download state — the queued-page snapshot is missing or unreadable. You can still Stop to deliver the partial download.",
          },
        });
        return { success: false, fallback: true, error: "No parked snapshot" };
      }

      const snapshotSessionId = parked.snapshot.serverSessionId!;
      try {
        await resumeFromParkedScrape(parked.snapshot, (message) => {
          addMessage({
            action: messageActions.PANEL_MESSAGE,
            data: { message },
          });
        });
        // Success — the park is consumed (mirrors RESUME_SERVER_DOWNLOAD's
        // clear-on-success retention rule).
        await clearParkedState(snapshotSessionId);
        return { success: true };
      } catch (err) {
        if (isAbortError(err)) {
          // User pressed Stop mid-resume — the salvage already reported the
          // cancellation; clear the park so it never resurfaces.
          await clearParkedState(snapshotSessionId);
          addMessage({
            action: messageActions.PANEL_MESSAGE,
            data: {
              message: {
                key: "status.cancelled",
                options: { serverSessionId: snapshotSessionId },
              },
            },
          });
          return { success: true };
        }
        // Definitive failure (expired/invalid session) — the park can never
        // be used again; clear it so the panel offers Restart.
        if (isDefinitiveResumeFailure(err)) {
          await clearParkedState(snapshotSessionId);
        }
        // Transient failure — snapshot+checkpoint stay for a Retry.
        return {
          success: false,
          fallback: true,
          error: err instanceof Error ? err.message : "Park resume failed",
        };
      }
    }

    case messageActions.SCRAPER_STOP:
      stopScraping(data.tabId);
      // Also abort the active server-mode download (uploads + download flow)
      abortActiveDownload(data.tabId);
      // ----------------------------------------------------------------
      // (multipage-download-fixes D2 / task 4.5) Stop-from-park: when no
      // live scraper/download exists for this session but a parked
      // snapshot+checkpoint do (the worker died while paused), finalize the
      // partial via the salvage path and clear the park. A live download's
      // stop is fully handled by the two calls above — the parked fallback
      // only engages when the session is NOT live.
      // ----------------------------------------------------------------
      {
        const parked = await findParkedContext(
          data?.serverSessionId,
          data?.tabId,
        );
        const parkedSessionId = parked?.snapshot.serverSessionId;
        if (parked && parkedSessionId && !isSessionLive(parkedSessionId)) {
          try {
            await finalizeParkedDownload(
              {
                serverSessionId: parkedSessionId,
                tabId: parked.checkpoint?.tabId ?? data?.tabId,
                tabUrl: parked.checkpoint?.tabUrl,
              },
              (message) => {
                addMessage({
                  action: messageActions.PANEL_MESSAGE,
                  data: { message },
                });
              },
            );
            await clearParkedState(parkedSessionId);
          } catch (err) {
            // Finalize failed (e.g. server unreachable) — keep the park so
            // the user can retry the Stop; report the error.
            console.warn("[ParkStop] Finalize failed:", err);
            addMessage({
              action: messageActions.PANEL_MESSAGE,
              data: {
                message: {
                  key: "status.failedWithError",
                  options: {
                    error: err instanceof Error ? err.message : "Unknown error",
                  },
                },
              },
            });
            return {
              success: false,
              error: err instanceof Error ? err.message : "Park stop failed",
            };
          }
        }
      }
      return true;

    // ------------------------------------------------------------------
    // Server-mode message actions (task 13.2)
    //
    // These actions provide direct server API access from the UI,
    // enabling health checks, session status polling, and explicit
    // server session management.
    // ------------------------------------------------------------------

    case messageActions.SERVER_CREATE_SESSION:
      // Create a new server session. Used when the UI needs to
      // explicitly create a session (e.g., to pre-create a session
      // for a new download).
      // Delegates to shared createServerSession helper (unified with
      // INITIALIZE_DIFFERENTIAL_SCRAPING session creation).
      return await createServerSession(
        data.url,
        data.options,
        data.tabId,
        data.setActive ?? true,
      );

    case messageActions.SERVER_UPLOAD_HTML_CHUNK:
      // Upload an HTML chunk to the active server session.
      // Used by the sidepanel to stream HTML during scrolling (task 13.3)
      // instead of accumulating chunks in downloadResponse.
      try {
        const state = data.tabId
          ? getServerSessionState(data.tabId)
          : undefined;
        const targetSessionId = data.sessionId || state?.sessionId;
        if (!targetSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        const hasExplicitIndex = typeof data.scrollIndex === "number";
        const scrollIdx = hasExplicitIndex
          ? data.scrollIndex
          : state
            ? state.scrollIndex++
            : 0;
        const result = await serverClient.uploadHtmlChunk(
          targetSessionId,
          data.html,
          scrollIdx,
          data.pageType,
          data.pageUrl,
        );
        // (streamed-state truthfulness fix) The sidepanel streams every
        // scroll step with an EXPLICIT scrollIndex (0, 1, 2, …) — previously
        // only the implicit fallback below advanced this counter, so
        // hasStreamedHtmlChunks() stayed false and download-core
        // re-uploaded the final HTML as chunk 0 (server-side: overwrites
        // the skeleton-initializing chunk file and registers a duplicate
        // append chunk). Advance the counter on SUCCESS only: a failed
        // chunk never reached the server, and hasStreamedHtmlChunks must
        // not claim coverage it does not have. Math.max keeps the counter
        // monotonic — it counts chunks on the server ("next index"
        // semantics, same as the fallback increment).
        if (state && hasExplicitIndex) {
          state.scrollIndex = Math.max(state.scrollIndex, data.scrollIndex + 1);
        }
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.SERVER_SCRAPE_COMPLETE:
      // Signal that all HTML chunks have been uploaded.
      // Transitions the server session from "scraping" to "uploading".
      try {
        const scSessionId =
          data.sessionId || getActiveServerSessionId(data.tabId);
        if (!scSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        const result = await serverClient.scrapeComplete(
          scSessionId,
          data.resourceCount ?? 0,
          data.resourcesFailed,
        );
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.SERVER_UPLOAD_RESOURCE:
      // Upload a single resource to the server.
      // Used for ad-hoc resource uploads from the UI layer when
      // ServerStorageAdapter is not in play (e.g., retry scenarios).
      try {
        const urSessionId =
          data.sessionId || getActiveServerSessionId(data.tabId);
        if (!urSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        const result = await serverClient.uploadResource(
          urSessionId,
          data.path,
          data.blob,
          data.originalUrl,
          data.contentType,
        );
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.SERVER_UPLOAD_CONTENT:
      // Upload text content for content.txt inclusion in the ZIP.
      try {
        const ucSessionId =
          data.sessionId || getActiveServerSessionId(data.tabId);
        if (!ucSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        const result = await serverClient.uploadContent(ucSessionId, data.text);
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.SERVER_FINALIZE_SESSION:
      // Finalize a server session — trigger assembly pipeline.
      // The session must be in "uploading" status.
      try {
        const fsSessionId =
          data.sessionId || getActiveServerSessionId(data.tabId);
        if (!fsSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        const result = await serverClient.finalizeSession(fsSessionId);
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.SERVER_SESSION_STATUS:
      // Get the current status of a server session.
      // Used for polling assembly progress from the UI.
      try {
        const ssSessionId =
          data.sessionId || getActiveServerSessionId(data.tabId);
        if (!ssSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        const result = await serverClient.getSessionStatus(ssSessionId);
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.SERVER_DELETE_SESSION:
      // Delete a server session from the panel's delete flow. The optional
      // deleteCloud flag opts in to the federated delete — the monolith
      // then also removes the archived PagePocket page (close-cloud-
      // lifecycle-gaps D2). Without it the delete stays local-only.
      try {
        const dsSessionId =
          data.sessionId || getActiveServerSessionId(data.tabId);
        if (!dsSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        await serverClient.deleteSession(dsSessionId, {
          deleteCloud: data.deleteCloud === true,
        });
        // Hygiene: the session no longer exists server-side, so clear the
        // tab's active-session pointer (no-op when completion already
        // cleared it or an explicit session ID was used).
        setActiveServerSession(data.tabId, null);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.SERVER_HEALTH_CHECK:
      // Check server health — no authentication required.
      // Used by the UI to show server availability status.
      try {
        const result = await serverClient.checkHealth();
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.GOOGLE_SIGN_IN: {
      // (google-sign-in-via-background) chrome.identity.launchWebAuthFlow is
      // unreliable from a side panel across Chrome builds — the background
      // service worker owns all chrome.* plumbing, so the PKCE flow
      // (google-auth.ts, reused as-is) runs HERE and the panel drives it
      // with this message. Success returns the
      // {code, codeVerifier, redirectUri} payload for the backend exchange.
      // Failure returns a STRUCTURED {googleSignInError: code} reply instead
      // of throwing: a thrown Error is flattened to a string by the message
      // channel's catch, losing the typed, user-safe code the panel maps
      // to i18n strings. The service-worker console carries the diagnosis.
      try {
        return await launchGoogleSignIn();
      } catch (err) {
        const code = err instanceof GoogleSignInError ? err.code : "failed";
        console.warn("[GoogleSignIn] failed:", code);
        return { googleSignInError: code };
      }
    }

    default:
      return null;
  }
}
