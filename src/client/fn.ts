declare global {
  interface Window {
    XMLHttpRequest: any;
    ActiveXObject: any;
  }
}

export interface ScrollResult {
  success: boolean;
  top: number;
  height: number;
  viewportHeight: number;
  html?: string;
  isInitial?: boolean;
  isComplete?: boolean;
  newContent?: string;
  containerSelector?: string;
  error?: string;
  /** Whether the page's scrollHeight changed during this scroll step. */
  heightChanged?: boolean;
  /**
   * (Fix C — hydration window) Milliseconds since the FIRST scroll step ran
   * in this tab (persisted across steps in the isolated world). The panel's
   * early-stop logic requires a minimum elapsed time so a pre-hydration DOM
   * (skeleton-only page that is instantly "at bottom") is never declared
   * settled.
   */
  hydrationElapsedMs?: number;
  /**
   * (Fix C — hydration window) Number of VISIBLE <img> elements that still
   * have an unresolved source (in-flight load). The panel waits for this to
   * reach 0 (or a time cap) before allowing an early stop.
   */
  imagesPending?: number;
}

export interface DifferentialScrapeResult {
  type: "skeleton" | "chunk" | "complete" | "error";
  data: string;
  containerSelector?: string;
  scrollPosition?: number;
  totalHeight?: number;
  error?: string;
}

/**
 * Legacy function for backward compatibility
 * Returns the full HTML document (non-differential)
 *
 * Uses viewport-relative step size (Math.min(viewportHeight, 800)) for faster
 * coverage, tracks scrollHeight before/after each step to detect page growth,
 * and detects layout shifts where the viewport jumps upward.
 */
export async function smoothScrollToBottom(): Promise<ScrollResult> {
  const viewportHeight = window.innerHeight;
  const stepSize = Math.min(viewportHeight, 800);
  const waitDelay = 200;

  async function wait() {
    return new Promise<void>((resolve) => {
      setTimeout(() => resolve(), waitDelay);
    });
  }

  function getCurrentScrollTop() {
    return window.scrollY || document.documentElement.scrollTop;
  }

  // ---------------------------------------------------------------------
  // (Fix C — hydration window) Per-tab hydration tracking.
  //
  // This function is injected step-by-step via chrome.scripting, so all
  // state must live inside this body. The tracker is persisted on the
  // tab's ISOLATED-world window, which survives between injections, so
  // `hydrationElapsedMs` measures time since the very first scroll step
  // for the current document. A navigation resets it (location.href check).
  //
  // NOTE: this function is serialized with Function.prototype.toString and
  // injected into the page — it must stay fully self-contained (no imports,
  // no outer-scope references).
  // ---------------------------------------------------------------------
  const hydrationKey = "__wpdHydrationStartMs";
  const hydrationUrlKey = "__wpdHydrationUrl";
  const w = window as unknown as Record<string, unknown>;
  const now = Date.now();
  if (
    typeof w[hydrationKey] !== "number" ||
    w[hydrationUrlKey] !== window.location.href
  ) {
    w[hydrationKey] = now;
    w[hydrationUrlKey] = window.location.href;
  }
  const hydrationElapsedMs = now - (w[hydrationKey] as number);

  // Count VISIBLE <img> elements whose source is still loading. Only images
  // with an actual source (src / data-src / srcset) count — an image that
  // already failed (complete=true) or has no source is not pending. Broken
  // images therefore never block the flow, and the panel's time cap bounds
  // any genuinely slow loader.
  let imagesPending = 0;
  const docImages = document.images;
  for (let i = 0; i < docImages.length; i++) {
    const img = docImages[i];
    if (!img) continue;
    const style = window.getComputedStyle(img);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const hasSource = !!(
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("srcset")
    );
    if (hasSource && !img.complete) {
      imagesPending++;
    }
  }

  // Capture scrollHeight BEFORE scrolling
  const heightBefore = document.documentElement.scrollHeight;
  const scrollYBefore = getCurrentScrollTop();

  const nextTop = scrollYBefore + stepSize;
  window.scrollTo({ top: nextTop });

  await wait();

  // Capture scrollHeight AFTER scrolling
  const heightAfter = document.documentElement.scrollHeight;
  const scrollYAfter = getCurrentScrollTop();

  // Height changed if page grew during this step
  const heightChanged = heightAfter !== heightBefore;

  // Detect layout shift: viewport jumped upward
  const layoutShifted = scrollYAfter < scrollYBefore - 10;

  return {
    success: true,
    top: scrollYAfter,
    height: heightAfter,
    viewportHeight: window.innerHeight,
    html: document.documentElement.outerHTML,
    heightChanged: heightChanged || layoutShifted,
    hydrationElapsedMs,
    imagesPending,
  };
}
