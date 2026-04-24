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
}

export interface DifferentialScrapeResult {
  type: 'skeleton' | 'chunk' | 'complete' | 'error';
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
  };
}
