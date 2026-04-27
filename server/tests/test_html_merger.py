#!/usr/bin/env python3
"""Verification script for HTML Merge Service (task 4.9).

Tests that the server-side merge produces equivalent output to the
client-side merge-html.ts + HtmlAssembler.ts for representative inputs.
"""

import hashlib
import os
import sys
import tempfile

# Add parent directory to path so we can import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.html_merger import (
    HtmlMergerService,
    ComplexityResult,
    MergeResult,
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
