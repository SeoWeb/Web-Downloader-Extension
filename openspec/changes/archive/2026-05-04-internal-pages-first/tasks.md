## 1. Queue structure refactor

- [x] 1.1 Replace single `queue: LinkedPageJob[]` with `internalQueue` and `externalQueue` in `LinkedPageScraper`, add a `get combinedQueue()` getter for backwards compatibility with `getStats()` and any internal iteration
- [x] 1.2 Update `addToQueue()` to classify links as internal/external and route to the correct sub-queue: internal links always added (subject to `maxPages` cap), external links only added when `includeExternal` is true AND combined length < `maxPages`
- [x] 1.3 Update duplicate check in `addToQueue()` to search both sub-queues

## 2. Processing order changes

- [x] 2.1 Refactor `processQueue()` to iterate over internal pages first, then external pages, with a phase transition between the two
- [x] 2.2 Add `phase: "internal" | "external"` field to the `status.linkedPageProgress` message payload, reflecting the current sub-queue being processed
- [x] 2.3 Recalculate `total` and `current` in progress messages to reflect index within the current phase (e.g., internal pages 1-5, external pages 1-3)

## 3. UI changes

- [x] 3.1 Uncomment the "Include external links" checkbox in `src/components/Filter.tsx` (lines 376-385)

## 4. Build verification

- [x] 4.1 Run `npm run build` and fix any TypeScript errors
