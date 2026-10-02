## Context
Five targeted changes to `html_merger.py` and `resources.py` that eliminate the memory explosion patterns identified in the OOM post-mortem. No new data flows, APIs, or dependencies are introduced.

## Goals / Non-Goals

**Goals:**
- Eliminate the `combined_html` string concatenation in `_analyze_job_complexity` that caused 850 MB–1.7 GB BeautifulSoup allocations for 17 MB pages.
- Remove all BeautifulSoup usage from hot-path utility functions (`_extract_body_content`, `_create_simple_html_wrapper`).
- Reduce nesting depth computation from O(N × D) to O(N).
- Replace unbuffered `await file.read()` for non-gzip uploads with chunked streaming to disk.

**Non-Goals:**
- Changing the `_dom_merge` path or `html_converter.py`.
- Raising or removing the 1 GB Docker memory limit.
- Optimizing BeautifulSoup usage in `convert_html` (runs once per page during URL conversion, not in tight loops).

## Decisions

### Fix 1 — `_analyze_job_complexity`: eliminate combined-HTML concatenation

**Current code** (`html_merger.py:604–620`):
```python
combined_html = skeleton_html
for chunk_path in job.chunks:
    chunk_html = f.read()
    chunk_tree = etree.HTML(chunk_html)
    combined_elements += len(list(chunk_tree.iter()))
    combined_html += chunk_html  # ← concatenates all chunks into one string
combined_result = self.analyze_html_complexity(combined_html)  # ← parses giant string
```
**Problem**: `combined_html` grows to 17 MB+ for large pages, then `analyze_html_complexity` builds an lxml tree (~85–170 MB) and a BeautifulSoup tree (~850 MB–1.7 GB) of that string simultaneously.

**New logic**:
1. Parse skeleton with lxml, count elements → early-exit if > 100K.
2. For each chunk: parse with lxml, add to element total → early-exit if > 100K.
3. After all chunks counted and total is below the element threshold, run `analyze_html_complexity` on the skeleton alone for nesting/table checks.
4. Additionally run `analyze_html_complexity` on each chunk individually, tracking the maximum nesting and table counts across all documents.
5. Delete `combined_html` string entirely.

The element count check remains accurate (it is a sum). Nesting and table counts are now correctly computed per document (the combined-string approach was producing incorrect results anyway, because lxml re-roots concatenated HTML and flattens inter-document nesting).

### Fix 2 — `_extract_body_content`: replace BeautifulSoup with string split

**Current code** (`html_merger.py:931–948`): Creates a `BeautifulSoup(html_content, "lxml")` tree just to call `body.decode_contents()`.

**New code**:
```python
lower = html_content.lower()
start_tag = lower.find("<body")
if start_tag == -1:
    # fall through to regex fallback
tag_close = html_content.find(">", start_tag)
end_tag = lower.rfind("</body>")
if tag_close != -1 and end_tag > tag_close:
    return html_content[tag_close + 1 : end_tag]
# existing regex fallback remains
```
This is O(N) in time and O(1) in additional memory (the returned slice references the original string; no parse tree is created). The string-split approach correctly handles all single-`<body>` pages (which is the entire expected input domain for this function).

**Note (implementation addition)**: A third lxml fallback was added beyond what is described here. When the string-split and regex paths both return nothing (i.e., the input is a bare HTML fragment with no `<body>` tag), `etree.HTML()` is used as a last resort, since lxml always wraps bare fragments in a full `html/body` structure. This fallback is only reached for fragment inputs — which are small by nature — so the parse overhead is acceptable and adds robustness at negligible cost.

### Fix 3 — `_create_simple_html_wrapper`: replace BeautifulSoup with lxml

**Current code** (`html_merger.py:957–963`): `BeautifulSoup(template_html, "lxml")` to extract `<title>` text and `<head>` innerHTML.

**New code**: Use the lxml tree already available (or create one if needed):
```python
tree = etree.HTML(template_html)
title_el = tree.find(".//title") if tree is not None else None
title = (title_el.text_content() if title_el is not None else None) or "Merged Content"
head_el = tree.find(".//head") if tree is not None else None
if head_el is not None:
    head_content = (head_el.text or "") + "".join(
        etree.tostring(c, encoding="unicode") for c in head_el
    )
else:
    head_content = ""
```
lxml memory overhead is ~5–10× the string size vs. BeautifulSoup's ~50–100×.

### Fix 4 — `analyze_html_complexity`: O(N × D) → O(N) nesting depth

**Current code** (`html_merger.py:662–665`):
```python
for elem in all_elements:      # N iterations
    depth = len(list(elem.iterancestors()))  # O(D) per element
```
**New code**: Single top-down pass using `tree.iter()` (parents always visited before children):
```python
depth_map: dict[int, int] = {}
max_nesting = 0
for elem in tree.iter():
    parent = elem.getparent()
    d = (depth_map.get(id(parent), -1) + 1) if parent is not None else 0
    depth_map[id(elem)] = d
    if d > max_nesting:
        max_nesting = d
```
This eliminates ~5M redundant iterator creations for a 100K-element DOM at depth 50.

### Fix 5 — `upload_resource`: stream non-gzip uploads

**Current code** (`resources.py:111`): `content = await file.read()` — buffers the entire upload file in memory.

**New flow for non-gzip uploads**:
1. Pre-check: if `Content-Length` header is present and alone would breach the session limit, reject immediately (413).
2. Write `UploadFile` chunks to disk via `file.read(chunk_size)` loop (e.g., 256 KB chunks).
3. After writing, compute `final_size = os.path.getsize(storage_path)`.
4. Perform the existing aggregate size query; if `current_total + final_size > limit` → delete the file, return 413.
5. Compute SHA-256 for dedup: stream the file back from disk (or use a `hashlib` update during write).

For gzip uploads: continue using `content = await file.read()` (full read is required for decompression). Since gzip is typically used for text assets which are much smaller than image binaries, this is acceptable.

SHA-256 dedup note: The original design considered accumulating a SHA-256 content hash during the streaming write to enable content-based deduplication without an extra disk read. During implementation it was decided to keep URL-hash dedup (`hashlib.sha256(originalUrl.encode())`) for the non-gzip path, for the following reasons:

1. **Consistency**: the gzip path already uses URL-hash dedup; different dedup semantics between paths would be surprising.
2. **No schema migration**: adding content-hash dedup requires a new `content_hash` column and index on the `resources` table — a separate change.
3. **Sufficient correctness**: URL-hash dedup prevents the same URL from being uploaded twice, which covers the primary dedup use-case (extension retransmitting the same resource on reconnect).

Content-hash dedup (stronger: catches same bytes under different URLs) is tracked as a future improvement.

## Risks / Trade-offs

- **Per-document nesting/table semantics change**: Nesting and table thresholds are now evaluated per-document (skeleton + each individual chunk) rather than on a merged concatenation. This is semantically more correct but is a behaviour change — a session that previously passed the complexity check may now be classified as complex if an individual chunk is deeply nested on its own. The practical risk is low: such a chunk would have been an invalid merged document anyway.
- **String-split body extraction**: The `find`/`rfind` approach does not handle pathological inputs such as `<body>` inside a comment or script tag. The existing regex fallback catches cases where the fast path's slice is empty or malformed. Inputs containing multiple `<body>` tags are handled correctly (the first open tag and last close tag are used).
- **Streaming write + size check TOCTOU**: Between writing to disk and running the aggregate size query, another concurrent request may also write — both could pass the limit check and together exceed it. This is the same race condition as the current implementation; a per-session advisory lock is the full fix but is out of scope for this change.
- **`depth_map` memory**: The O(N) algorithm allocates a `dict` proportional to DOM size. For a 100K-element DOM this is ~8–16 MB — well within budget and much less than the lxml tree itself.

## Unchanged
- The `_dom_merge` path is unchanged.
- The `_safe_merge` path is unchanged except that `_extract_body_content` and `_create_simple_html_wrapper` now use lighter implementations.
- `convert_html` and the full `html_converter.py` are unchanged (BeautifulSoup use there is intentional — it runs once per page during URL conversion, not inside tight loops).
- Docker memory limit (1 GB) is left at its current value. After these fixes, peak usage for a 17 MB Shopee page is estimated at ~200–300 MB.
