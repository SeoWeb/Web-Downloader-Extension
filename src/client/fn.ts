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
 */
export async function smoothScrollToBottom(): Promise<ScrollResult> {
  const stepSize = 500;
  const waitDelay = 200;
  let lastScrollTop = getCurrentScrollTop();

  async function wait() {
    return new Promise<void>((resolve) => {
      setTimeout(() => resolve(), waitDelay);
    });
  }

  function getNextScrollTop() {
    return lastScrollTop + stepSize;
  }

  async function scrollTo() {
    const top = getNextScrollTop();
    window.scrollTo({
      top,
    });

    return await wait();
  }

  function getCurrentScrollTop() {
    return window.scrollY || document.documentElement.scrollTop;
  }

  async function scrollDown() {
    await scrollTo();

    return {
      success: true,
      top: getCurrentScrollTop(),
      height: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      html: document.documentElement.outerHTML,
    };
  }

  return await scrollDown();
}
