## Context

The extension has two HTML upload paths for the main page:

1. **Scroll streaming** (`useScrapingDownloader.ts`): Each scroll step sends `document.documentElement.outerHTML` via `SERVER_UPLOAD_HTML_CHUNK` with `pageType: "main"` and `pageUrl: tabUrl`.
2. **Download phase** (`download-core.ts`): Sends the final HTML via `uploadHtmlChunk` with `pageType: "main"` and **no** `pageUrl`.

On the server, the upload route (`html.py`) computes `page_url_hash` from `pageUrl` when present, falling back to `"main"` when absent. This means scroll-streamed chunks go into job `hash(tabUrl)`, while the download-phase chunk goes into job `"main"`.

The assembler (`zip_assembler.py`) treats all non-`"main"` results as linked pages, so the `hash(tabUrl)` job produces a phantom linked page file (e.g., `pages/Kauplused.html`) with duplicated content.

## Goals / Non-Goals

**Goals:**
- Eliminate the phantom linked page generated from main page scroll streaming.
- Fix `_safe_merge` so it never produces duplicated body content.
- Fix `_dom_merge` superset detection to correctly handle identical/near-identical chunks.

**Non-Goals:**
- Changing the linked page scraping flow (`capturePageDOMChunks` / `LinkedPageScraper`).
- Changing the server API contract (route signatures, response formats).
- Optimizing the number of scroll-streamed chunks (each scroll step still uploads full outerHTML).

## Decisions

### D1: Omit `pageUrl` in main page scroll streaming

**Decision**: Remove `pageUrl: tabUrl` from the `SERVER_UPLOAD_HTML_CHUNK` message in `useScrapingDownloader.ts`.

**Rationale**: The server already defaults to `page_url_hash = "main"` when `pageUrl` is absent. By not sending it, all main page chunks (from scrolling and download phase) coalesce into the same `"main"` job. The DOM merge's superset detection then correctly picks the largest chunk as the final result.

**Alternative considered**: Send `pageUrl: undefined` explicitly. Rejected because `undefined` is stripped from JSON serialization by default, achieving the same result but adding unnecessary explicitness.

### D2: Deduplicate in `_safe_merge` before concatenation

**Decision**: Before concatenating body content in `_safe_merge`, check if each chunk's body content is a substring of (or identical to) the skeleton body. Skip chunks that don't add new content.

**Rationale**: `_safe_merge` is the fallback path triggered when HTML is "complex" (high element count, deep nesting, or detected duplication). The current implementation blindly concatenates, which is exactly what causes the duplication. Deduplication prevents the fallback from being worse than the primary path.

**Alternative considered**: Remove the "duplicate content detected" complexity trigger entirely so `_dom_merge` always runs. Rejected because `_dom_merge` can still produce duplication via the append path when chunks contain overlapping content that isn't detected by the first-child superset check. Fixing `_safe_merge` is safer as defense-in-depth.

### D3: Improve `_dom_merge` superset detection

**Decision**: Extend the superset check in `_dom_merge` to compare the full body content (not just first children). If the combined chunk body content is a subset of the skeleton body content, return the skeleton as-is.

**Rationale**: The current check only compares first body children. For scroll-based streaming, all chunks contain the same DOM (just progressively larger), so the first child always matches — the current check actually works for this case. But as defense-in-depth, comparing full body content handles edge cases where the first child differs but the rest is still a subset.

**Alternative considered**: Use content hash comparison instead of DOM comparison. Rejected because hash comparison doesn't handle the "progressively larger superset" case where content differs but one is a strict superset of the other.

## Risks / Trade-offs

- **[Risk] `_safe_merge` substring dedup is O(n*m)** where n=chunks and m=body size → Mitigation: Only run substring check when chunk count > 1 and skeleton body is non-empty. For the common single-chunk case, the check is skipped entirely.
- **[Risk] Removing `pageUrl` changes scroll chunk grouping** → Mitigation: This is the desired behavior. The `hasStreamedHtmlChunks()` check in `download-core.ts` already prevents double-uploading the final HTML, so coalescing into one job is safe.
- **[Risk] Full body comparison in `_dom_merge` is slower than first-child check** → Mitigation: Only run the full comparison when the first-child check fails (i.e., it's an additional check, not a replacement).
