import * as cheerio from "cheerio";
import {
  DEFAULT_MEMORY_LIMITS,
  MEMORY_ERROR_MESSAGES,
} from "../utils/memoryLimits";
import { memoryManager } from "../utils/MemoryManager";
import { htmlAssembler } from "./HtmlAssembler";

interface MergeHtmlOptions {
  maxHtmlSize?: number;
  maxIterations?: number;
  enableMemoryCheck?: boolean;
  trackMemory?: boolean;
  useIncrementalAssembly?: boolean; // New option for using HtmlAssembler
  jobId?: string; // Job ID for incremental assembly
}

export function mergeHtml(
  html1: string,
  html2: string,
  options: MergeHtmlOptions = {},
) {
  const {
    maxHtmlSize = DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE,
    maxIterations = 1000,
    enableMemoryCheck = true,
    useIncrementalAssembly = false,
    jobId,
  } = options;

  // Use incremental assembly if requested
  if (useIncrementalAssembly && jobId) {
    return mergeHtmlIncremental(html1, html2, jobId, options);
  }

  // Memory safety check before processing
  if (enableMemoryCheck) {
    const combinedSize = html1.length + html2.length;

    if (combinedSize > maxHtmlSize) {
      throw new Error(
        MEMORY_ERROR_MESSAGES.HTML_TOO_LARGE(combinedSize, maxHtmlSize),
      );
    }

    // Check memory availability
    if (!memoryManager.checkMemoryAvailability(combinedSize * 2)) {
      // Account for growth during merge
      throw new Error(MEMORY_ERROR_MESSAGES.INSUFFICIENT_MEMORY);
    }
  }

  try {
    // Validate HTML content before parsing
    if (!isValidHtml(html1) || !isValidHtml(html2)) {
      throw new Error("Invalid HTML content provided for merge");
    }

    const $1 = cheerio.load(html1);
    const $2 = cheerio.load(html2);

    // Check for potential exponential growth scenarios
    const complexity = analyzeHtmlComplexity(html1, html2);
    if (complexity.isExponential) {
      return safeHtmlMerge(html1, html2, options);
    }

    const parentSelector = findParentSelector($1, $2);
    if (parentSelector) {
      const $container1 = $1(parentSelector);
      const $container2 = $2(parentSelector);
      const children1 = $container1.children();
      const children2 = $container2.children();
      const firstChild1 = children1.first().html() || "";
      const firstChild2 = children2.first().html() || "";

      if (compareHTMLBlocks(firstChild1, firstChild2)) {
        const result = $2.html();

        // Final memory check
        if (enableMemoryCheck && result.length > maxHtmlSize) {
          throw new Error(
            MEMORY_ERROR_MESSAGES.HTML_TOO_LARGE(result.length, maxHtmlSize),
          );
        }

        return result;
      } else {
        const length2 = children2.length;

        // Prevent excessive iterations
        const iterations = Math.min(length2, maxIterations);

        for (let i = 0; i < iterations; i++) {
          $container1.append(children2[i]);

          // Periodic memory check during merging
          if (enableMemoryCheck && i % 100 === 0) {
            const currentSize = $1.html()!.length;
            if (currentSize > maxHtmlSize) {
              throw new Error(
                MEMORY_ERROR_MESSAGES.HTML_TOO_LARGE(currentSize, maxHtmlSize),
              );
            }
          }
        }
      }
    }

    const result = $1.html();

    // Final validation
    if (enableMemoryCheck && result.length > maxHtmlSize) {
      throw new Error(
        MEMORY_ERROR_MESSAGES.HTML_TOO_LARGE(result.length, maxHtmlSize),
      );
    }

    return result;
  } catch (error) {
    // Fallback to safe merge if regular merge fails
    if (
      error instanceof Error &&
      (error.message?.includes("memory") || error.message?.includes("size"))
    ) {
      return safeHtmlMerge(html1, html2, options);
    }

    throw error;
  }
}

/**
 * Safe HTML merge with minimal memory usage and growth
 */
function safeHtmlMerge(
  html1: string,
  html2: string,
  options: MergeHtmlOptions = {},
): string {
  const { maxHtmlSize = DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE } = options;

  try {
    // Parse both HTML documents minimally
    const $1 = cheerio.load(html1);
    const $2 = cheerio.load(html2);

    // Extract only the body content to avoid excessive duplication
    const body1 = $1("body").html() || "";
    const body2 = $2("body").html() || "";

    // Simple concatenation with size limit
    const combinedContent = body1 + "\n" + body2;

    if (combinedContent.length > maxHtmlSize) {
      // Truncate content if it's still too large
      const truncatedContent =
        combinedContent.substring(0, maxHtmlSize - 1000) +
        "\n<!-- Content truncated due to size limits -->";

      return createSimpleHtmlWrapper(truncatedContent, $1);
    }

    return createSimpleHtmlWrapper(combinedContent, $1);
  } catch {
    // Last resort: return the first HTML content
    return html1.length > maxHtmlSize
      ? html1.substring(0, maxHtmlSize) + "\n<!-- Content truncated -->"
      : html1;
  }
}

/**
 * Create a simple HTML wrapper for merged content
 */
function createSimpleHtmlWrapper(
  content: string,
  $template: cheerio.CheerioAPI,
): string {
  try {
    // Extract basic structure from template
    const title = $template("title").text() || "Merged Content";
    const headContent = $template("head").html() || "";

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  ${headContent}
</head>
<body>
  ${content}
</body>
</html>`;
  } catch (error) {
    // Fallback minimal HTML structure
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Merged Content</title>
</head>
<body>
  ${escapeHtml(content)}
</body>
</html>`;
  }
}

/**
 * Validate HTML content for safety
 */
function isValidHtml(html: string): boolean {
  if (!html || typeof html !== "string") return false;

  // Basic size check
  if (html.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) return false;

  // Basic structure validation - check for basic HTML tags
  const trimmedHtml = html.trim().toLowerCase();
  return (
    trimmedHtml.includes("<html") ||
    trimmedHtml.includes("<!doctype") ||
    trimmedHtml.includes("<head") ||
    trimmedHtml.includes("<body")
  );
}

/**
 * Analyze HTML complexity to detect potential exponential growth
 */
function analyzeHtmlComplexity(
  html1: string,
  html2: string,
): {
  isExponential: boolean;
  complexity: number;
  reason?: string;
} {
  const dom1 = cheerio.load(html1);
  const dom2 = cheerio.load(html2);

  const elements1 = dom1("*").length;
  const elements2 = dom2("*").length;
  const totalElements = elements1 + elements2;

  // Check for potentially problematic patterns - but be less aggressive
  const hasNestedTables =
    (dom1("table table").length > 10) || (dom2("table table").length > 10); // Increased threshold
  const hasDeeplyNested =
    dom1("*").filter(function () {
      return dom1(this).parents().length > 50; // Increased threshold
    }).length > 5 || // Only if multiple deeply nested elements
    dom2("*").filter(function () {
      return dom2(this).parents().length > 50;
    }).length > 5;
  const hasLargeTables =
    (dom1("table").filter(function () {
      return dom1(this).find("tr").length > 5000; // Increased threshold
    }).length > 0) ||
    (dom2("table").filter(function () {
      return dom2(this).find("tr").length > 5000;
    }).length > 0);

  // Also check for duplicate content which might indicate exponential growth
  const body1 = dom1("body").html() || "";
  const body2 = dom2("body").html() || "";
  const hasDuplicateContent = body1.length > 0 && body1 === body2;

  const complexity = totalElements;
  // More conservative exponential growth detection
  const isExponential =
    complexity > 100000 || // Increased threshold
    hasNestedTables ||
    hasDeeplyNested ||
    hasLargeTables ||
    hasDuplicateContent;

  let reason;
  if (totalElements > 100000) reason = `Too many elements: ${totalElements}`;
  else if (hasNestedTables) reason = "Excessive nested tables detected";
  else if (hasDeeplyNested) reason = "Excessively deeply nested elements detected";
  else if (hasLargeTables) reason = "Very large tables detected";
  else if (hasDuplicateContent) reason = "Duplicate content detected";

  return { isExponential, complexity, reason };
}

/**
 * Escape HTML content to prevent injection
 */
function escapeHtml(text: string): string {
  if (typeof document !== "undefined") {
    const tempDiv = document.createElement("div");
    tempDiv.textContent = text;
    return tempDiv.innerHTML;
  }

  // Basic HTML escaping for non-browser environments
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function compareHTMLBlocks(html1: string, html2: string) {
  const normalizedHtml1 = html1.replace(/\s/g, "").toLowerCase();
  const normalizedHtml2 = html2.replace(/\s/g, "").toLowerCase();

  return normalizedHtml1 === normalizedHtml2;
}

function findParentSelector($1: cheerio.CheerioAPI, $2: cheerio.CheerioAPI) {
  let parentSelector: string | null = null;

  $1("body *").each((_, element) => {
    try {
      const element1 = $1(element);
      const selector = getSelector(element1);
      const element2 = $2(selector);

      if (element2.length === 0) {
        const parent = element2.parent();
        if (parent.length > 0) {
          parentSelector = getSelector(parent);
        }
      }
    } catch (error) {
      // Silently ignore selector generation errors
    }
  });

  return parentSelector;
}

function getSelector(element: cheerio.Cheerio<any>): string {
  const selectors = getSelectors(element);
  return selectors.join(" > ");
}

function getSelectors(element: cheerio.Cheerio<any>): string[] {
  const selectors = [];

  if (element.length > 0) {
    const parent = element.parent();
    let nth = "";

    if (parent.length > 0) {
      selectors.push(...getSelectors(parent));
      const index = parent.children().index(element[0]);
      nth = `:nth-child(${index + 1})`;
    }

    const name = element[0].name;
    const sel = !!nth.length ? `${name ? name : "*"}${nth}` : name;
    selectors.push(sel);
  }

  return selectors;
}

/**
 * Incremental HTML merge using HtmlAssembler
 * This is the new approach that avoids expensive DOM parsing
 */
export function mergeHtmlIncremental(
  html1: string,
  html2: string,
  jobId: string,
  options: MergeHtmlOptions = {},
): string {
  const {
    maxHtmlSize = DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE,
  } = options;

  try {
    // Check if job exists, if not initialize it
    let job = htmlAssembler.getActiveJobs().find(j => j.id === jobId);
    
    if (!job) {
      // Initialize job with first HTML as skeleton
      htmlAssembler.initializeJob(jobId, html1, {
        maxTotalSize: maxHtmlSize,
        enableDeduplication: true,
        enableMinification: true,
      });
    }

    // Add the new HTML as a chunk
    const addResult = htmlAssembler.addChunk(jobId, html2);
    
    if (!addResult.success) {
      // Fall back to traditional merge if incremental assembly fails
      return mergeHtml(html1, html2, { ...options, useIncrementalAssembly: false });
    }

    // For incremental assembly, we don't return the full HTML yet
    // The final HTML will be generated when the job is finalized
    // Return a placeholder that indicates the merge was successful
    return `<!-- Incremental merge successful for job ${jobId}. Total size: ${addResult.newSize || 'unknown'} -->`;

  } catch {    
    // Fall back to traditional merge
    return mergeHtml(html1, html2, { ...options, useIncrementalAssembly: false });
  }
}

/**
 * Finalize an incremental HTML assembly job
 */
export function finalizeIncrementalMerge(jobId: string): { success: boolean; html?: string; blob?: Blob; error?: string } {
  try {
    const result = htmlAssembler.finalizeJob(jobId);
    
    if (!result.success) {
      return {
        success: false,
        error: result.reason || 'Failed to finalize job',
      };
    }
    
    return {
      success: true,
      html: result.html,
      blob: result.blob,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Clean up old incremental assembly jobs
 */
export function cleanupIncrementalMerges(maxAge: number = 30 * 60 * 1000): number {
  return htmlAssembler.cleanup(maxAge);
}
