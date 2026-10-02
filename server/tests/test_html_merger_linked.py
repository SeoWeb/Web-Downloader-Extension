#!/usr/bin/env python3
"""Verification script for task 4.10: Linked page merge produces correct output
stored in pages/ directory.

This test creates multiple linked pages, each with their own chunks,
and verifies:
1. Each linked page is merged independently
2. Output files are stored in pages/ directory with correct naming
3. Content from each page is distinct and not mixed
4. The pages/ directory structure is correct
"""

import hashlib
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.html_merger import HtmlMergerService


def test_multiple_linked_pages():
    """Multiple linked pages should each be merged and stored in pages/."""
    storage = tempfile.mkdtemp(prefix="html_merger_linked_")
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-linked-pages"

    # Also create a main page
    main_job = service.get_or_create_job(session_id, "main", page_type="main")
    main_skeleton = "<html><head><title>Main Page</title></head><body><p>Main</p></body></html>"
    service.initialize_skeleton(main_job, main_skeleton)

    # Create 3 linked pages with different content
    linked_pages = [
        ("https://example.com/about", "About Page", "About us content"),
        ("https://example.com/contact", "Contact Page", "Contact us content"),
        ("https://example.com/products/item1", "Product Page", "Product details content"),
    ]

    for url, title, content in linked_pages:
        page_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
        job = service.get_or_create_job(session_id, page_hash, page_type="linked", page_url=url)

        skeleton = f"<html><head><title>{title}</title></head><body><p>{content}</p></body></html>"
        service.initialize_skeleton(job, skeleton)

        # Add a chunk with additional content
        chunk_dir = os.path.join(storage, session_id, "chunks", "linked", page_hash)
        os.makedirs(chunk_dir, exist_ok=True)
        chunk_html = f"<p>Extra: {content} continued</p>"
        chunk_path = os.path.join(chunk_dir, "1.html")
        with open(chunk_path, "w") as f:
            f.write(chunk_html)
        chunk_hash = service.compute_content_hash(chunk_html)
        service.register_chunk(job, chunk_hash, scroll_index=1, storage_path=chunk_path, size=len(chunk_html))

    # Merge linked pages
    results = service.merge_linked_pages(session_id)

    # Verify we have results for all 3 linked pages
    assert len(results) == 3, f"Expected 3 linked page results, got {len(results)}"

    pages_dir = os.path.join(storage, session_id, "pages")
    assert os.path.isdir(pages_dir), "pages/ directory should exist"

    # Verify each page file
    page_files = os.listdir(pages_dir)
    assert len(page_files) == 3, f"Expected 3 page files, got {len(page_files)}"

    for url, title, content in linked_pages:
        page_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
        page_path = os.path.join(pages_dir, f"{page_hash}.html")

        assert os.path.exists(page_path), f"Page file should exist: {page_path}"

        with open(page_path, "r") as f:
            stored = f.read()

        assert content in stored, f"Page content '{content}' should be in stored file for {url}"
        assert f"Extra: {content} continued" in stored, f"Chunk content should be in stored file for {url}"
        assert "<body" in stored.lower(), f"Stored page should have body tag for {url}"

    # Main page should still exist in jobs (not merged by merge_linked_pages)
    main_job_check = service.get_job(session_id, "main")
    assert main_job_check is not None, "Main page job should still exist after linked page merge"

    print("  PASS: test_multiple_linked_pages")
    return True


def test_linked_page_with_multiple_chunks():
    """Linked page with multiple scroll chunks should merge all correctly."""
    storage = tempfile.mkdtemp(prefix="html_merger_linked_multi_")
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-linked-multi-chunk"

    url = "https://example.com/long-page"
    page_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    job = service.get_or_create_job(session_id, page_hash, page_type="linked", page_url=url)

    skeleton = "<html><head><title>Long Page</title></head><body><p>Start</p></body></html>"
    service.initialize_skeleton(job, skeleton)

    chunk_dir = os.path.join(storage, session_id, "chunks", "linked", page_hash)
    os.makedirs(chunk_dir, exist_ok=True)

    # Add 5 chunks at different scroll positions
    for i in range(1, 6):
        chunk_html = f"<p>Scroll position {i} content</p>"
        chunk_path = os.path.join(chunk_dir, f"{i}.html")
        with open(chunk_path, "w") as f:
            f.write(chunk_html)
        chunk_hash = service.compute_content_hash(chunk_html)
        service.register_chunk(job, chunk_hash, scroll_index=i, storage_path=chunk_path, size=len(chunk_html))

    results = service.merge_linked_pages(session_id)
    assert page_hash in results, "Should have result for linked page"
    result = results[page_hash]
    assert result.success, f"Merge should succeed: {result.reason}"

    page_path = os.path.join(storage, session_id, "pages", f"{page_hash}.html")
    assert os.path.exists(page_path), "Page file should exist"

    with open(page_path, "r") as f:
        stored = f.read()

    # All scroll positions should be in the output
    for i in range(1, 6):
        assert f"Scroll position {i} content" in stored, f"Scroll position {i} should be in merged output"

    assert "Start" in stored, "Skeleton content should be preserved"

    print("  PASS: test_linked_page_with_multiple_chunks")
    return True


def test_linked_page_directory_structure():
    """Verify the complete directory structure after linked page merge."""
    storage = tempfile.mkdtemp(prefix="html_merger_structure_")
    service = HtmlMergerService(storage_root=storage)
    session_id = "test-structure"

    url = "https://example.com/test"
    page_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    job = service.get_or_create_job(session_id, page_hash, page_type="linked", page_url=url)

    skeleton = "<html><head><title>Structure Test</title></head><body><p>Test</p></body></html>"
    service.initialize_skeleton(job, skeleton)

    # Merge
    results = service.merge_linked_pages(session_id)

    # Verify directory structure
    session_dir = os.path.join(storage, session_id)
    assert os.path.isdir(session_dir), "Session directory should exist"

    # Skeletons dir should exist
    skeletons_dir = os.path.join(session_dir, "skeletons")
    assert os.path.isdir(skeletons_dir), "Skeletons directory should exist"

    # Pages dir should exist with output file
    pages_dir = os.path.join(session_dir, "pages")
    assert os.path.isdir(pages_dir), "Pages directory should exist"
    assert os.path.exists(os.path.join(pages_dir, f"{page_hash}.html")), "Page HTML file should exist"

    # Chunks dir may or may not exist depending on whether chunks were uploaded
    # (In production, the HTML upload route creates chunk files; here we only
    # initialized the skeleton, so no chunks dir is expected)
    chunks_dir = os.path.join(session_dir, "chunks", "linked", page_hash)
    # Not asserting chunks_dir exists since no chunks were added in this test

    print("  PASS: test_linked_page_directory_structure")
    return True


def main():
    print("Linked Page Merge Verification (task 4.10)")
    print("=" * 50)

    tests = [
        test_multiple_linked_pages,
        test_linked_page_with_multiple_chunks,
        test_linked_page_directory_structure,
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
