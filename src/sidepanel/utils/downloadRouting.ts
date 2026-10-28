/**
 * (Fix 1 — design D1) Download-identity message routing.
 *
 * Incident: the panel filtered every incoming push against its LIVE active
 * tab (useActiveTabInfo re-pins it on every tabs.onActivated). Start a
 * download on tab A, switch to tab B → progress frames froze and the
 * terminal outcome (complete / failed / cancelled) was silently dropped —
 * the spinner stayed up forever. The chrome.storage completion fallback had
 * the same live-tab check (compounded by a stale-closure tabId).
 *
 * New semantics: the panel pins a download identity when a flow starts —
 *   { originTabId, serverSessionId }
 * (originTabId = the press-time snapshot useScrapingDownloader's Fix A
 * already pins for outgoing traffic; serverSessionId = the session created
 * or resumed for the run). Every incoming message and every
 * chrome.storage fallback record is classified against THAT identity,
 * never against the live tab:
 *
 * - Progress-class messages apply only when they belong to the tracked
 *   download — cross-download interference stays filtered.
 * - Terminal messages are ALWAYS evaluated. They resolve the UI when they
 *   belong to the tracked download and are ignored only when they
 *   provably belong to a DIFFERENT one. With nothing tracked there is
 *   nothing to contradict, so a terminal (e.g. a warm-restart
 *   DOWNLOAD_INTERRUPTED pushed to a just-opened panel) still resolves —
 *   the safe direction for reliability.
 * - Messages with tabId === undefined are unscoped (resume-path pushes,
 *   startup-cleanup interrupts) and belong to the tracked download (D1
 *   risk note).
 * - A payload-carried serverSessionId is authoritative when the panel has
 *   one: sessions are unique per download, while tabs host successive
 *   downloads.
 *
 * Pure functions — extracted so the routing decision is unit-testable
 * without React (same pattern as tabFilter / livePolling).
 */

/** The download the panel tracks, pinned when a flow starts (D1). */
export interface DownloadIdentity {
  /**
   * Press-time snapshot of the tab whose download this panel started —
   * the same value useScrapingDownloader's Fix A targetRef pins.
   * 0 = unknown (e.g. a checkpoint predating tab stamping).
   */
  originTabId: number;
  /** Server session created/resumed for the run, once known. */
  serverSessionId: string | null;
}

/** Progress frames update the in-progress UI; terminal outcomes resolve it. */
export type MessageClass = "progress" | "terminal";

export type RoutingDecision =
  /** Progress-class message for the tracked download — apply it. */
  | "apply"
  /** Message does not belong to the tracked download — ignore it. */
  | "ignore"
  /** Terminal outcome for the tracked download — always resolve the UI. */
  | "terminal-apply"
  /** Terminal outcome provably for a different download — never resolve. */
  | "terminal-ignore";

/** The routing-relevant fields of a pushed message. */
export interface RoutableMessage {
  /** Sender tab id stamped by the background (undefined = unscoped). */
  tabId?: number;
  /** Server session id carried in the payload, when present. */
  serverSessionId?: string | null;
}

/**
 * PANEL_MESSAGE payload keys that carry a terminal outcome — D1's
 * `status.serverError` class plus every other key that resolves the
 * in-progress UI (completion, cancellation, failure reports, the
 * zero-content abort). Everything else (progress frames, phase
 * transitions, additive URL updates) is progress-class.
 */
const TERMINAL_STATUS_KEYS: ReadonlySet<string> = new Set([
  "status.complete",
  "status.cancelled",
  "status.failedWithError",
  "status.noDownloadableContent",
  "status.serverError",
  "status.serverFallbackOffer",
  "status.memoryLimitError",
  "status.networkError",
  "status.cloudNotLinked",
  "status.cloudIdentityMismatch",
  "status.pagepocketUploadComplete",
  "status.pagepocketUploadError",
]);

/** Class a PANEL_MESSAGE payload key into the D1 message classes. */
export function messageClassForPanelKey(
  key: string | undefined | null,
): MessageClass {
  return key != null && TERMINAL_STATUS_KEYS.has(key) ? "terminal" : "progress";
}

/**
 * Classify a pushed message against the pinned download identity.
 *
 * Progress-class: "apply" only when the message belongs to the tracked
 * download, "ignore" otherwise. Terminal-class: ALWAYS evaluated —
 * "terminal-apply" unless the message provably belongs to a different
 * download ("terminal-ignore").
 */
export function classifyDownloadMessage(
  identity: DownloadIdentity | null,
  msg: RoutableMessage,
  messageClass: MessageClass,
): RoutingDecision {
  if (messageClass === "terminal") {
    // Terminals are always evaluated (D1). Ignore only on a provable
    // mismatch with the TRACKED identity — and a payload session id is
    // authoritative in BOTH directions (sessions are unique per download;
    // the sender-tab stamp is best-effort), so a terminal naming the
    // tracked session resolves even from an odd tab.
    if (identity) {
      if (msg.serverSessionId != null && identity.serverSessionId != null) {
        return msg.serverSessionId === identity.serverSessionId
          ? "terminal-apply"
          : "terminal-ignore";
      }
      if (msg.tabId !== undefined && msg.tabId !== identity.originTabId) {
        return "terminal-ignore";
      }
    }
    return "terminal-apply";
  }

  // Progress-class: strict identity match.
  // A session id on both sides is authoritative.
  if (msg.serverSessionId != null && identity?.serverSessionId != null) {
    return msg.serverSessionId === identity.serverSessionId
      ? "apply"
      : "ignore";
  }
  // Unscoped pushes belong to the tracked download (D1 risk note) — and,
  // when nothing is tracked at all, keep the legacy always-accept behavior
  // for broadcasts.
  if (msg.tabId === undefined) return "apply";
  if (!identity) return "ignore";
  return msg.tabId === identity.originTabId ? "apply" : "ignore";
}

/**
 * Sibling for chrome.storage terminal fallback records
 * (downloadComplete / downloadCancelled / downloadFailed — design D4).
 * The records carry the download's origin tabId exactly like a pushed
 * terminal message, so the same terminal routing applies.
 */
export function classifyTerminalRecord(
  identity: DownloadIdentity | null,
  record: RoutableMessage,
): Extract<RoutingDecision, "terminal-apply" | "terminal-ignore"> {
  return classifyDownloadMessage(identity, record, "terminal") as Extract<
    RoutingDecision,
    "terminal-apply" | "terminal-ignore"
  >;
}
