declare global {
  interface Window {
    XMLHttpRequest: any;
    ActiveXObject: any;
  }
}

import { DEFAULT_MEMORY_LIMITS, MemoryPressureLevel } from "../utils/memoryLimits";
import { memoryManager } from "../utils/MemoryManager";

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
 * Detect the main scrolling container for dynamic content
 */
function findScrollingContainer(): Element | null {
  // Common selectors for infinite scroll containers
  const commonSelectors = [
    '[role="feed"]',
    '.infinite-scroll',
    '.scroll-container',
    '.content-area',
    '.main-content',
    '#content',
    '.feed',
    '.timeline',
    '.list-container',
    '.grid-container',
    'main',
    'body'
  ];

  // Try to find the best container
  for (const selector of commonSelectors) {
    const element = document.querySelector(selector);
    if (element && element.scrollHeight > element.clientHeight) {
      console.log(`Found scrolling container: ${selector}`);
      return element;
    }
  }

  // Fallback to body
  return document.body;
}

/**
 * Generate a simple hash for content comparison
 */
function generateHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/**
 * Extract new content from the scrolling container
 */
function extractNewContent(
  container: Element,
  lastKnownHeight: number,
  lastContentHash: string
): { newContent: string; newHeight: number; newHash: string } {
  const currentHeight = container.scrollHeight;
  const containerHtml = container.innerHTML;
  const currentHash = generateHash(containerHtml);

  // If content hasn't changed, return empty
  if (currentHash === lastContentHash && currentHeight === lastKnownHeight) {
    return {
      newContent: '',
      newHeight: currentHeight,
      newHash: currentHash,
    };
  }

  // For simplicity, we'll return the entire container content
  // In a more sophisticated implementation, we could try to identify
  // only the new elements that were added
  return {
    newContent: containerHtml,
    newHeight: currentHeight,
    newHash: currentHash,
  };
}

/**
 * Create skeleton HTML with placeholder for dynamic content
 */
function createSkeletonHtml(containerSelector: string): string {
  const container = document.querySelector(containerSelector);
  
  if (!container) {
    // Fallback to full document if container not found
    return document.documentElement.outerHTML;
  }

  // Create a clone of the document
  const clone = document.cloneNode(true) as Document;
  const clonedContainer = clone.querySelector(containerSelector);
  
  if (clonedContainer) {
    // Replace container content with placeholder
    clonedContainer.innerHTML = '<!--CONTENT_PLACEHOLDER-->';
  }

  return clone.documentElement.outerHTML;
}

/**
 * Initialize differential scraping
 */
export function initializeDifferentialScraping(): DifferentialScrapeResult {
  try {
    // Check if HTML is too large for differential scraping
    const html = document.documentElement.outerHTML;
    const htmlSize = new Blob([html]).size;
    
    // If HTML is extremely large, skip differential scraping
    if (htmlSize > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE * 2) {
      console.warn(`HTML too large for differential scraping: ${formatBytes(htmlSize)}`);
      return {
        type: 'error',
        data: '',
        error: `HTML too large for differential scraping: ${formatBytes(htmlSize)}`,
      };
    }
    
    // Check memory pressure
    const memoryStats = memoryManager.getMemoryStats();
    if (memoryStats.memoryPressureLevel === MemoryPressureLevel.CRITICAL) {
      console.warn("Critical memory pressure detected");
      return {
        type: 'error',
        data: '',
        error: "Critical memory pressure detected",
      };
    }
    
    const container = findScrollingContainer();
    if (!container) {
      return {
        type: 'error',
        data: '',
        error: 'Could not find scrolling container',
      };
    }

    const containerSelector = getSelector(container);
    const skeletonHtml = createSkeletonHtml(containerSelector);
    
    return {
      type: 'skeleton',
      data: skeletonHtml,
      containerSelector,
      scrollPosition: window.scrollY || document.documentElement.scrollTop,
      totalHeight: document.documentElement.scrollHeight,
    };
  } catch (error) {
    return {
      type: 'error',
      data: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get a CSS selector for an element
 */
function getSelector(element: Element): string {
  if (element.id) {
    return `#${element.id}`;
  }
  
  if (element.className) {
    const classes = element.className.split(' ').filter(c => c.trim());
    if (classes.length > 0) {
      return `.${classes.join('.')}`;
    }
  }
  
  return element.tagName.toLowerCase();
}

/**
 * Scroll down and extract only new content (differential scraping)
 */
export async function scrollAndExtractDiff(
  containerSelector: string,
  lastKnownHeight: number = 0,
  lastContentHash: string = ''
): Promise<DifferentialScrapeResult> {
  const stepSize = 500;
  const waitDelay = 200;

  async function wait() {
    return new Promise<void>((resolve) => {
      setTimeout(() => resolve(), waitDelay);
    });
  }

  function getCurrentScrollTop() {
    return window.scrollY || document.documentElement.scrollTop;
  }

  function getCurrentScrollHeight() {
    return document.documentElement.scrollHeight;
  }

  try {
    // Scroll down
    const currentScrollTop = getCurrentScrollTop();
    const newScrollTop = currentScrollTop + stepSize;
    
    window.scrollTo({
      top: newScrollTop,
      behavior: 'smooth'
    });

    await wait();

    // Check if we've reached the bottom
    const isAtBottom = getCurrentScrollTop() + window.innerHeight >= getCurrentScrollHeight() - 100;
    
    // Extract new content
    const container = document.querySelector(containerSelector);
    if (!container) {
      return {
        type: 'error',
        data: '',
        error: `Container not found: ${containerSelector}`,
      };
    }

    const { newContent, newHeight } = extractNewContent(
      container,
      lastKnownHeight,
      lastContentHash
    );

    // If no new content and we're at the bottom, we're done
    if (!newContent && isAtBottom) {
      return {
        type: 'complete',
        data: '',
        containerSelector,
        scrollPosition: getCurrentScrollTop(),
        totalHeight: getCurrentScrollHeight(),
      };
    }

    // If we have new content, return it as a chunk
    if (newContent) {
      return {
        type: 'chunk',
        data: newContent,
        containerSelector,
        scrollPosition: getCurrentScrollTop(),
        totalHeight: newHeight,
      };
    }

    // No new content, but not at bottom yet
    return {
      type: 'chunk',
      data: '',
      containerSelector,
      scrollPosition: getCurrentScrollTop(),
      totalHeight: getCurrentScrollHeight(),
    };
  } catch (error) {
    return {
      type: 'error',
      data: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
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

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}
