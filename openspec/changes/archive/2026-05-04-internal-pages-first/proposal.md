## Why

When "Include external links" is enabled, internal and external pages are mixed in the download queue in DOM order (the order they appear in the HTML). External pages can crowd out internal pages, hitting the `maxPages` cap before all internal pages are queued. Users typically care more about internal (same-site) pages and want them guaranteed, with external pages only as filler.

## What Changes

- Internal pages (same hostname) always fill the download queue first, up to `maxPages`
- External pages (different hostname) are added only to remaining capacity — they never displace internal pages
- When `includeExternal` is off, external pages are skipped entirely (unchanged)
- The "Include external links" checkbox is uncommented in the UI so users can opt in to external pages
- Progress reporting distinguishes internal vs external phases (e.g. "Page 5/10 (internal)" → "Page 8/10 (external)")

## Capabilities

### New Capabilities

None — this is a modification of existing queue behavior.

### Modified Capabilities

- `linked-pages`: Queue management scenarios change — external links, when enabled, are deprioritized behind internal links rather than mixed in DOM order

## Impact

- `src/background/linked-page-scraper.ts` — queue structure and `addToQueue()`, `processQueue()`, progress reporting
- `src/components/Filter.tsx` — uncomment the "Include external links" checkbox
- User-visible: Scraping progress messages now include an internal/external phase indicator
