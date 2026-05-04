## Context

The `LinkedPageScraper` currently uses a single FIFO queue (`queue: LinkedPageJob[]`). When `includeExternal` is enabled, internal and external links are interleaved in DOM order. Since `maxPages` caps the queue size, external links appearing early in the HTML can push internal links out of the queue. Users generally prefer internal pages, with external pages as optional filler.

The `includeExternal` UI checkbox is already implemented in `Filter.tsx` but commented out (lines 376-385). The translation strings exist across all 45 locales. The `FilterOptions` type, filter store, and `download-core.ts` already plumb the `linkedPagesIncludeExternal` option through to the scraper.

## Goals / Non-Goals

**Goals:**
- Internal pages (same hostname) always fill the download queue first, up to `maxPages`
- External pages (different hostname) are only added to remaining capacity
- Newly discovered internal links during scraping retain priority over already-queued external links
- The "Include external links" checkbox is visible to users
- Progress messages distinguish the current phase

**Non-Goals:**
- Recursive depth-based crawling
- Per-domain external link limits
- Changing the `maxPages` default or range
- Changing the deduplication or non-HTML resource filtering logic
- Adding UI for external-link-specific options beyond the checkbox

## Decisions

### 1. Two-queue internal structure

The scraper will maintain two arrays internally: `internalQueue` and `externalQueue`, instead of a single `queue`. A getter `combinedQueue` provides compatibility with the existing `LinkedPageJob[]` interface.

**Alternative considered:** Single queue with internal-first sorting on insert. Rejected because links can be discovered at any time during scraping (not just at bulk-add), requiring repeated re-sorting to keep internals at the front. Two separate queues are simpler: append internal, append external, always process one then the other.

### 2. Combined capacity cap

Total capacity is `internalQueue.length + externalQueue.length ≤ maxPages`. Internal links are added eagerly (up to `maxPages`). External links are only added if combined length < `maxPages`.

This means an internal link discovered later during scraping can still be added even if external links are already queued, potentially pushing the final external count lower. This is intentional: internal priority is absolute.

### 3. Processing order

`processQueue()` processes all internal items first, then all external items. A phase transition occurs between the two. The `getStats()` method and progress messages use the combined dimensions.

### 4. Phase indicator in progress messages

The existing `status.linkedPageProgress` message gains an optional `phase` field (`"internal" | "external"`). This is additive — existing consumers that don't check `phase` still work.

### 5. Still uses `addToQueue()` interface

No changes to the caller site in `download-core.ts` — links are still passed through `addToQueue()` one at a time. The scraper classifies each link internally.

## Risks / Trade-offs

- **Link discovery order during scraping**: An internal page scraped early may discover external links that get queued before external links from the main page. This is acceptable since external links are filler — their relative order among themselves doesn't matter.
- **getStats() semantics**: `total` was the single queue length. Now it's the combined length of both queues. This should be transparent to callers since they only use the number.
- **UI regression**: If `includeExternal` is turned on by a user and then they clear storage, it defaults to off (unchanged from current default). The new behavior only activates when the checkbox is checked.
