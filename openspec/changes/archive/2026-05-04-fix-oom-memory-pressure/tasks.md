## 1. `html_merger.py` — Core Memory Fixes

- [x] 1.1 Refactor `_analyze_job_complexity` to eliminate `combined_html` string: count elements per-document with early-exit, then run `analyze_html_complexity` on skeleton and each chunk independently, tracking max nesting/table values across all documents
- [x] 1.2 Replace BeautifulSoup in `_extract_body_content` with `find`/`rfind` string-split approach (keep existing regex as fallback)
- [x] 1.3 Replace BeautifulSoup in `_create_simple_html_wrapper` with lxml (`etree.HTML`) for `<title>` and `<head>` extraction
- [x] 1.4 Optimize nesting depth in `analyze_html_complexity` from O(N × D) `iterancestors()` to O(N) top-down `depth_map` traversal

## 2. `resources.py` — Streaming Upload

- [x] 2.1 Add `request: Request` parameter to `upload_resource` and add `from fastapi import Request` import
- [x] 2.2 Add early Content-Length pre-check: reject 413 immediately if header alone exceeds remaining session quota
- [x] 2.3 Replace `content = await file.read()` in non-gzip path with 256 KB chunked streaming write to disk, accumulating SHA-256 hash during write
- [x] 2.4 Move post-write aggregate size check: query current total, delete file and return 413 if `current_total + final_size > limit`
- [x] 2.5 Move dedup check to after size check, using hash from streaming hasher; delete newly written file if duplicate found

## 3. Tests and Verification

- [x] 3.1 Run `cd server && python -m pytest tests/test_html_merger.py -x -q` and fix any failures from complexity analysis, body extraction, or wrapper changes
- [x] 3.2 Run `cd server && python -m pytest tests/test_zip_assembler.py -x -q` and fix any failures from end-to-end assembly changes
- [x] 3.3 Run full test suite `cd server && python -m pytest tests/ -x -q` and confirm no regressions
