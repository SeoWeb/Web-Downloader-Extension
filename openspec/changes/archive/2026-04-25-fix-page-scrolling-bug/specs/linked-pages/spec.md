## MODIFIED Requirements

### Requirement: Lazy Loading Support

The system SHALL scroll linked pages to trigger lazy-loaded content before capturing the DOM, using an adaptive single-pass scroll strategy that re-evaluates page height after each step and continues until the page height stabilizes.

#### Scenario: Page with lazy-loaded images

- GIVEN a linked page with images that load on scroll
- WHEN the page is scraped
- THEN the page is scrolled using a while-loop that checks `scrollY + viewportHeight >= scrollHeight - buffer` as the termination condition
- AND after each scroll step, `scrollHeight` is re-read to detect page growth
- AND if `scrollHeight` increased, the "at bottom" stability counter is reset
- AND scrolling continues until the page height has not changed for 3 consecutive checks
- AND the time-budget constraint (`remaining()`) and a max-iteration safety limit are enforced
- AND after reaching the bottom, an 800ms settle delay is observed to allow IntersectionObserver callbacks to fire
- AND the DOM is captured after the settle delay

#### Scenario: Page with IntersectionObserver-based loading

- GIVEN a linked page with content that loads via IntersectionObserver
- WHEN the page is scraped
- THEN the adaptive single-pass scroll strategy allows sufficient viewport time for observers to fire (300ms per step)
- AND dynamically loaded content is present in the captured DOM
- AND if new content causes the page to grow during scrolling, the scroll continues to the new bottom

#### Scenario: Page with layout shifts during scrolling

- GIVEN a linked page where content insertion causes the viewport to shift upward
- WHEN the page is scraped
- THEN the adaptive scroll logic detects that `scrollY` decreased (page jumped up)
- AND scrolling continues from the new position
- AND the stability counter is reset because the page height likely changed
