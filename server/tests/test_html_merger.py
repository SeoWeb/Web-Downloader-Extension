#!/usr/bin/env python3
"""Verification script for HTML Merge Service (task 4.9).

Tests that the server-side merge produces equivalent output to the
client-side merge-html.ts + HtmlAssembler.ts for representative inputs.
"""

import hashlib
import os
import re
import sys
import tempfile

# Add parent directory to path so we can import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.html_merger import (
    HtmlMergerService,
    ComplexityResult,
    MergeResult,
    COMPLEXITY_ELEMENT_THRESHOLD,
    COMPLEXITY_NESTING_THRESHOLD,
    COMPLEXITY_TABLE_ROW_THRESHOLD,
)


def make_test_dir():
    """Create a temporary directory for test storage."""
    return tempfile.mkdtemp(prefix="html_merger_test_")


# ---------------------------------------------------------------------------
# Test 1: Skeleton initialization with insertion point detection
# ---------------------------------------------------------------------------

def test_skeleton_initialization():
    """First chunk should initialize the skeleton with </body> insertion point."""
    service = HtmlMergerService(storage_root=make_test_dir())
    job = service.get_or_create_job("test-session-1", "main", page_type="main")

    skeleton_html = """<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body><p>Initial content</p></body>
</html>"""

    service.initialize_skeleton(job, skeleton_html)

    assert job.initialized, "Job should be initialized"
    assert job.skeleton_path is not None, "Skeleton path should be set"
    assert os.path.exists(job.skeleton_path), "Skeleton file should exist on disk"

    with open(job.skeleton_path, "r") as f:
        stored = f.read()
    assert "</body>" in stored.lower(), "Skeleton should contain </body> insertion point"

    print("  PASS: test_skeleton_initialization")


# ---------------------------------------------------------------------------
# Test 2: Chunk deduplication by content hash AND scrollIndex
# ---------------------------------------------------------------------------

def test_chunk_deduplication():
    """Same content + same scrollIndex → duplicate. Same content + different scrollIndex → NOT duplicate."""
    service = HtmlMergerService(storage_root=make_test_dir())

    # Create a job and register some chunks
    job = service.get_or_create_job("test-session-2", "main")

    content_hash_1 = service.compute_content_hash("<p>Chunk A</p>")
    content_hash_2 = service.compute_content_hash("<p>Chunk B</p>")

    # Same content, same scrollIndex → duplicate
    service.register_chunk(job, content_hash_1, scroll_index=0, storage_path="/tmp/chunk0.html", size=100)
    assert service.is_duplicate_chunk(job, content_hash_1, scroll_index=0), \
        "Same content + same scrollIndex should be duplicate"

    # Same content, different scrollIndex → NOT duplicate
    assert not service.is_duplicate_chunk(job, content_hash_1, scroll_index=1), \
        "Same content + different scrollIndex should NOT be duplicate"

    # Different content, same scrollIndex → NOT duplicate
    assert not service.is_duplicate_chunk(job, content_hash_2, scroll_index=0), \
        "Different content + same scrollIndex should NOT be duplicate"

    print("  PASS: test_chunk_deduplication")


# ---------------------------------------------------------------------------
# Test 3: Full merge on finalization (chunks inserted before </body>)
# ---------------------------------------------------------------------------

def test_full_merge():
    """Chunks should be inserted before </body> in the skeleton."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-3"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    skeleton_html = """<!DOCTYPE html>
<html>
<head><title>Merge Test</title></head>
<body><div id="content">Skeleton content</div></body>
</html>"""

    service.initialize_skeleton(job, skeleton_html)

    # Create chunk files
    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)

    chunk1_html = "<p>Chunk 1 content</p>"
    chunk1_path = os.path.join(chunk_dir, "1.html")
    with open(chunk1_path, "w") as f:
        f.write(chunk1_html)
    hash1 = service.compute_content_hash(chunk1_html)
    service.register_chunk(job, hash1, scroll_index=1, storage_path=chunk1_path, size=len(chunk1_html))

    chunk2_html = "<p>Chunk 2 content</p>"
    chunk2_path = os.path.join(chunk_dir, "2.html")
    with open(chunk2_path, "w") as f:
        f.write(chunk2_html)
    hash2 = service.compute_content_hash(chunk2_html)
    service.register_chunk(job, hash2, scroll_index=2, storage_path=chunk2_path, size=len(chunk2_html))

    # Merge
    results = service.merge_session(session_id)
    assert "main" in results, "Should have main page result"
    result = results["main"]
    assert result.success, f"Merge should succeed: {result.reason}"

    # Verify chunks are in the output
    assert "Chunk 1 content" in result.html, "Chunk 1 content should be in merged HTML"
    assert "Chunk 2 content" in result.html, "Chunk 2 content should be in merged HTML"
    assert "Skeleton content" in result.html, "Skeleton content should be preserved"
    assert "<body" in result.html.lower(), "Merged HTML should have body tag"

    # Verify chunk files and skeleton were cleaned up after merge
    assert not os.path.exists(chunk1_path), "Chunk file should be deleted after merge"
    assert not os.path.exists(chunk2_path), "Chunk file should be deleted after merge"
    assert not os.path.exists(job.skeleton_path), "Skeleton file should be deleted after merge"

    print("  PASS: test_full_merge")


# ---------------------------------------------------------------------------
# Test 4: Safe merge fallback for complex HTML
# ---------------------------------------------------------------------------

def test_safe_merge_fallback():
    """Complex HTML should trigger safe merge (body-content concatenation)."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-4"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    # Create a complex HTML document with many elements
    elements = "".join(f"<div><p>Element {i}</p></div>" for i in range(150000))
    skeleton_html = f"""<!DOCTYPE html>
<html>
<head><title>Complex Page</title></head>
<body>{elements}</body>
</html>"""

    service.initialize_skeleton(job, skeleton_html)

    # Add a chunk
    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = "<p>Additional content</p>"
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    # Complexity should be detected
    complexity = service.analyze_html_complexity(skeleton_html)
    assert complexity.is_complex, f"HTML should be detected as complex: {complexity.reason}"

    # Merge should use safe fallback
    results = service.merge_session(session_id)
    result = results["main"]
    assert result.success, f"Safe merge should succeed: {result.reason}"
    assert "Additional content" in result.html, "Chunk content should be in safe-merged HTML"
    assert result.stats and result.stats.get("safe_merge"), "Should indicate safe_merge was used"

    print("  PASS: test_safe_merge_fallback")


# ---------------------------------------------------------------------------
# Test 5: HTML complexity analysis
# ---------------------------------------------------------------------------

def test_complexity_analysis():
    """Verify complexity analysis detects various problematic patterns."""
    service = HtmlMergerService()

    # Normal HTML → not complex
    normal_html = "<html><head><title>Normal</title></head><body><p>Hello</p></body></html>"
    result = service.analyze_html_complexity(normal_html)
    assert not result.is_complex, "Normal HTML should not be complex"

    # Deep nesting → complex
    deep_html = "<html><body>" + "<div>" * 60 + "content" + "</div>" * 60 + "</body></html>"
    result = service.analyze_html_complexity(deep_html)
    assert result.is_complex, "Deep nesting should be complex"
    assert "nest" in (result.reason or "").lower(), "Reason should mention nesting"

    # Large table → complex
    rows = "".join(f"<tr><td>Row {i}</td></tr>" for i in range(6000))
    table_html = f"<html><body><table>{rows}</table></body></html>"
    result = service.analyze_html_complexity(table_html)
    assert result.is_complex, "Large table should be complex"
    assert "table" in (result.reason or "").lower(), "Reason should mention table"

    print("  PASS: test_complexity_analysis")


# ---------------------------------------------------------------------------
# Test 6: Merged HTML validation
# ---------------------------------------------------------------------------

def test_html_validation():
    """Validate merged HTML well-formedness."""
    service = HtmlMergerService()

    # Valid HTML
    valid = "<!DOCTYPE html><html><head><title>Test</title></head><body><p>Hi</p></body></html>"
    assert service.validate_html(valid), "Valid HTML should pass validation"

    # Invalid: no body
    no_body = "<!DOCTYPE html><html><head><title>Test</title></head></html>"
    assert not service.validate_html(no_body), "HTML without body should fail validation"

    # Invalid: empty string
    assert not service.validate_html(""), "Empty string should fail validation"

    # Invalid: plain text (no HTML tags)
    assert not service.validate_html("Just some text"), "Plain text should fail validation"

    print("  PASS: test_html_validation")


# ---------------------------------------------------------------------------
# Test 7: Linked page merge (separate per pageUrl)
# ---------------------------------------------------------------------------

def test_linked_page_merge():
    """Linked pages should be merged independently and stored in pages/ directory."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-5"

    # Create main page job
    main_job = service.get_or_create_job(session_id, "main", page_type="main")
    main_skeleton = "<html><head><title>Main</title></head><body><p>Main content</p></body></html>"
    service.initialize_skeleton(main_job, main_skeleton)

    # Create linked page job
    page_url = "https://example.com/about"
    page_url_hash = hashlib.sha256(page_url.encode("utf-8")).hexdigest()[:16]
    linked_job = service.get_or_create_job(
        session_id, page_url_hash, page_type="linked", page_url=page_url
    )
    linked_skeleton = "<html><head><title>About</title></head><body><p>About content</p></body></html>"
    service.initialize_skeleton(linked_job, linked_skeleton)

    # Add chunk to linked page
    chunk_dir = os.path.join(storage, session_id, "chunks", "linked", page_url_hash)
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = "<p>More about content</p>"
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(linked_job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    # Merge linked pages
    results = service.merge_linked_pages(session_id)
    assert page_url_hash in results, f"Should have result for page {page_url_hash}"
    result = results[page_url_hash]
    assert result.success, f"Linked page merge should succeed: {result.reason}"

    # Verify page file was stored in pages/ directory
    pages_dir = os.path.join(storage, session_id, "pages")
    page_path = os.path.join(pages_dir, f"{page_url_hash}.html")
    assert os.path.exists(page_path), f"Linked page file should exist at {page_path}"

    with open(page_path, "r") as f:
        stored = f.read()
    assert "About content" in stored, "Linked page content should be in stored file"
    assert "More about content" in stored, "Chunk content should be in linked page"

    print("  PASS: test_linked_page_merge")


# ---------------------------------------------------------------------------
# Test 8: Disk-based job loading (for server restart scenarios)
# ---------------------------------------------------------------------------

def test_disk_based_loading():
    """Jobs should be loadable from disk after server restart (no in-memory state)."""
    storage = make_test_dir()
    session_id = "test-session-6"

    # First: create and populate jobs with service 1
    service1 = HtmlMergerService(storage_root=storage)

    main_job = service1.get_or_create_job(session_id, "main", page_type="main")
    main_skeleton = "<html><head><title>Restart Test</title></head><body><p>Initial</p></body></html>"
    service1.initialize_skeleton(main_job, main_skeleton)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = "<p>Chunk after restart</p>"
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service1.compute_content_hash(chunk_html)
    service1.register_chunk(main_job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    # Simulate server restart: new service instance with no in-memory jobs
    service2 = HtmlMergerService(storage_root=storage)

    # Load from disk and merge
    results = service2.merge_session(session_id)
    assert "main" in results, "Should have main page result"
    result = results["main"]
    assert result.success, f"Disk-based merge should succeed: {result.reason}"
    assert "Initial" in result.html, "Skeleton content should be preserved"
    assert "Chunk after restart" in result.html, "Chunk content should be in merged HTML"

    print("  PASS: test_disk_based_loading")


# ---------------------------------------------------------------------------
# Test 9: Merge with no insertion point (skeleton without </body>)
# ---------------------------------------------------------------------------

def test_chunk_cleanup_after_safe_merge():
    """Chunk and skeleton files should be cleaned up after safe merge too."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-cleanup-safe"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    # Create complex HTML to trigger safe merge
    elements = "".join(f"<div><p>Element {i}</p></div>" for i in range(150000))
    skeleton_html = f"""<!DOCTYPE html>
<html>
<head><title>Cleanup Test</title></head>
<body>{elements}</body>
</html>"""

    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = "<p>Additional content</p>"
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    skeleton_path = job.skeleton_path

    results = service.merge_session(session_id)
    result = results["main"]
    assert result.success, f"Safe merge should succeed: {result.reason}"

    # Verify chunk and skeleton files are cleaned up
    assert not os.path.exists(chunk_path), "Chunk file should be deleted after safe merge"
    assert not os.path.exists(skeleton_path), "Skeleton file should be deleted after safe merge"

    print("  PASS: test_chunk_cleanup_after_safe_merge")


def test_no_body_tag():
    """Skeleton without </body> should still work via fallback."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-7"

    job = service.get_or_create_job(session_id, "main", page_type="main")

    # HTML with no </body> but has </html>
    skeleton_html = """<!DOCTYPE html>
<html>
<head><title>No Body Close</title></head>
<body><p>Content without body close</p>
</html>"""

    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = "<p>Extra content</p>"
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    results = service.merge_session(session_id)
    result = results["main"]
    assert result.success, f"Merge without body close should succeed: {result.reason}"

    print("  PASS: test_no_body_tag")


# ---------------------------------------------------------------------------
# Test 11: Safe merge deduplicates identical body content
# ---------------------------------------------------------------------------

def test_safe_merge_deduplication():
    """Safe merge should not duplicate body content when chunks are identical to skeleton."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-dedup-safe"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    body_content = "<div id='__next'><p>Hello World</p></div>"
    skeleton_html = f"""<!DOCTYPE html>
<html>
<head><title>Dedup Test</title></head>
<body>{body_content}</body>
</html>"""

    service.initialize_skeleton(job, skeleton_html)

    # Add 3 chunks with identical body content to the skeleton
    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)

    for i in range(1, 4):
        chunk_html = f"<html><head><title>Dedup</title></head><body>{body_content}</body></html>"
        chunk_path = os.path.join(chunk_dir, f"{i}.html")
        with open(chunk_path, "w") as f:
            f.write(chunk_html)
        chunk_hash = service.compute_content_hash(chunk_html)
        service.register_chunk(job, chunk_hash, scroll_index=i, storage_path=chunk_path, size=len(chunk_html))

    # Force safe merge by making the content trigger complexity detection
    # (We'll test _safe_merge directly since normal merge may take DOM path)
    result = service._safe_merge(job, skeleton_html)
    assert result.success, f"Safe merge should succeed: {result.reason}"

    # Body content should appear exactly once
    count = result.html.count("Hello World")
    assert count == 1, f"Body content should appear once, but found {count} times"

    print("  PASS: test_safe_merge_deduplication")


# ---------------------------------------------------------------------------
# Test 12: DOM merge superset detection with identical chunks
# ---------------------------------------------------------------------------

def test_dom_merge_superset_identical_chunks():
    """DOM merge should detect identical chunks as superset and return skeleton."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-dom-superset"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    skeleton_html = """<!DOCTYPE html>
<html>
<head><title>Superset Test</title></head>
<body><noscript>tracker</noscript><div id="__next"><p>Main content</p></div></body>
</html>"""

    service.initialize_skeleton(job, skeleton_html)

    # Add chunk with identical body content
    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)

    chunk_html = """<html>
<head><title>Superset Test</title></head>
<body><noscript>tracker</noscript><div id="__next"><p>Main content</p></div></body>
</html>"""
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    # DOM merge should detect superset and return skeleton unchanged
    result_html = service._dom_merge(job, skeleton_html)

    # Body content should appear exactly once
    count = result_html.count("Main content")
    assert count == 1, f"Content should appear once in DOM merge, but found {count} times"

    print("  PASS: test_dom_merge_superset_identical_chunks")


# ---------------------------------------------------------------------------
# Test 13: DOM merge full-body subset check
# ---------------------------------------------------------------------------

def test_dom_merge_full_body_subset():
    """DOM merge should detect chunk body is subset of skeleton body."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-body-subset"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    skeleton_html = """<!DOCTYPE html>
<html>
<head><title>Subset Test</title></head>
<body><p>Part 1</p><p>Part 2</p><p>Part 3</p></body>
</html>"""

    service.initialize_skeleton(job, skeleton_html)

    # Add chunk whose body is a substring of skeleton body
    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)

    chunk_html = """<html>
<head><title>Subset Test</title></head>
<body><p>Part 1</p><p>Part 2</p><p>Part 3</p></body>
</html>"""
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    result_html = service._dom_merge(job, skeleton_html)

    # Should return skeleton unchanged (subset detected)
    count = result_html.count("Part 1")
    assert count == 1, f"Content should appear once, but found {count} times"

    print("  PASS: test_dom_merge_full_body_subset")


# ---------------------------------------------------------------------------
# Test 14: _analyze_job_complexity — early-exit on element threshold
# ---------------------------------------------------------------------------

def test_analyze_job_complexity_early_exit_on_element_threshold():
    """_analyze_job_complexity must short-circuit as soon as the running element
    total crosses COMPLEXITY_ELEMENT_THRESHOLD during per-chunk counting.

    Spec scenario (new): 'Early-exit on element threshold'
    - WHEN the running element count total exceeds 100,000 during per-chunk counting
    - THEN the server immediately returns is_complex=True without processing
      remaining chunks.

    Verification: after skeleton (~50K) + chunk 1 (~60K) the total crosses
    100K, so chunk 2 must NOT be counted.  The reported element_count must be
    well below skeleton + chunk1 + chunk2 combined (~170K).
    """
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-early-exit"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    # Skeleton: ~50K flat <p> elements  (lxml adds html/head/body → ~50003 total)
    HALF = COMPLEXITY_ELEMENT_THRESHOLD // 2
    skeleton_html = "<html><body>" + "<p>x</p>" * HALF + "</body></html>"
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)

    # Chunk 1: ~60K elements — skeleton + chunk1 ≈ 110K > 100K threshold
    chunk1_html = "<html><body>" + "<p>y</p>" * (HALF + 10_000) + "</body></html>"
    chunk1_path = os.path.join(chunk_dir, "1.html")
    with open(chunk1_path, "w") as f:
        f.write(chunk1_html)
    service.register_chunk(
        job,
        service.compute_content_hash(chunk1_html),
        scroll_index=1,
        storage_path=chunk1_path,
        size=len(chunk1_html),
    )

    # Chunk 2: another ~60K — should never be reached
    chunk2_html = "<html><body>" + "<p>z</p>" * (HALF + 10_000) + "</body></html>"
    chunk2_path = os.path.join(chunk_dir, "2.html")
    with open(chunk2_path, "w") as f:
        f.write(chunk2_html)
    service.register_chunk(
        job,
        service.compute_content_hash(chunk2_html),
        scroll_index=2,
        storage_path=chunk2_path,
        size=len(chunk2_html),
    )

    result = service._analyze_job_complexity(job, skeleton_html)

    assert result.is_complex, "Should be complex due to combined element count"
    assert "Too many elements" in (result.reason or ""), (
        f"Reason should mention elements: {result.reason}"
    )
    # Early-exit leaves chunk 2 uncounted.  If chunk 2 had been counted the
    # total would be ~170K; we allow a generous upper bound of 130K to confirm
    # the function actually exited after chunk 1.
    assert result.element_count < 130_000, (
        f"Early-exit expected after ~{COMPLEXITY_ELEMENT_THRESHOLD} elements, "
        f"got {result.element_count} — chunk 2 may have been counted"
    )

    print("  PASS: test_analyze_job_complexity_early_exit_on_element_threshold")


# ---------------------------------------------------------------------------
# Test 15: _analyze_job_complexity — per-document nesting detection
# ---------------------------------------------------------------------------

def test_analyze_job_complexity_per_document_nesting():
    """_analyze_job_complexity must detect deep nesting in an individual chunk.

    Spec scenario (updated): 'Deeply nested structure detected'
    - WHEN ANY individual document (skeleton OR any chunk) contains elements
      with more than 50 levels of nesting
    - THEN is_complex=True

    The old combined-HTML approach flattened inter-document nesting (lxml
    re-roots concatenated HTML), so a deeply nested chunk could escape
    detection.  Per-document analysis must catch it.
    """
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-per-doc-nesting"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    # Skeleton: shallow — not complex on its own
    skeleton_html = "<html><head></head><body><div><p>shallow</p></div></body></html>"
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)

    # Chunk: nesting depth = COMPLEXITY_NESTING_THRESHOLD + 10 → complex alone
    depth = COMPLEXITY_NESTING_THRESHOLD + 10
    chunk_html = (
        "<html><body>"
        + "<div>" * depth
        + "deep"
        + "</div>" * depth
        + "</body></html>"
    )
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    service.register_chunk(
        job,
        service.compute_content_hash(chunk_html),
        scroll_index=1,
        storage_path=chunk_path,
        size=len(chunk_html),
    )

    result = service._analyze_job_complexity(job, skeleton_html)

    assert result.is_complex, (
        "Job should be complex when any chunk is deeply nested"
    )
    assert result.max_nesting > COMPLEXITY_NESTING_THRESHOLD, (
        f"max_nesting {result.max_nesting} should exceed {COMPLEXITY_NESTING_THRESHOLD}"
    )
    assert "nest" in (result.reason or "").lower(), (
        f"Reason should mention nesting: {result.reason}"
    )

    print("  PASS: test_analyze_job_complexity_per_document_nesting")


# ---------------------------------------------------------------------------
# Test 16: _analyze_job_complexity — per-document large-table detection
# ---------------------------------------------------------------------------

def test_analyze_job_complexity_per_document_large_table():
    """_analyze_job_complexity must detect a large table in an individual chunk.

    Spec scenario (updated): 'Large table detected'
    - WHEN ANY individual document contains a table with more than 5,000 rows
    - THEN is_complex=True
    """
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-per-doc-table"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    # Skeleton: normal — not complex
    skeleton_html = "<html><head></head><body><p>normal content</p></body></html>"
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)

    # Chunk: table with COMPLEXITY_TABLE_ROW_THRESHOLD + 1000 rows → complex alone
    rows = "".join(
        f"<tr><td>Row {i}</td></tr>"
        for i in range(COMPLEXITY_TABLE_ROW_THRESHOLD + 1000)
    )
    chunk_html = f"<html><body><table>{rows}</table></body></html>"
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    service.register_chunk(
        job,
        service.compute_content_hash(chunk_html),
        scroll_index=1,
        storage_path=chunk_path,
        size=len(chunk_html),
    )

    result = service._analyze_job_complexity(job, skeleton_html)

    assert result.is_complex, (
        "Job should be complex when any chunk contains a large table"
    )
    assert result.large_table_count > 0, (
        "large_table_count should be > 0"
    )
    assert "table" in (result.reason or "").lower(), (
        f"Reason should mention table: {result.reason}"
    )

    print("  PASS: test_analyze_job_complexity_per_document_large_table")

# ---------------------------------------------------------------------------
# 3.6 – Restart-during-upload: first-scroll chunk must not be emitted twice
# ---------------------------------------------------------------------------

def test_restart_no_first_scroll_duplication():
    """Restart recovery: when the skeleton is reconstructed from / already
    contains the scrollIndex-0 chunk, that chunk is consumed and the merged
    output contains the first screen exactly once."""
    storage = make_test_dir()
    session_id = "restart-session-1"
    service = HtmlMergerService(storage_root=storage)

    # Upload route behavior: first chunk (scrollIndex 0) initializes the
    # skeleton and is NOT registered as an incremental chunk.
    first_screen = (
        "<!DOCTYPE html><html><head><title>Restart</title></head>"
        "<body><p>First screen</p></body></html>"
    )
    job = service.get_or_create_job(session_id, "main", page_type="main")
    service.initialize_skeleton(job, first_screen)

    # Chunk files on disk: 0.html (the skeleton source) + subsequent scrolls
    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    with open(os.path.join(chunk_dir, "0.html"), "w") as f:
        f.write(first_screen)
    with open(os.path.join(chunk_dir, "1.html"), "w") as f:
        f.write("<html><body><p>Second screen</p></body></html>")

    # Simulate a server restart: a FRESH service instance with no in-memory
    # jobs must load the job from disk.
    fresh = HtmlMergerService(storage_root=storage)
    results = fresh.merge_session(session_id)

    assert "main" in results, "main page must be merged"
    result = results["main"]
    assert result.success, f"merge failed: {result.reason}"
    assert result.html.count("First screen") == 1, (
        "first-screen content must appear exactly once after restart recovery"
    )
    assert result.html.count("Second screen") == 1, (
        "later scroll content must still be merged in"
    )

    print("  PASS: test_restart_no_first_scroll_duplication")


def test_restart_skeleton_with_differing_first_chunk_still_merged():
    """A 0.html chunk whose content is NOT part of the skeleton is treated
    as real chunk content (not consumed)."""
    storage = make_test_dir()
    session_id = "restart-session-2"
    service = HtmlMergerService(storage_root=storage)

    skeleton_html = (
        "<!DOCTYPE html><html><head><title>Differ</title></head>"
        "<body><p>Skeleton body</p></body></html>"
    )
    job = service.get_or_create_job(session_id, "main", page_type="main")
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    with open(os.path.join(chunk_dir, "0.html"), "w") as f:
        f.write("<html><body><p>Unrelated new content</p></body></html>")

    fresh = HtmlMergerService(storage_root=storage)
    results = fresh.merge_session(session_id)

    result = results["main"]
    assert result.success
    assert "Unrelated new content" in result.html, (
        "a first chunk that is not contained in the skeleton must be merged"
    )

    print("  PASS: test_restart_skeleton_with_differing_first_chunk_still_merged")


def test_restart_reconstructed_from_first_chunk_emits_once():
    """The no-skeleton-file recovery path (skeleton rebuilt from 0.html)
    also emits the first screen exactly once."""
    storage = make_test_dir()
    session_id = "restart-session-3"

    # No skeleton file — only chunks on disk. _load_jobs_from_disk must
    # reconstruct the skeleton from 0.html and consume it.
    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    with open(os.path.join(chunk_dir, "0.html"), "w") as f:
        f.write(
            "<!DOCTYPE html><html><head><title>Rebuild</title></head>"
            "<body><p>Rebuilt first screen</p></body></html>"
        )
    with open(os.path.join(chunk_dir, "1.html"), "w") as f:
        f.write("<html><body><p>Rebuilt second screen</p></body></html>")

    fresh = HtmlMergerService(storage_root=storage)
    results = fresh.merge_session(session_id)

    result = results["main"]
    assert result.success
    assert result.html.count("Rebuilt first screen") == 1
    assert result.html.count("Rebuilt second screen") == 1

    print("  PASS: test_restart_reconstructed_from_first_chunk_emits_once")


# ---------------------------------------------------------------------------
# Doctype normalization (extension uploads documentElement.outerHTML — no doctype)
# ---------------------------------------------------------------------------

def test_doctype_prepended_when_missing():
    """Skeleton HTML without a doctype gets <!DOCTYPE html> prepended.

    The extension captures pages via documentElement.outerHTML, which starts
    at <html> — without the fix the merged output renders in quirks mode.
    """
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    job = service.get_or_create_job("test-session-doctype-missing", "main", page_type="main")

    skeleton_html = "<html>\n<head><title>No Doctype</title></head>\n<body><p>Hi</p></body>\n</html>"
    service.initialize_skeleton(job, skeleton_html)

    with open(job.skeleton_path, "r") as f:
        stored = f.read()
    assert stored.startswith("<!DOCTYPE html>"), (
        f"skeleton should start with the HTML5 doctype, got: {stored[:60]!r}"
    )
    assert stored.lower().count("<!doctype") == 1, (
        "doctype must not be duplicated"
    )
    assert "<html>" in stored, "original <html> tag must be preserved"

    print("  PASS: test_doctype_prepended_when_missing")


def test_doctype_not_duplicated_when_present():
    """Skeleton that already has a doctype is returned unchanged."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    job = service.get_or_create_job("test-session-doctype-present", "main", page_type="main")

    skeleton_html = """<!DOCTYPE html>
<html>
<head><title>With Doctype</title></head>
<body><p>Hi</p></body>
</html>"""
    service.initialize_skeleton(job, skeleton_html)

    with open(job.skeleton_path, "r") as f:
        stored = f.read()
    lower = stored.lower()
    assert lower.startswith("<!doctype"), "existing doctype must be kept first"
    assert lower.count("<!doctype") == 1, (
        f"doctype must not be duplicated, got {lower.count('<!doctype')}"
    )

    print("  PASS: test_doctype_not_duplicated_when_present")


def test_doctype_preserved_through_dom_merge():
    """_dom_merge re-serializes via lxml (which drops the doctype) — it must be re-attached."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-doctype-merge"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    # No doctype — mirrors the extension's outerHTML capture.
    skeleton_html = (
        "<html>\n<head><title>Doctype Merge</title></head>\n"
        "<body><div id=\"__next\"><p>Main content</p></div></body>\n</html>"
    )
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = (
        "<html>\n<head><title>Doctype Merge</title></head>\n"
        "<body><div id=\"__next\"><p>Main content</p><p>Extra screen</p></div></body>\n</html>"
    )
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    # Use the stored skeleton (with doctype) exactly as _merge_job would.
    with open(job.skeleton_path, "r") as f:
        stored_skeleton = f.read()
    result_html = service._dom_merge(job, stored_skeleton)
    lower = result_html.lower()
    assert lower.startswith("<!doctype"), (
        f"merged output should start with the doctype, got: {result_html[:60]!r}"
    )
    assert lower.count("<!doctype") == 1, "doctype must not be duplicated"
    assert "Extra screen" in result_html, "chunk content should be merged"

    print("  PASS: test_doctype_preserved_through_dom_merge")


# ---------------------------------------------------------------------------
# Raw-text serialization (browsers do NOT decode entities inside
# <script>/<style> — lxml's HTML serializer must not escape them there)
# ---------------------------------------------------------------------------

def _script_regions(html_str):
    """Return the text inside every <script> element of an HTML string."""
    return re.findall(
        r"<script[^>]*>(.*?)</script>", html_str, re.DOTALL | re.IGNORECASE
    )


def _style_regions(html_str):
    """Return the text inside every <style> element of an HTML string."""
    return re.findall(
        r"<style[^>]*>(.*?)</style>", html_str, re.DOTALL | re.IGNORECASE
    )


def test_dom_merge_preserves_raw_script_text():
    """Inline <script> containing &&, < and '<\\/script>' must survive the DOM
    merge RAW.

    Production evidence: etree.tostring(method='html') HTML-escapes &<> inside
    script text (&& -> &amp;&amp;); browsers treat script content as raw text
    and do not decode entities, so escaped output silently corrupts the JS.
    Ordinary body text with & must still be escaped (&amp;) as before.
    """
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-raw-script"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    skeleton_html = (
        "<!DOCTYPE html><html><head><title>Raw Script</title>"
        "<script>if (a && b < c) { init(); }</script></head>"
        "<body><p>Skeleton body</p></body></html>"
    )
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = (
        "<html><head><title>Raw Script</title></head>"
        "<body><p>Tom & Jerry</p>"
        "<script>var s = '<\\/script>'; if (x < 1 && y > 2) go();</script>"
        "</body></html>"
    )
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    with open(job.skeleton_path, "r") as f:
        stored_skeleton = f.read()
    result_html = service._dom_merge(job, stored_skeleton)

    scripts = "\n".join(_script_regions(result_html))
    assert "if (a && b < c)" in scripts, "skeleton script must keep && and < raw"
    assert "<\\/script>" in scripts, "escaped </script> inside JS string must stay raw"
    assert "if (x < 1 && y > 2) go();" in scripts, "chunk script must stay raw"
    assert "&amp;" not in scripts, "script text must not be HTML-escaped"
    assert "&lt;" not in scripts, "script text must not be HTML-escaped"

    # Body text is ordinary character data — escaping there is correct.
    assert "Tom &amp; Jerry" in result_html, "body text & must still be escaped"

    print("  PASS: test_dom_merge_preserves_raw_script_text")


def test_dom_merge_preserves_raw_style_text():
    """Inline <style> with 'a > b { ... }' must survive the DOM merge raw."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-raw-style"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    skeleton_html = (
        "<!DOCTYPE html><html><head><title>Raw Style</title>"
        "<style>div > p { content: \"x\" }</style></head>"
        "<body><p>Skeleton body</p></body></html>"
    )
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = (
        "<html><head><title>Raw Style</title></head>"
        "<body><p>Extra chunk content</p></body></html>"
    )
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    with open(job.skeleton_path, "r") as f:
        stored_skeleton = f.read()
    result_html = service._dom_merge(job, stored_skeleton)

    styles = "\n".join(_style_regions(result_html))
    assert "div > p" in styles, "CSS child combinator > must stay raw in <style>"
    assert "&gt;" not in styles, "style text must not be HTML-escaped"
    assert "Extra chunk content" in result_html, "chunk content should be merged"

    print("  PASS: test_dom_merge_preserves_raw_style_text")


def test_dom_merge_superset_path_preserves_raw_script_text():
    """The superset early-return in _dom_merge must also serialize raw text."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-raw-script-superset"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    body_content = (
        "<div id=\"__next\"><p>Main content</p></div>"
        "<script>var f = function () { return a && b < 3; };</script>"
    )
    skeleton_html = f"<!DOCTYPE html>\n<html>\n<head><title>Superset Raw</title></head>\n<body>{body_content}</body>\n</html>"
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = f"<html><head><title>Superset Raw</title></head><body>{body_content}</body></html>"
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    with open(job.skeleton_path, "r") as f:
        stored_skeleton = f.read()
    result_html = service._dom_merge(job, stored_skeleton)

    # Superset detected → content exactly once, with raw script text.
    assert result_html.count("Main content") == 1, "superset must not duplicate content"
    scripts = "\n".join(_script_regions(result_html))
    assert "return a && b < 3;" in scripts, "script must keep && and < raw"
    assert "&amp;" not in scripts, "script text must not be HTML-escaped"

    print("  PASS: test_dom_merge_superset_path_preserves_raw_script_text")


def test_doctype_emitted_once_with_raw_text_script():
    """Regression: raw-text stashing must not disturb doctype re-attachment."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-raw-doctype"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    # No doctype — mirrors the extension's outerHTML capture.
    skeleton_html = (
        "<html><head><title>Raw Doctype</title>"
        "<script>var x = a && b;</script></head>"
        "<body><p>Main content</p></body></html>"
    )
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = (
        "<html><head><title>Raw Doctype</title></head>"
        "<body><p>Main content</p><p>Extra screen</p></body></html>"
    )
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    with open(job.skeleton_path, "r") as f:
        stored_skeleton = f.read()
    result_html = service._dom_merge(job, stored_skeleton)

    lower = result_html.lower()
    assert lower.startswith("<!doctype"), (
        f"merged output should start with the doctype, got: {result_html[:60]!r}"
    )
    assert lower.count("<!doctype") == 1, "doctype must be emitted exactly once"
    assert "Extra screen" in result_html, "chunk content should be merged"
    scripts = "\n".join(_script_regions(result_html))
    assert "var x = a && b;" in scripts, "script must keep && raw"

    print("  PASS: test_doctype_emitted_once_with_raw_text_script")


def test_no_stash_token_leakage():
    """Placeholder tokens must never appear in merged output."""
    storage = make_test_dir()
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-session-no-token-leak"
    job = service.get_or_create_job(session_id, "main", page_type="main")

    skeleton_html = (
        "<!DOCTYPE html><html><head><title>Token Leak</title>"
        "<script>var head = true && false;</script>"
        "<style>body > main { color: red }</style></head>"
        "<body><p>Main content</p><script>var tail = 1 < 2;</script></body></html>"
    )
    service.initialize_skeleton(job, skeleton_html)

    chunk_dir = os.path.join(storage, session_id, "chunks", "main", "main")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_html = (
        "<html><head><title>Token Leak</title></head>"
        "<body><p>Main content</p>"
        "<script>if (a && b < c) { go('<\\/div>'); }</script>"
        "</body></html>"
    )
    chunk_path = os.path.join(chunk_dir, "1.html")
    with open(chunk_path, "w") as f:
        f.write(chunk_html)
    chunk_hash = service.compute_content_hash(chunk_html)
    service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    with open(job.skeleton_path, "r") as f:
        stored_skeleton = f.read()
    result_html = service._dom_merge(job, stored_skeleton)

    assert "PPSCR" not in result_html, "stash token prefix leaked into output"
    assert "XQZSTASH" not in result_html, "stash token suffix leaked into output"
    scripts = "\n".join(_script_regions(result_html))
    assert "a && b < c" in scripts, "scripts must still carry raw text"

    print("  PASS: test_no_stash_token_leakage")


def main():
    print("HTML Merge Service Verification (task 4.9)")
    print("=" * 50)

    tests = [
        test_skeleton_initialization,
        test_chunk_deduplication,
        test_full_merge,
        test_safe_merge_fallback,
        test_complexity_analysis,
        test_html_validation,
        test_linked_page_merge,
        test_disk_based_loading,
        test_chunk_cleanup_after_safe_merge,
        test_no_body_tag,
        test_safe_merge_deduplication,
        test_dom_merge_superset_identical_chunks,
        test_dom_merge_full_body_subset,
        test_analyze_job_complexity_early_exit_on_element_threshold,
        test_analyze_job_complexity_per_document_nesting,
        test_analyze_job_complexity_per_document_large_table,
        test_restart_no_first_scroll_duplication,
        test_restart_skeleton_with_differing_first_chunk_still_merged,
        test_restart_reconstructed_from_first_chunk_emits_once,
        test_doctype_prepended_when_missing,
        test_doctype_not_duplicated_when_present,
        test_doctype_preserved_through_dom_merge,
        test_dom_merge_preserves_raw_script_text,
        test_dom_merge_preserves_raw_style_text,
        test_dom_merge_superset_path_preserves_raw_script_text,
        test_doctype_emitted_once_with_raw_text_script,
        test_no_stash_token_leakage,
    ]

    passed = 0
    failed = 0

    for test in tests:
        try:
            test()
            passed += 1
        except AssertionError as e:
            print(f"  FAIL: {test.__name__}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR: {test.__name__}: {e}")
            failed += 1

    print()
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")

    if failed > 0:
        sys.exit(1)
    else:
        print("All tests passed!")


if __name__ == "__main__":
    main()
