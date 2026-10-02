## Context

The server-mode download flow was designed as a direct translation of the local-mode pipeline: process images → process CSS/JS → process documents → process linked pages → assemble. In local mode this works because `IndexedDBAdapter.addFile()` completes in microseconds. In server mode, each `addFile()` enqueues an HTTP upload, and the sequential `await` chain means CSS uploads can't start until every image is enqueued.

The server-side assembly pipeline has a similar issue: it was built for correctness first and processes resources one at a time during ZIP creation, flushing to the database after each file. For a page with 200 resources this means 200+ database round-trips during the ZIP assembly phase alone.

The HTML converter compounds the problem by parsing the full HTML document independently for each of the 7 element types (links, images, background images, objects, stylesheets, scripts, base tag removal). Each BeautifulSoup parse of a 2MB document takes 50-200ms, so 7 parses = 350-1400ms per page.

## Goals / Non-Goals

**Goals:**

- Reduce server-mode download time by 40-60% for typical pages (30-80 resources)
- Maintain identical output quality (ZIP contents unchanged)
- Preserve all error handling, retry logic, and fallback mechanisms
- Keep changes testable in isolation per optimization

**Non-Goals:**

- Changing the extension-to-server communication protocol
- Adding WebSocket/SSE (polling retained with adaptive intervals)
- Modifying local-mode behavior
- Async file I/O migration (deferred)

## Decisions

### D1: Promise.allSettled for parallel asset processing

**Choice**: Use `Promise.allSettled` to run images, CSS/JS, and documents concurrently in `executeDownloadServerMode`.

**Rationale**: These three categories are fully independent — they upload to different server paths, have separate filename maps, and don't share state. The `imageFilenameMap` is needed for the filename map upload, but only the images promise needs to be awaited before that step. CSS/JS and documents can run in the background and be awaited after.

**Constraint**: The UploadQueue already manages concurrency (max N simultaneous uploads). Running all three categories in parallel doesn't bypass this limit — it just fills the queue from three sources instead of one, keeping the pipeline saturated.

### D2: Upload concurrency raised to 12

**Choice**: Increase `DEFAULT_MAX_CONCURRENCY` from 5 to 12.

**Rationale**: The server's rate limiter is set to 60 requests/second with burst of 100 (in `rate_limiter.py`). Even at 12 concurrent uploads with ~200ms average latency, that's only 60 requests/second — well within the limit. Chrome MV3 service workers can handle many concurrent `fetch()` calls since they don't have the per-domain connection limits of rendered pages.

### D3: Batch DB flushes every 10 resources

**Choice**: `_update_progress` gains a `flush` parameter (default `true`). During ZIP assembly, set `flush=False` for individual resources and flush every 10 resources or at phase boundaries.

**Rationale**: Progress polling is at 2-second intervals. Flushing every 10 resources still gives ~5% granularity (for 200 resources, that's 20 flushes vs 200). The polling client sees slightly less granular progress, but this is imperceptible to users.

### D4: asyncio.gather with Semaphore for server-side parallelism

**Choice**: Use `asyncio.gather` with `asyncio.Semaphore(10)` for CSS conversion and linked page HTML conversion.

**Rationale**: Each conversion runs in `asyncio.to_thread()`, which uses the default thread pool executor (typically `min(32, os.cpu_count() + 4)` workers). A semaphore of 10 prevents thread pool exhaustion while allowing meaningful parallelism. CSS files and linked pages are independent of each other — no shared mutable state.

### D5: Single-parse HTML conversion

**Choice**: Refactor `convert_html` and `convert_linked_page_html` to parse HTML once with BeautifulSoup and apply all 7 conversion passes on the same soup tree.

**Rationale**: Eliminates 6 redundant parses per page. For a 2MB page with 7 passes at 100ms each, this saves ~600ms per page. The conversion functions already operate on individual elements (find all `<img>`, find all `<script>`, etc.) — they just need to accept a `soup` object instead of an HTML string.

**Constraint**: Conversion order must be preserved (remove base → links → images → background images → objects → stylesheets → scripts) because some conversions modify attributes that later ones read.

### D6: Promise-based queue completion notification

**Choice**: Replace the 100ms polling loop in `waitForAll()` with a promise that resolves when the queue empties.

**Rationale**: The current 100ms polling loop wastes CPU cycles and adds up to 100ms of latency between the last upload completing and the caller being notified. A promise-based approach is both faster and more efficient.

### D7: Adaptive polling interval

**Choice**: Start at 1s, increase to 2s after 6s elapsed, 3s after 30s, 5s after 60s.

**Rationale**: Quick assemblies (5-10s) benefit from fast polling. Long assemblies don't need 2-second granularity. The server rate limiter allows it, but reducing unnecessary requests lightens server load.

## Detailed Design

### Client-Side Changes

#### Parallel Asset Processing (download-core.ts)

The current sequential flow in `executeDownloadServerMode` (lines ~760-783):
```
imageFilenameMap = await processImages(...)
await serverClient.uploadFilenameMap(...)
await processAssets(...)
await processDocuments(...)
```

Becomes:
```
const imagesPromise = downloadOptions.downloadImages
  ? processImages(data.images, storage, tabUrl, sendMessage)
  : Promise.resolve(EMPTY_MAP);
const assetsPromise = downloadOptions.downloadAssets
  ? processAssets(data, storage, tabUrl, sendMessage)
  : Promise.resolve();
const docsPromise = downloadOptions.downloadDocuments
  ? processDocuments(data.documents, storage, tabUrl, sendMessage)
  : Promise.resolve();

const [imagesResult, assetsResult, docsResult] = await Promise.allSettled([
  imagesPromise, assetsPromise, docsPromise,
]);

// Log non-images errors
if (assetsResult.status === "rejected") console.warn(...);
if (docsResult.status === "rejected") console.warn(...);

// Images are required — throw if rejected
if (imagesResult.status === "rejected") throw imagesResult.reason;
const imageFilenameMap = imagesResult.value;

// Upload filename map (needed for server-side HTML conversion)
if (imageFilenameMap.size > 0) {
  await serverClient.uploadFilenameMap(sessionId, Object.fromEntries(imageFilenameMap));
}
```

All three categories start concurrently and are awaited together with `Promise.allSettled`, so a failure in one category doesn't cancel the others. The filename map is uploaded after all three settle, since the image promise must be resolved before the map is available.

#### Upload Queue (upload-queue.ts)

1. Change `DEFAULT_MAX_CONCURRENCY = 5` → `12`
2. Replace `waitForAll()` polling with promise-based notification:
   - Add `private doneResolvers: (() => void)[] = []`
   - In `waitForAll()`: if not done, create a new promise and push its resolver
   - In `executeTask()`: after completing and queue is empty, resolve all waiting promises
   - In `handleTaskError()`: same resolution logic for non-retryable failures

#### Linked Page Scraper (linked-page-scraper.ts)

1. Parallelize HTML chunk uploads:
   ```
   // Current: sequential
   for (const chunk of chunks) { await uploadHtmlChunk(chunk, i, ...) }
   // New: concurrent
   await Promise.all(chunks.map((chunk, i) => uploadHtmlChunk(chunk, i, ...)))
   ```

2. Reduce `delayBetweenPages` default from 500ms to 200ms.

#### Adaptive Polling (server-download.ts)

Replace `const POLL_INTERVAL_MS = 2000` with a function:
```
function getPollInterval(elapsedMs: number): number {
  if (elapsedMs < 6000) return 1000;
  if (elapsedMs < 30000) return 2000;
  if (elapsedMs < 60000) return 3000;
  return 5000;
}
```

### Server-Side Changes

#### Batch DB Flushes (zip_assembler.py)

Add `flush` parameter to `_update_progress`:
```python
@staticmethod
async def _update_progress(db, session, phase, pct, *, flush=True):
    session.assembly_phase = phase
    session.assembly_progress_pct = max(0, min(100, pct))
    if flush:
        await db.flush()
```

In `_assemble_zip`, add batch flushing:
```python
batch_size = 10
for i, resource in enumerate(resources):
    # ... add to ZIP ...
    if (i + 1) % batch_size == 0:
        await self._update_progress(db, session, "assembling_zip", pct)
    else:
        session.assembly_progress_pct = pct  # update in-memory only
```

#### Parallel CSS Conversion (zip_assembler.py)

```python
sem = asyncio.Semaphore(10)
completed = 0

async def convert_one(resource):
    nonlocal completed
    async with sem:
        await self._convert_css_resource(resource, tab_url, filename_map, session_id)
        completed += 1
        pct = int(completed / max(total_css, 1) * 100)
        should_flush = completed % 10 == 0 or completed == total_css
        await self._update_progress(db, session, "converting_css", pct, flush=should_flush)

await asyncio.gather(*[convert_one(r) for r in css_resources])
```

#### Parallel Linked Page Conversion (zip_assembler.py)

Same semaphore pattern for the linked page conversion loop.

#### Single-Parse HTML Conversion (html_converter.py)

Refactor `convert_html` from:
```python
def convert_html(html_string, ...):
    html = _convert_links(html_string, ...)
    html = _remove_base_tag(html)
    html = _convert_images(html, ...)
    html = _convert_background_images(html, ...)
    html = _convert_object_elements(html, ...)
    html = _convert_stylesheets(html, ...)
    html = _convert_scripts(html, ...)
    return html
```

To:
```python
def convert_html(html_string, ...):
    soup = BeautifulSoup(html_string, "lxml")
    _remove_base_tag(soup)
    _convert_links(soup, ...)
    _convert_images(soup, ...)
    _convert_background_images(soup, ...)
    _convert_object_elements(soup, ...)
    _convert_stylesheets(soup, ...)
    _convert_scripts(soup, ...)
    return str(soup)
```

Each `convert_*` function changes from accepting `html_string` + returning `html_string` to accepting `soup` + mutating in-place. The element-level selection and modification logic stays identical.

## Impact Estimates

| Optimization | Time Saved (typical page) | Time Saved (complex page) |
|---|---|---|
| Parallel asset processing | 2-5s | 10-30s |
| Upload concurrency 5→12 | 1-3s | 5-15s |
| Batch DB flushes | 0.5-1s | 2-5s |
| Parallel CSS conversion | 0.2-0.5s | 1-3s |
| Parallel linked page conversion | 0.5-1s | 3-8s |
| Single-parse HTML conversion | 0.5-1s | 3-7s |
| Promise-based queue wait | ~0.1s | ~0.1s |
| Adaptive polling | ~0.5s | ~1s |
| Parallel chunk uploads | 0.2-0.5s | 1-3s |
| Reduced inter-page delay | 0.5-2s | 3-6s |

**Typical page** (30-80 resources, no linked pages): 5-14s saved
**Complex page** (150+ resources, 10-20 linked pages): 28-98s saved
