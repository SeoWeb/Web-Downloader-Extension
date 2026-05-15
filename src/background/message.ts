import { sendMessage } from "../common/chrome";
import { MessageAction, messageActions } from "../common/message";
import { scrollDownAndScrape, startDownload } from "./jobs";
import { pauseScraping, resumeScraping, stopScraping } from "./scraper-state";
import { abortActiveDownload } from "./download-state";
import { readCheckpoint, clearCheckpoint } from "./download-checkpoint";
import { resumeServerDownload } from "./download-core";
import { serverClient, ServerUnavailableError } from "./server-client";

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
  options: { singleFile?: boolean; retentionDays?: number } | undefined,
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
export function setActiveServerSession(tabId: number, sessionId: string | null): void {
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
  return state !== undefined && state.sessionId !== null && state.scrollIndex > 0;
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
          const result = await createServerSession(data.tabUrl, {
            singleFile: data.downloadOptions?.singleFile ?? false,
            retentionDays: 1,
          }, data.tabId);
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
            await serverClient.uploadHtmlChunk(
              sessionState.sessionId,
              data.htmlChunk,
              sessionState.scrollIndex++,
              "main",
              // Do NOT send pageUrl for main pages — the server uses the
              // absence of pageUrl to set page_url_hash="main", which the
              // assembler looks up as merge_results.get("main").
              undefined,
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
      return await readCheckpoint();
    }

    case messageActions.DISMISS_INTERRUPTED_DOWNLOAD: {
      // User dismissed the interrupt UI without resuming — clear the checkpoint
      // so re-opening the panel doesn't show stale interrupt state.
      await clearCheckpoint();
      return { success: true };
    }

    case messageActions.RESUME_SERVER_DOWNLOAD: {
      // Prefer checkpoint from storage; fall back to data sent by the sidepanel.
      let checkpoint = await readCheckpoint();
      if (checkpoint) {
        await clearCheckpoint();
      } else if (data?.serverSessionId) {
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
          return { success: true };
        } catch (err) {
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

    case messageActions.SCRAPER_STOP:
      stopScraping(data.tabId);
      // Also abort the active server-mode download (uploads + download flow)
      abortActiveDownload(data.tabId);
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
      return await createServerSession(data.url, data.options, data.tabId, data.setActive ?? true);

    case messageActions.SERVER_UPLOAD_HTML_CHUNK:
      // Upload an HTML chunk to the active server session.
      // Used by the sidepanel to stream HTML during scrolling (task 13.3)
      // instead of accumulating chunks in downloadResponse.
      try {
        const state = data.tabId ? getServerSessionState(data.tabId) : undefined;
        const targetSessionId = data.sessionId || state?.sessionId;
        if (!targetSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        const scrollIdx = data.scrollIndex ?? (state ? state.scrollIndex++ : 0);
        const result = await serverClient.uploadHtmlChunk(
          targetSessionId,
          data.html,
          scrollIdx,
          data.pageType,
          data.pageUrl,
        );
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
        const scSessionId = data.sessionId || getActiveServerSessionId(data.tabId);
        if (!scSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        const result = await serverClient.scrapeComplete(
          scSessionId,
          data.resourceCount ?? 0,
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
        const urSessionId = data.sessionId || getActiveServerSessionId(data.tabId);
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
        const ucSessionId = data.sessionId || getActiveServerSessionId(data.tabId);
        if (!ucSessionId) {
          return {
            success: false,
            error: "No active server session",
          };
        }
        const result = await serverClient.uploadContent(
          ucSessionId,
          data.text,
        );
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
        const fsSessionId = data.sessionId || getActiveServerSessionId(data.tabId);
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
        const ssSessionId = data.sessionId || getActiveServerSessionId(data.tabId);
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

    default:
      return null;
  }
}
