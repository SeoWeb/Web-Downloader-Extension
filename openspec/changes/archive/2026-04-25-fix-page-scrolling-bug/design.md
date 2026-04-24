## Context

The Website Downloader extension uses two separate scroll mechanisms to trigger lazy-loaded content:

1. **Linked pages** (`linked-page-scraper.ts`): A `scrollPageForLazyLoading` method injected via `chrome.scripting.executeScript`. It calculates `scrollSteps` once from the initial `scrollHeight` and iterates with a fixed for-loop. When lazy content loads, the page grows but the step count is never recalculated — the scroll stops short of the real bottom.

2. **Main page** (`fn.ts` + `useScrapingDownloader.ts`): `smoothScrollToBottom` scrolls by fixed 500px steps, returning one `ScrollResult` per call. The hook checks `isAtBottom` and stops immediately if true. Content that loads *after* reaching the nominal bottom is missed, and layout shifts that cause the viewport to "jump up" go undetected.

Both code paths run inside Chrome's content script context with a time budget derived from `pageTimeout`.

## Goals / Non-Goals

**Goals:**

- Adaptive scrolling that re-evaluates page height on every step and continues when the page grows
- Page-growth-aware bottom detection that requires height + position stability before stopping
- Handle layout shifts where the page "jumps up" after content insertion
- Maintain existing time-budget constraints and max-iteration safety limits

**Non-Goals:**

- Adding new UI or user-facing settings
- Server-side changes — all fixes are client-side (extension content scripts + React hook)

## Decisions

### Decision 1: Adaptive while-loop over fixed for-loop for linked-page scrolling

**Choice**: Replace the `for (let i = 0; i < scrollSteps; i++)` loop with a `while` loop that checks `scrollY + viewportHeight >= scrollHeight - buffer` as its termination condition.

**Rationale**: The fixed step count is the root cause — it cannot account for page growth. A while-loop that re-reads `scrollHeight` after each step naturally adapts to growing pages.

**Alternative considered**: Dynamically recalculating `scrollSteps` inside the for-loop. Rejected because it conflates step counting with position tracking — a while-loop is a cleaner expression of "keep scrolling until truly at the bottom."

### Decision 2: Height-stability counter for "at bottom" detection

**Choice**: Track `lastScrollHeight` and count consecutive iterations where height hasn't changed. Only declare "at bottom" after N (3) consecutive stable-height checks.

**Rationale**: A single height check can coincide with a point where lazy loading hasn't fired yet. Requiring stability over multiple checks ensures content has truly finished loading.

**Alternative considered**: Using a MutationObserver to watch for DOM changes. Rejected because it adds complexity, may not fire for all lazy-loading strategies (e.g., scroll-position-based), and doesn't integrate cleanly with the existing time-budget model.

### Decision 3: Extend ScrollResult with heightChanged flag

**Choice**: Add an optional `heightChanged?: boolean` field to the `ScrollResult` interface returned by `smoothScrollToBottom`.

**Rationale**: The hook needs to know whether the page grew during the last scroll step to make informed stop/continue decisions. Adding a flag is non-breaking (optional field) and keeps the data flow simple.

**Alternative considered**: Having the hook track height history itself. Rejected because the scroll function already observes height changes internally and is the natural place to report them.

### Decision 4: Larger step size for main-page scrolling

**Choice**: Increase step size from 500px to `Math.min(viewportHeight, 800)` pixels.

**Rationale**: 500px is small relative to modern viewports (often 900-1080px). Using viewport-relative sizing ensures we cover the page in fewer iterations while the adaptive logic prevents overshooting. Capping at 800px avoids skipping past small lazy-load trigger zones.

### Decision 5: Single adaptive pass instead of two-pass for linked pages

**Choice**: Remove the second scroll pass (Pass 2) and use a single adaptive pass with an 800ms settle delay instead of the previous two-pass strategy (Pass 1 + instant jump to top + Pass 2).

**Rationale**: The adaptive while-loop with height-stability checking (3 consecutive checks) already ensures all lazy content loads during a single pass — if content loads mid-scroll, the page grows, the stability counter resets, and scrolling continues. The previous two-pass strategy created a jarring visual effect (instant jump from bottom to top between passes). An 800ms settle delay at the bottom gives IntersectionObserver callbacks sufficient time to fire.

**Alternative considered**: Keeping two passes but scrolling from the bottom position instead of jumping to top. Rejected because the adaptive single pass already handles page growth, making a second pass redundant.

## Risks / Trade-offs

- **[Longer scroll time on dynamic pages]** → Adaptive scrolling will continue longer on pages that keep growing. Mitigated by existing time-budget constraint and max-iteration safety limit.
- **[heightChanged flag could be misinterpreted]** → If a future caller treats `heightChanged=false` as "page will never grow again," it could stop too early. Mitigated by documenting that `heightChanged` only reflects the *last scroll step*, not the page's final state.
- **[Layout shift detection adds per-step overhead]** → Reading `scrollHeight` and `scrollY` after each step adds negligible cost vs the sleep/delay between steps.
