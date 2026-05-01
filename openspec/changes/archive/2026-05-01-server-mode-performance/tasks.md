## 1. Client: Parallel Asset Processing

- [x] 1.1 In `src/background/download-core.ts` (`executeDownloadServerMode`), replace the sequential `await processImages` → `await processAssets` → `await processDocuments` chain with concurrent execution using `Promise.allSettled`. Start all three promises immediately. Await `imagesPromise` first (needed for `imageFilenameMap`), then upload the filename map, then await the remaining two promises with `Promise.allSettled`.
- [x] 1.2 Verify: server-mode download produces identical ZIP contents as before with parallel asset processing. Test with a page that has images, CSS, JS, and documents enabled.

## 2. Client: Upload Queue Concurrency

- [x] 2.1 In `src/background/upload-queue.ts`, change `DEFAULT_MAX_CONCURRENCY` from `5` to `12`.
- [x] 2.2 In `src/background/storage/server-storage-adapter.ts`, pass `{ maxConcurrency: 12 }` to the `UploadQueue` constructor (or rely on the new default).
- [x] 2.3 Verify: upload queue handles 12 concurrent uploads without errors. Test with a page that has 50+ resources.

## 3. Client: Promise-Based Queue Completion

- [x] 3.1 In `src/background/upload-queue.ts`, replace the `waitForAll()` 100ms polling loop with a promise-based notification mechanism. Add a `private doneResolvers: (() => void)[]` field. When `waitForAll()` is called while the queue is not empty, create and await a new promise, pushing its resolver. When the queue becomes empty (last task completes or fails), resolve all waiting promises. Ensure cancellation still works (reject on cancel).
- [x] 3.2 Verify: `waitForAll()` resolves immediately when queue is already empty. Resolves promptly (no 100ms delay) when the last upload completes.

## 4. Server: Batch DB Progress Flushes

- [x] 4.1 In `server/app/services/zip_assembler.py`, add a `flush: bool = True` keyword parameter to `_update_progress`. When `flush=False`, only update the in-memory session fields without calling `await db.flush()`.
- [x] 4.2 In `_assemble_zip`, update the resource loop to call `_update_progress` with `flush=False` for individual resources. Flush every 10 resources and at the end of each phase.
- [x] 4.3 In the linked pages loop inside `_assemble_zip`, apply the same batching (flush every N pages).
- [x] 4.4 Verify: assembly still completes correctly. Progress updates are slightly less granular but still useful. Test with 100+ resources.

## 5. Server: Parallel CSS Conversion

- [x] 5.1 In `server/app/services/zip_assembler.py` (`assemble_session`), replace the sequential CSS conversion loop with `asyncio.gather` + `asyncio.Semaphore(10)`. Each `_convert_css_resource` call wraps in the semaphore. Progress updates use batch flushing from task 4.
- [x] 5.2 Verify: CSS files are correctly converted with parallel processing. Compare ZIP output with sequential version.

## 6. Server: Parallel Linked Page Conversion

- [x] 6.1 In `server/app/services/zip_assembler.py` (`assemble_session`), replace the sequential linked page HTML conversion loop with `asyncio.gather` + `asyncio.Semaphore(10)`. Progress updates use batch flushing from task 4.
- [x] 6.2 Verify: linked pages are correctly converted with parallel processing. Compare ZIP output with sequential version for a multi-page download.

## 7. Server: Single-Parse HTML Conversion

- [x] 7.1 In `server/app/services/html_converter.py`, refactor `convert_html` to parse HTML once with `BeautifulSoup(html_string, "lxml")` and pass the `soup` object to each conversion function instead of having each function parse independently. Preserve the existing conversion order: remove base tag → convert links → convert images → convert background images → convert objects → convert stylesheets → convert scripts. Return `str(soup)` at the end.
- [x] 7.2 Refactor each `convert_*` function (`convert_links`, `convert_images`, `convert_background_images`, `convert_object_elements`, `convert_stylesheets`, `convert_scripts`) to accept a `BeautifulSoup` object and mutate it in-place instead of parsing an HTML string. The element selection and modification logic stays identical — only the parse wrapper and return statement change.
- [x] 7.3 Refactor `convert_linked_page_html` the same way: single parse, pass soup to each converter, return `str(soup)`.
- [x] 7.4 Verify: converted HTML output is identical before and after refactoring for a set of test pages (pages with images, CSS, JS, links, lazy-load attributes, srcset, inline styles, objects).

## 8. Client: Parallel HTML Chunk Uploads

- [x] 8.1 In `src/background/linked-page-scraper.ts` (`processQueue` server-mode section), replace the sequential `for` loop that uploads HTML chunks one at a time with `Promise.all(chunks.map(...))` to upload all chunks for a page concurrently. Preserve the scroll index in each call.
- [x] 8.2 Verify: linked pages upload correctly with concurrent chunk uploads. Server receives and stores chunks with correct scroll indices.

## 9. Client: Reduced Inter-Page Delay

- [x] 9.1 In `src/background/linked-page-scraper.ts`, change the default `delayBetweenPages` from `500` to `200`.
- [x] 9.2 Verify: linked page scraping works reliably with the reduced delay. No rate limiting errors from the server.

## 10. Client: Adaptive Polling

- [x] 10.1 In `src/background/server-download.ts`, replace the fixed `POLL_INTERVAL_MS = 2000` constant with a `getPollInterval(elapsedMs)` function: 1s for first 6s, 2s for 6-30s, 3s for 30-60s, 5s after 60s.
- [x] 10.2 Update `pollAssemblyStatus` to use `getPollInterval(elapsed)` instead of the constant.
- [x] 10.3 Verify: assembly polling works correctly with adaptive intervals. Fast assemblies get quicker response, long assemblies generate fewer requests.
