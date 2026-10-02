## Why

Server-mode downloads are significantly slower than local mode. The root cause is that the server-mode flow reuses the same sequential patterns designed for fast local I/O (IndexedDB writes take microseconds), but every operation now involves a network round trip (milliseconds). Key symptoms:

1. Images, CSS/JS, and documents are processed sequentially even though they're independent — each category blocks the next from starting uploads
2. Upload queue concurrency is capped at 5, far below what modern browsers and the server can handle
3. Server-side assembly does per-resource database flushes (200+ DB writes for a typical page)
4. HTML converter parses the document 7 separate times (once per element type) instead of once
5. CSS and linked-page conversions run sequentially on the server instead of in parallel
6. Linked page HTML chunks are uploaded one at a time instead of concurrently
7. Upload queue uses 100ms polling to detect completion instead of event-driven notification

Together these bottlenecks add 40-60% overhead compared to the theoretical minimum for the same network conditions.

## What Changes

- Parallelize independent asset processing (images, CSS/JS, documents) in the server-mode download flow
- Increase upload queue default concurrency from 5 to 12
- Replace upload queue polling with promise-based completion notification
- Batch database progress flushes during ZIP assembly (every 10 resources instead of every 1)
- Parallelize CSS file conversion using asyncio.gather with semaphore
- Parallelize linked page HTML conversion using asyncio.gather with semaphore
- Refactor HTML converter to parse once and apply all conversions on the same soup tree
- Parallelize linked page HTML chunk uploads using Promise.all
- Reduce default inter-page delay from 500ms to 200ms
- Implement adaptive polling interval (1s → 2s → 3s) based on elapsed time and progress

## Capabilities

### Modified Capabilities

- `download-engine`: Server-mode asset processing becomes parallel (images, CSS/JS, documents run concurrently via Promise.allSettled); upload queue concurrency increases to 12
- `extension-server-client`: Upload queue replaces polling-based waitForAll with promise-based notification
- `server-zip-assembly`: Assembly pipeline batches DB flushes, parallelizes CSS and linked-page conversions
- `server-html-converter`: HTML conversion parses document once instead of seven times; all conversion functions operate on a shared soup tree
- `linked-pages`: HTML chunk uploads become concurrent via Promise.all; inter-page delay reduced to 200ms

### Non-Goals

- Changing the fundamental server-mode architecture (extension scrapes, server assembles)
- Adding WebSocket or SSE for assembly progress (polling is retained but made adaptive)
- Modifying local-mode download flow
- Changing the server's REST API surface
- Adding async file I/O (aiofiles) — deferred to a future optimization pass
