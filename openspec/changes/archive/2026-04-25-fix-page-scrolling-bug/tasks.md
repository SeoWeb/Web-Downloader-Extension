## 1. Linked Page Adaptive Scrolling

- [x] 1.1 Replace the fixed-step for-loop in `scrollPageForLazyLoading` (linked-page-scraper.ts lines 647-654) with an adaptive while-loop for Pass 1 that re-reads `scrollHeight` after each step, resets a stability counter when height changes, and stops only after 3 consecutive stable-height checks at the bottom
- [x] 1.2 Apply the same adaptive while-loop logic to Pass 2 (linked-page-scraper.ts lines 667-674) with 150ms per-step timing
- [x] 1.3 Add layout-shift detection: if `scrollY` decreases after a scroll step (page jumped up), reset the stability counter and continue scrolling
- [x] 1.4 Add a max-iteration safety limit (e.g., 500 iterations) to the while-loop to prevent infinite scrolling on pathological pages

## 2. Main Page Scroll Function

- [x] 2.1 Extend the `ScrollResult` interface in fn.ts with an optional `heightChanged?: boolean` field
- [x] 2.2 Refactor `smoothScrollToBottom` in fn.ts to capture `scrollHeight` before and after each scroll step, set `heightChanged: true` when they differ, and use step size `Math.min(viewportHeight, 800)` instead of fixed 500px
- [x] 2.3 Add layout-shift detection in `smoothScrollToBottom`: if `scrollY` decreases after scrolling, record the jump and continue; set `heightChanged: true`

## 3. Main Page Bottom Detection

- [x] 3.1 In `useScrapingDownloader.ts`, track `prevHeight` from the previous scroll response
- [x] 3.2 Add page-growth awareness: if `currentHeight > prevHeight`, do NOT stop scrolling even if `isAtBottom` is true
- [x] 3.3 Implement a settle mechanism: when `isAtBottom` is first reached, wait one more scroll iteration to see if the page grows; only stop when at bottom AND height unchanged AND position unchanged

## 4. Verification

- [x] 4.1 Run `npx tsc --noEmit` to verify no TypeScript compilation errors
- [x] 4.2 Verify existing unit tests still pass (`npm test`)
