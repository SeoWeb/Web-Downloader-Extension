## Why
On 2026-05-03, the server container was killed by the Docker OOM killer while assembling a large Shopee session (~17 MB of HTML chunks). Investigation traced the root cause to a cascade of overlapping memory spikes in the HTML merge pipeline — specifically in `_analyze_job_complexity`, which concatenates all chunk HTML into a single string and then parses it twice (once with lxml, once with BeautifulSoup), producing peak allocations far exceeding the 1 GB container limit. Secondary contributors include redundant BeautifulSoup parses elsewhere in the merge path and unbuffered resource upload reads under concurrent load.

## What Changes
- **Refactor `_analyze_job_complexity`**: Remove the `combined_html` string concatenation entirely. Element counts are already summed per-document with individual lxml parses; nesting and table analysis now runs on each document (skeleton + each chunk) independently rather than on one giant concatenated string.
- **Replace BeautifulSoup in `_extract_body_content`**: Use a fast string-split approach (`find`/`rfind`) for body extraction, with lxml as fallback. Eliminates one ~50–100× memory multiplier per call (called once per chunk in `_safe_merge`).
- **Replace BeautifulSoup in `_create_simple_html_wrapper`**: Use lxml to extract `<title>` and `<head>` content from the skeleton instead of creating a full BeautifulSoup tree.
- **Optimize nesting depth calculation**: Replace the O(N × D) `iterancestors()` loop in `analyze_html_complexity` with an O(N) parent-tracking traversal over the top-down element iterator.
- **Stream non-gzip resource uploads to disk**: Replace `await file.read()` with chunked streaming writes for non-gzip payloads; size limit enforced mid-stream with rollback on breach.

## Capabilities

### New Capabilities
_(none)_

### Modified Capabilities
- `server-html-merge`: The HTML complexity analysis algorithm changes. Nesting depth and table row checks now run on each document (skeleton and each chunk) independently, and the maximum is taken across all. The current implementation runs these checks on a concatenated multi-document string, which produces incorrect nesting results (lxml re-roots concatenated HTML, artificially flattening inter-document nesting). The per-document approach is semantically more correct.

## Impact
- `server/app/services/html_merger.py`: `_analyze_job_complexity`, `analyze_html_complexity`, `_extract_body_content`, `_create_simple_html_wrapper`
- `server/app/api/routes/resources.py`: `upload_resource` — non-gzip upload body handling
- No new dependencies. BeautifulSoup is removed from the utility functions above.
- Tests: `server/tests/test_html_merger.py`, `server/tests/test_zip_assembler.py`
