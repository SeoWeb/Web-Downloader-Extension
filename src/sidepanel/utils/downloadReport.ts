/**
 * Download report state (tasks 5.3 + 5.5, design D14).
 *
 * The background streams per-category summary messages while a download
 * runs (`status.*Summary` keys with succeeded/failed/skipped options).
 * Those messages flash by in the status list; this module aggregates them
 * into a persistent report that `DownloadComplete` renders after the fact.
 *
 * Pure transition functions, mirroring `server-mode-state.ts`, so the
 * logic stays unit-testable without React.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One aggregated report line: the original message key + its options. */
export interface DownloadReportEntry {
  key: string;
  options?: Record<string, any>;
}

export interface DownloadReport {
  /** Per-category summary lines, in stable category order. */
  entries: DownloadReportEntry[];
  /** Finalized with partial content (stopped early or session limit hit). */
  partial: boolean;
  /** Cancelled outright by the user. */
  cancelled: boolean;
}

export const initialDownloadReport: DownloadReport = {
  entries: [],
  partial: false,
  cancelled: false,
};

/**
 * Summary message keys → canonical report category.
 * The first entry defines the display order of the report block.
 */
const SUMMARY_CATEGORIES: Array<[category: string, keys: string[]]> = [
  ["html", ["status.htmlSummary"]],
  ["css", ["status.cssSummary", "status.cssStreamingSummary"]],
  ["bgImages", ["status.bgImagesSummary", "status.bgImagesStreamingSummary"]],
  ["js", ["status.jsSummary", "status.jsStreamingSummary"]],
  ["images", ["status.imagesSummary", "status.imagesStreamingSummary"]],
  ["documents", ["status.documentsSummary"]],
  ["links", ["status.linksSummary"]],
  ["content", ["status.contentSummary"]],
];

const CATEGORY_ORDER: Record<string, number> = Object.fromEntries(
  SUMMARY_CATEGORIES.map(([category], index) => [category, index]),
);

const KEY_TO_CATEGORY: Record<string, string> = Object.fromEntries(
  SUMMARY_CATEGORIES.flatMap(([category, keys]) =>
    keys.map((key) => [key, category]),
  ),
);

// ---------------------------------------------------------------------------
// State transition
// ---------------------------------------------------------------------------

/**
 * Apply a panel message to the current download report and return the new
 * state. Pure function — no side effects.
 *
 * @param prev    Current download report
 * @param msgKey  The `data.message.key` from the PANEL_MESSAGE action
 * @param options The `data.message.options` object (may be undefined)
 */
export function applyDownloadReportMessage(
  prev: DownloadReport,
  msgKey: string,
  options?: Record<string, any> | null,
): DownloadReport {
  const category = KEY_TO_CATEGORY[msgKey];
  if (category) {
    const entry: DownloadReportEntry = {
      key: msgKey,
      options: options ?? undefined,
    };
    // Later summaries for the same category replace earlier ones (e.g. a
    // streaming summary supersedes the plain per-category summary).
    const remaining = prev.entries.filter(
      (e) => KEY_TO_CATEGORY[e.key] !== category,
    );
    const entries = [...remaining, entry].sort(
      (a, b) =>
        (CATEGORY_ORDER[KEY_TO_CATEGORY[a.key]] ?? 99) -
        (CATEGORY_ORDER[KEY_TO_CATEGORY[b.key]] ?? 99),
    );
    return { ...prev, entries };
  }

  switch (msgKey) {
    // (5.5) Server finalized with partial content (session size limit hit).
    case "status.finalizingPartial":
      return { ...prev, partial: true };
    default:
      return prev;
  }
}
