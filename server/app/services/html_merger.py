"""HTML Merge Service: skeleton-and-chunks merge logic.

Ports the client-side merge-html.ts + HtmlAssembler.ts to Python,
using lxml for HTML parsing and manipulation.

Server-side merge flow:
1. First HTML chunk for a page initializes the skeleton (document structure
   with insertion point at </body>).
2. Subsequent chunks are deduplicated by (content_hash, scroll_index) and
   stored on disk.
3. On finalization, all chunks are merged into the skeleton before </body>.
4. Complex HTML (too many elements, deep nesting, large tables) triggers
   a safe fallback: body-content concatenation with size limits.
5. Merged output is validated for well-formedness.
6. Linked pages are merged independently, each in its own subdirectory.
"""

import hashlib
import html
import logging
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from lxml import etree

from app.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

INSERTION_POINT = "</body>"
DEFAULT_MAX_HTML_SIZE = 200 * 1024 * 1024  # 200 MB server-side limit
COMPLEXITY_ELEMENT_THRESHOLD = 100_000
COMPLEXITY_NESTING_THRESHOLD = 50
COMPLEXITY_TABLE_ROW_THRESHOLD = 5_000


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class ComplexityResult:
    """Result of HTML complexity analysis."""

    is_complex: bool
    element_count: int
    max_nesting: int
    large_table_count: int
    reason: Optional[str] = None


@dataclass
class MergeResult:
    """Result of a merge operation."""

    success: bool
    html: Optional[str] = None
    reason: Optional[str] = None
    stats: Optional[dict] = None
    page_url: Optional[str] = None  # Original URL of the page (for filename generation)


@dataclass
class AssemblyJob:
    """In-memory assembly job tracking skeleton + chunks for a page."""

    job_id: str
    session_id: str
    page_url_hash: str
    page_type: str  # "main" or "linked"
    page_url: Optional[str]
    skeleton_path: Optional[str] = None
    chunk_dir: Optional[str] = None
    chunks: list[str] = field(default_factory=list)  # ordered list of storage paths
    chunk_dedup_keys: set[str] = field(default_factory=set)  # "hash:scrollIndex"
    total_size: int = 0
    initialized: bool = False


# ---------------------------------------------------------------------------
# HTML Merger Service
# ---------------------------------------------------------------------------


class HtmlMergerService:
    """Server-side HTML merge service.

    Implements skeleton-and-chunks merge logic ported from the client-side
    merge-html.ts and HtmlAssembler.ts.  The service operates on files stored
    on disk by the HTML chunk upload route, so it does not hold large HTML
    strings in memory except during active merge operations.
    """

    def __init__(self, storage_root: Optional[str] = None) -> None:
        self.storage_root = storage_root or settings.storage_root
        # Active assembly jobs: keyed by f"{session_id}:{page_url_hash}"
        self._jobs: dict[str, AssemblyJob] = {}

    # ------------------------------------------------------------------
    # Job management
    # ------------------------------------------------------------------

    def _job_key(self, session_id: str, page_url_hash: str) -> str:
        return f"{session_id}:{page_url_hash}"

    def get_or_create_job(
        self,
        session_id: str,
        page_url_hash: str,
        page_type: str = "main",
        page_url: Optional[str] = None,
    ) -> AssemblyJob:
        """Return existing job or create a blank one."""
        key = self._job_key(session_id, page_url_hash)
        if key not in self._jobs:
            chunk_dir = os.path.join(
                self.storage_root,
                session_id,
                "chunks",
                page_type,
                page_url_hash,
            )
            self._jobs[key] = AssemblyJob(
                job_id=key,
                session_id=session_id,
                page_url_hash=page_url_hash,
                page_type=page_type,
                page_url=page_url,
                chunk_dir=chunk_dir,
            )
        return self._jobs[key]

    def get_job(self, session_id: str, page_url_hash: str) -> Optional[AssemblyJob]:
        key = self._job_key(session_id, page_url_hash)
        return self._jobs.get(key)

    def remove_job(self, session_id: str, page_url_hash: str) -> None:
        key = self._job_key(session_id, page_url_hash)
        self._jobs.pop(key, None)

    # ------------------------------------------------------------------
    # 4.2 – Skeleton initialization (first-chunk detection)
    # ------------------------------------------------------------------

    def initialize_skeleton(self, job: AssemblyJob, first_chunk_html: str) -> None:
        """Initialize the assembly job with the first HTML chunk as skeleton.

        The skeleton is the document structure with an insertion point at
        </body>.  The first chunk's body content *is* the initial content
        placed before the insertion point.
        """
        skeleton = self._ensure_insertion_point(first_chunk_html)
        skeleton_dir = os.path.join(
            self.storage_root, job.session_id, "skeletons"
        )
        os.makedirs(skeleton_dir, exist_ok=True)
        skeleton_path = os.path.join(skeleton_dir, f"{job.page_url_hash}.html")
        with open(skeleton_path, "w", encoding="utf-8") as f:
            f.write(skeleton)

        job.skeleton_path = skeleton_path
        job.initialized = True
        job.total_size = len(skeleton.encode("utf-8"))

        logger.info(
            "Skeleton initialized: session=%s page=%s size=%d",
            job.session_id,
            job.page_url_hash,
            job.total_size,
        )

    # ------------------------------------------------------------------
    # 4.3 – Chunk deduplication by content hash AND scrollIndex
    # ------------------------------------------------------------------

    @staticmethod
    def compute_content_hash(content: str) -> str:
        """SHA-256 hash of HTML content (matches HtmlChunk.content_hash)."""
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def is_duplicate_chunk(
        self, job: AssemblyJob, content_hash: str, scroll_index: int
    ) -> bool:
        """Check if a chunk with the same (content_hash, scroll_index) was already added.

        Same content at a different scroll position is NOT a duplicate;
        only an exact retransmission of the same (content, position) pair
        is skipped.  This matches the C2 fix from HtmlAssembler.ts.
        """
        dedup_key = f"{content_hash}:{scroll_index}"
        return dedup_key in job.chunk_dedup_keys

    def register_chunk(
        self, job: AssemblyJob, content_hash: str, scroll_index: int, storage_path: str, size: int
    ) -> None:
        """Register a chunk in the assembly job after it has been stored on disk."""
        dedup_key = f"{content_hash}:{scroll_index}"
        job.chunk_dedup_keys.add(dedup_key)
        job.chunks.append(storage_path)
        job.total_size += size

    # ------------------------------------------------------------------
    # 4.4 – Full merge on finalization
    # ------------------------------------------------------------------

    def merge_session(self, session_id: str) -> dict[str, MergeResult]:
        """Merge all pages for a session.

        Returns a dict mapping page_url_hash → MergeResult.  The main page
        (page_url_hash="main") result contains the index.html content.
        Linked page results contain content to be stored in pages/.
        """
        results: dict[str, MergeResult] = {}

        # Find all jobs for this session
        session_jobs = [
            job for job in self._jobs.values() if job.session_id == session_id
        ]

        if not session_jobs:
            # No in-memory jobs — load from disk
            session_jobs = self._load_jobs_from_disk(session_id)

        for job in session_jobs:
            result = self._merge_job(job)
            result.page_url = job.page_url
            results[job.page_url_hash] = result
            # Clean up job
            self.remove_job(session_id, job.page_url_hash)

        return results

    def _cleanup_chunk_files(self, job: AssemblyJob) -> None:
        """Delete chunk files and skeleton from disk after successful merge.

        Per spec: \"all chunk files are deleted from
        <storage_root>/<session_id>/chunks/ to reclaim disk space\".
        Also removes the skeleton file since it is no longer needed.
        """
        # Delete individual chunk files
        if job.chunk_dir and os.path.isdir(job.chunk_dir):
            try:
                shutil.rmtree(job.chunk_dir)
                logger.info(
                    "Chunk directory removed: session=%s page=%s dir=%s",
                    job.session_id,
                    job.page_url_hash,
                    job.chunk_dir,
                )
            except OSError as exc:
                logger.warning(
                    "Failed to remove chunk directory: session=%s page=%s exc=%s",
                    job.session_id,
                    job.page_url_hash,
                    exc,
                )

        # Delete skeleton file
        if job.skeleton_path and os.path.exists(job.skeleton_path):
            try:
                os.remove(job.skeleton_path)
                logger.debug(
                    "Skeleton file removed: session=%s page=%s",
                    job.session_id,
                    job.page_url_hash,
                )
            except OSError as exc:
                logger.warning(
                    "Failed to remove skeleton file: session=%s page=%s exc=%s",
                    job.session_id,
                    job.page_url_hash,
                    exc,
                )

        # Clean up empty parent directories
        if job.chunk_dir:
            self._remove_empty_parents(job.chunk_dir, max_levels=3)
        if job.skeleton_path:
            skeletons_dir = os.path.dirname(job.skeleton_path)
            self._remove_empty_parents(skeletons_dir, max_levels=1)

    @staticmethod
    def _remove_empty_parents(path: str, max_levels: int = 3) -> None:
        """Remove empty parent directories up to max_levels."""
        current = path
        for _ in range(max_levels):
            parent = os.path.dirname(current)
            if not parent or parent == os.sep:
                break
            try:
                if os.path.isdir(parent) and not os.listdir(parent):
                    os.rmdir(parent)
                    current = parent
                else:
                    break
            except OSError:
                break

    def _merge_job(self, job: AssemblyJob) -> MergeResult:
        """Merge chunks into skeleton for a single page."""
        if not job.initialized or not job.skeleton_path:
            return MergeResult(success=False, reason="Job not initialized (no skeleton)")

        # Read skeleton
        try:
            with open(job.skeleton_path, "r", encoding="utf-8") as f:
                skeleton_html = f.read()
        except OSError as exc:
            return MergeResult(success=False, reason=f"Cannot read skeleton: {exc}")

        if not job.chunks:
            # No chunks beyond the skeleton itself — still clean up skeleton
            self._cleanup_chunk_files(job)
            return MergeResult(
                success=True,
                html=skeleton_html,
                stats={"total_chunks": 0, "total_size": job.total_size},
            )

        # 4.6 – Check complexity of skeleton AND chunks before attempting DOM merge
        complexity = self._analyze_job_complexity(job, skeleton_html)
        if complexity.is_complex:
            logger.warning(
                "Complex HTML detected for session=%s page=%s: %s — using safe merge",
                job.session_id,
                job.page_url_hash,
                complexity.reason,
            )
            result = self._safe_merge(job, skeleton_html)
            if result.success:
                self._cleanup_chunk_files(job)
            return result

        # Attempt intelligent DOM merge
        try:
            result_html = self._dom_merge(job, skeleton_html)
        except Exception as exc:
            logger.warning(
                "DOM merge failed for session=%s page=%s: %s — falling back to safe merge",
                job.session_id,
                job.page_url_hash,
                exc,
            )
            result = self._safe_merge(job, skeleton_html)
            if result.success:
                self._cleanup_chunk_files(job)
            return result

        # 4.7 – Validate merged output
        if not self.validate_html(result_html):
            logger.warning(
                "Merged HTML failed validation for session=%s page=%s — using safe merge",
                job.session_id,
                job.page_url_hash,
            )
            result = self._safe_merge(job, skeleton_html)
            if result.success:
                self._cleanup_chunk_files(job)
            return result

        # Clean up chunk files after successful merge
        self._cleanup_chunk_files(job)

        return MergeResult(
            success=True,
            html=result_html,
            stats={
                "total_chunks": len(job.chunks),
                "total_size": job.total_size,
            },
        )

    def _dom_merge(self, job: AssemblyJob, skeleton_html: str) -> str:
        """Intelligent DOM-based merge: port of findParentSelector + append logic.

        Reads all chunk files from disk, parses them with lxml, and merges
        by finding the parent container and appending new children.
        """
        # Parse skeleton
        skeleton_tree = etree.HTML(skeleton_html)

        # Read and concatenate all chunk body contents
        chunk_bodies: list[str] = []
        for chunk_path in job.chunks:
            try:
                with open(chunk_path, "r", encoding="utf-8") as f:
                    chunk_html = f.read()
                # Extract body content from chunk
                body_content = self._extract_body_content(chunk_html)
                if body_content:
                    chunk_bodies.append(body_content)
            except OSError:
                logger.warning("Cannot read chunk file: %s — skipping", chunk_path)
                continue

        if not chunk_bodies:
            return skeleton_html

        # Full-body subset check: if all chunk body content is already contained
        # in the skeleton body, return the skeleton unchanged.
        skeleton_body_text = self._extract_body_content(skeleton_html) or ""
        if skeleton_body_text:
            all_subset = all(cb in skeleton_body_text for cb in chunk_bodies)
            if all_subset:
                logger.info(
                    "DOM merge: all chunk bodies are subsets of skeleton "
                    "(session=%s page=%s) — returning skeleton",
                    job.session_id, job.page_url_hash,
                )
                return skeleton_html

        # Combine all chunk body content into one HTML fragment for merge
        combined_chunk_html = f"<html><body>{''.join(chunk_bodies)}</body></html>"
        chunk_tree = etree.HTML(combined_chunk_html)

        # Find matching parent container (port of findParentSelector)
        skeleton_body = skeleton_tree.find(".//body")
        chunk_body = chunk_tree.find(".//body")

        if skeleton_body is None or chunk_body is None:
            # Fallback: insert all chunk content before </body>
            return self._insert_chunks_before_body_end(skeleton_html, chunk_bodies)

        # Compare first children — if identical, the chunk is a superset
        skel_children = list(skeleton_body)
        chunk_children = list(chunk_body)

        if skel_children and chunk_children:
            first_skel = etree.tostring(skel_children[0], encoding="unicode")
            first_chunk = etree.tostring(chunk_children[0], encoding="unicode")
            if self._compare_html_blocks(first_skel, first_chunk):
                # First child matches — verify remaining chunk children are
                # already in the skeleton before declaring superset.
                skel_html = "".join(
                    etree.tostring(c, encoding="unicode") for c in skel_children
                )
                all_in_skeleton = all(
                    etree.tostring(c, encoding="unicode") in skel_html
                    for c in chunk_children
                )
                if all_in_skeleton:
                    result = etree.tostring(skeleton_tree, encoding="unicode")
                    return result

        # Append chunk children to skeleton body with incremental element tracking
        skeleton_element_count = len(list(skeleton_body.iter()))
        for child in chunk_children:
            # Incremental element count check (O(1) per iteration instead of O(n))
            child_element_count = len(list(child.iter()))
            skeleton_element_count += child_element_count
            if skeleton_element_count > COMPLEXITY_ELEMENT_THRESHOLD:
                logger.warning(
                    "Element count exceeded threshold during DOM merge "
                    "(%d elements) — switching to insertion",
                    skeleton_element_count,
                )
                break
            skeleton_body.append(child)

        result = etree.tostring(skeleton_tree, encoding="unicode")
        return result

    def _insert_chunks_before_body_end(
        self, skeleton_html: str, chunk_bodies: list[str]
    ) -> str:
        """Insert chunk body content before </body> in the skeleton.

        This is the core insertion strategy from HtmlAssembler.ts:
        split the skeleton at </body>, insert chunks, reassemble.
        """
        insertion_point = INSERTION_POINT
        parts = skeleton_html.split(insertion_point, 1)
        if len(parts) == 1:
            # No </body> found — try </html>
            if "</html>" in skeleton_html:
                parts = skeleton_html.split("</html>", 1)
                insertion_point = "</html>"
            else:
                # Last resort: append
                return skeleton_html + "".join(chunk_bodies)

        content = parts[0] + "".join(chunk_bodies) + insertion_point
        if len(parts) > 1:
            content += parts[1]
        return content

    # ------------------------------------------------------------------
    # 4.5 – Safe merge fallback
    # ------------------------------------------------------------------

    def _safe_merge(self, job: AssemblyJob, skeleton_html: str) -> MergeResult:
        """Safe merge: extract body content and concatenate with size limits.

        Port of safeHtmlMerge from merge-html.ts. Deduplicates chunk body
        content that is identical to or a subset of the skeleton body to
        prevent duplicated output.
        """
        try:
            # Extract body content from skeleton
            body1 = self._extract_body_content(skeleton_html) or ""

            # Extract body content from all chunks, skipping duplicates
            chunk_bodies: list[str] = []
            skipped_count = 0
            for chunk_path in job.chunks:
                try:
                    with open(chunk_path, "r", encoding="utf-8") as f:
                        chunk_html = f.read()
                    body = self._extract_body_content(chunk_html)
                    if body:
                        if body == body1 or body in body1:
                            logger.debug(
                                "Safe merge: skipping duplicate/subset chunk %s "
                                "(session=%s page=%s)",
                                chunk_path, job.session_id, job.page_url_hash,
                            )
                            skipped_count += 1
                        else:
                            chunk_bodies.append(body)
                except OSError:
                    continue

            if skipped_count > 0:
                logger.info(
                    "Safe merge: skipped %d duplicate chunks (session=%s page=%s)",
                    skipped_count, job.session_id, job.page_url_hash,
                )

            combined_content = body1 + "\n" + "\n".join(chunk_bodies)

            # Check size limit
            max_size = DEFAULT_MAX_HTML_SIZE
            if len(combined_content) > max_size:
                truncated = (
                    combined_content[: max_size - 1000]
                    + "\n<!-- Content truncated due to size limits -->"
                )
                result_html = self._create_simple_html_wrapper(
                    truncated, skeleton_html
                )
            else:
                result_html = self._create_simple_html_wrapper(
                    combined_content, skeleton_html
                )

            return MergeResult(
                success=True,
                html=result_html,
                stats={
                    "total_chunks": len(job.chunks),
                    "total_size": job.total_size,
                    "safe_merge": True,
                },
            )
        except Exception as exc:
            # Last resort: return skeleton as-is (truncated if needed)
            if len(skeleton_html) > DEFAULT_MAX_HTML_SIZE:
                skeleton_html = (
                    skeleton_html[: DEFAULT_MAX_HTML_SIZE]
                    + "\n<!-- Content truncated -->"
                )
            return MergeResult(
                success=True,
                html=skeleton_html,
                reason=f"Safe merge fallback: {exc}",
            )

    # ------------------------------------------------------------------
    # 4.6 – HTML complexity analysis
    # ------------------------------------------------------------------

    def _analyze_job_complexity(
        self, job: AssemblyJob, skeleton_html: str
    ) -> ComplexityResult:
        """Analyze complexity of skeleton + all chunks using per-document analysis.

        Element counts are summed across documents with early-exit if the
        combined total exceeds COMPLEXITY_ELEMENT_THRESHOLD.  Nesting depth
        and table checks run on each document independently; the maximum is
        taken across all documents.

        This eliminates the combined_html string concatenation that previously
        forced a single giant BeautifulSoup parse of all chunk HTML at once.
        Per-document nesting analysis is also semantically more correct: lxml
        re-roots concatenated HTML, artificially flattening inter-document
        nesting depth.
        """
        combined_elements = 0

        # Count skeleton elements with early-exit
        try:
            skel_tree = etree.HTML(skeleton_html)
            if skel_tree is not None:
                combined_elements += len(list(skel_tree.iter()))
        except Exception:
            pass

        if combined_elements > COMPLEXITY_ELEMENT_THRESHOLD:
            return ComplexityResult(
                is_complex=True,
                element_count=combined_elements,
                max_nesting=0,
                large_table_count=0,
                reason=f"Too many elements (skeleton+chunks): {combined_elements}",
            )

        # Count chunk elements with early-exit, storing HTML for per-document
        # nesting/table analysis below (avoids a second disk read pass).
        chunk_htmls: list[str] = []
        for chunk_path in job.chunks:
            try:
                with open(chunk_path, "r", encoding="utf-8") as f:
                    chunk_html = f.read()
            except OSError:
                continue
            try:
                chunk_tree = etree.HTML(chunk_html)
                if chunk_tree is not None:
                    combined_elements += len(list(chunk_tree.iter()))
            except Exception:
                pass
            if combined_elements > COMPLEXITY_ELEMENT_THRESHOLD:
                return ComplexityResult(
                    is_complex=True,
                    element_count=combined_elements,
                    max_nesting=0,
                    large_table_count=0,
                    reason=f"Too many elements (skeleton+chunks): {combined_elements}",
                )
            chunk_htmls.append(chunk_html)

        # Per-document nesting / table analysis: skeleton first, then each chunk.
        # Track maximums across all documents.
        max_nesting = 0
        max_large_table_count = 0
        is_complex = False
        reason = None

        for doc_html in [skeleton_html] + chunk_htmls:
            doc_result = self.analyze_html_complexity(doc_html)
            max_nesting = max(max_nesting, doc_result.max_nesting)
            max_large_table_count = max(max_large_table_count, doc_result.large_table_count)
            if doc_result.is_complex and not is_complex:
                is_complex = True
                reason = doc_result.reason

        return ComplexityResult(
            is_complex=is_complex,
            element_count=combined_elements,
            max_nesting=max_nesting,
            large_table_count=max_large_table_count,
            reason=reason,
        )

    def analyze_html_complexity(self, html_content: str) -> ComplexityResult:
        """Analyze HTML complexity to detect potential exponential growth.

        Port of analyzeHtmlComplexity from merge-html.ts.
        Thresholds:
        - Element count > 100K
        - Nesting depth > 50 levels
        - Tables with > 5K rows
        - Nested tables (table > table) count > 10
        """
        try:
            tree = etree.HTML(html_content)
        except Exception:
            return ComplexityResult(
                is_complex=True,
                element_count=0,
                max_nesting=0,
                large_table_count=0,
                reason="Failed to parse HTML",
            )

        # Count total elements and calculate max nesting depth in a single O(N)
        # top-down pass.  Parents are always visited before their children by
        # tree.iter(), so depth_map[parent] is always populated when we process
        # a child.  This replaces the former O(N × D) approach that called
        # elem.iterancestors() (O(D)) for every one of N elements.
        #
        # NOTE: we key by the lxml element object directly (not id()) to avoid
        # id re-use bugs — lxml proxy objects can share memory addresses after
        # earlier proxies are garbage-collected.
        depth_map: dict = {}  # lxml element → nesting depth
        element_count = 0
        max_nesting = 0
        for elem in tree.iter():
            element_count += 1
            parent = elem.getparent()
            d = (depth_map.get(parent, -1) + 1) if parent is not None else 0
            depth_map[elem] = d
            if d > max_nesting:
                max_nesting = d

        # Count large tables (> 5K rows)
        large_table_count = 0
        for table in tree.iter("table"):
            row_count = len(list(table.iter("tr")))
            if row_count > COMPLEXITY_TABLE_ROW_THRESHOLD:
                large_table_count += 1

        # Check nested tables (table > table)
        nested_table_count = 0
        for table in tree.iter("table"):
            nested = list(table.iter("table"))
            # Subtract 1 for the table itself
            if len(nested) - 1 > 0:
                nested_table_count += len(nested) - 1

        # Determine complexity
        is_complex = False
        reason = None

        if element_count > COMPLEXITY_ELEMENT_THRESHOLD:
            is_complex = True
            reason = f"Too many elements: {element_count}"
        elif max_nesting > COMPLEXITY_NESTING_THRESHOLD:
            is_complex = True
            reason = f"Deeply nested elements: {max_nesting} levels"
        elif large_table_count > 0:
            is_complex = True
            reason = f"Large tables detected: {large_table_count}"
        elif nested_table_count > 10:
            is_complex = True
            reason = f"Excessive nested tables: {nested_table_count}"

        # Check for duplicate body content
        body1 = self._extract_body_content(html_content)
        if body1 and html_content.count(body1) > 1:
            is_complex = True
            reason = "Duplicate content detected"

        return ComplexityResult(
            is_complex=is_complex,
            element_count=element_count,
            max_nesting=max_nesting,
            large_table_count=large_table_count,
            reason=reason,
        )

    # ------------------------------------------------------------------
    # 4.7 – Merged HTML validation
    # ------------------------------------------------------------------

    def validate_html(self, html_content: str) -> bool:
        """Validate merged HTML for well-formedness.

        Checks:
        - Has basic HTML structure (html, head, body tags)
        - Can be parsed by lxml without fatal errors
        - Has a <body> tag
        """
        if not html_content or not isinstance(html_content, str):
            return False

        # Basic structure check
        lower = html_content.strip().lower()
        if not (
            "<html" in lower
            or "<!doctype" in lower
            or "<head" in lower
            or "<body" in lower
        ):
            return False

        # Parse with lxml to check well-formedness
        try:
            tree = etree.HTML(html_content)
            if tree is None:
                return False
            # Must have a body element
            body = tree.find(".//body")
            return body is not None
        except Exception:
            return False

    # ------------------------------------------------------------------
    # 4.8 – Linked page merge (separate per pageUrl)
    # ------------------------------------------------------------------

    def merge_linked_pages(self, session_id: str) -> dict[str, MergeResult]:
        """Merge all linked pages for a session.

        Returns a dict mapping page_url_hash → MergeResult for linked pages only.
        Each linked page's chunks are merged independently and stored in
        the pages/ directory.
        """
        results: dict[str, MergeResult] = {}

        # Find linked page jobs
        linked_jobs = [
            job
            for job in self._jobs.values()
            if job.session_id == session_id and job.page_type == "linked"
        ]

        if not linked_jobs:
            # Try loading from disk
            linked_jobs = self._load_jobs_from_disk(session_id, page_type="linked")

        for job in linked_jobs:
            result = self._merge_job(job)
            results[job.page_url_hash] = result

            # Write merged HTML to pages/ directory
            if result.success and result.html:
                pages_dir = os.path.join(
                    self.storage_root, session_id, "pages"
                )
                os.makedirs(pages_dir, exist_ok=True)
                page_path = os.path.join(pages_dir, f"{job.page_url_hash}.html")
                with open(page_path, "w", encoding="utf-8") as f:
                    f.write(result.html)
                logger.info(
                    "Linked page merged: session=%s page=%s path=%s size=%d",
                    session_id,
                    job.page_url_hash,
                    page_path,
                    len(result.html),
                )

            self.remove_job(session_id, job.page_url_hash)

        return results

    # ------------------------------------------------------------------
    # Disk-based job loading (for sessions that were uploaded but not
    # yet assembled — e.g. after server restart)
    # ------------------------------------------------------------------

    def _load_jobs_from_disk(
        self, session_id: str, page_type: Optional[str] = None
    ) -> list[AssemblyJob]:
        """Load assembly jobs from the chunk files on disk.

        This is used when in-memory jobs have been lost (e.g. server restart)
        and we need to assemble from the stored chunk files.
        """
        jobs: list[AssemblyJob] = []
        chunks_base = os.path.join(self.storage_root, session_id, "chunks")
        if not os.path.isdir(chunks_base):
            return jobs

        for pt in ("main", "linked"):
            if page_type and pt != page_type:
                continue
            pt_dir = os.path.join(chunks_base, pt)
            if not os.path.isdir(pt_dir):
                continue

            for page_hash in os.listdir(pt_dir):
                page_dir = os.path.join(pt_dir, page_hash)
                if not os.path.isdir(page_dir):
                    continue

                job = self.get_or_create_job(
                    session_id=session_id,
                    page_url_hash=page_hash,
                    page_type=pt,
                )

                # Find skeleton
                skeleton_path = os.path.join(
                    self.storage_root, session_id, "skeletons", f"{page_hash}.html"
                )
                skeleton_from_first_chunk = False
                if os.path.exists(skeleton_path):
                    job.skeleton_path = skeleton_path
                    job.initialized = True
                    with open(skeleton_path, "r", encoding="utf-8") as f:
                        job.total_size = len(f.read().encode("utf-8"))
                else:
                    # No explicit skeleton file — fall back to using the first
                    # chunk (scrollIndex 0) as the skeleton.  This handles
                    # server restarts where in-memory jobs are lost and the
                    # skeleton was never written because the upload route
                    # previously didn't call initialize_skeleton().
                    first_chunk_path = os.path.join(
                        self.storage_root, session_id,
                        "chunks", pt, page_hash, "0.html",
                    )
                    if os.path.exists(first_chunk_path):
                        # Write the skeleton file from the first chunk
                        with open(first_chunk_path, "r", encoding="utf-8") as f:
                            first_chunk_html = f.read()
                        self.initialize_skeleton(job, first_chunk_html)
                        skeleton_from_first_chunk = True
                        logger.info(
                            "Reconstructed skeleton from first chunk: session=%s page=%s",
                            session_id, page_hash,
                        )
                    # else: no first chunk either — job won't be initialized

                # Find chunk files (sorted by scroll index from filename)
                chunk_files: list[tuple[int, str]] = []
                for fname in os.listdir(page_dir):
                    fpath = os.path.join(page_dir, fname)
                    if os.path.isfile(fpath) and fname.endswith(".html"):
                        try:
                            scroll_idx = int(fname.replace(".html", ""))
                            chunk_files.append((scroll_idx, fpath))
                        except ValueError:
                            # Non-numeric filename — include at end
                            chunk_files.append((999999, fpath))

                chunk_files.sort(key=lambda x: x[0])

                # Determine whether scrollIndex 0 was used as the skeleton.
                # If so, skip it from the chunks list to avoid double-inserting
                # its content (the skeleton already contains it).
                skip_scroll_zero = skeleton_from_first_chunk

                for scroll_idx, fpath in chunk_files:
                    # Skip the first chunk if it was used as the skeleton
                    if skip_scroll_zero and scroll_idx == 0:
                        continue
                    size = os.path.getsize(fpath)
                    # Compute hash for dedup tracking
                    with open(fpath, "r", encoding="utf-8") as f:
                        content = f.read()
                    content_hash = self.compute_content_hash(content)

                    dedup_key = f"{content_hash}:{scroll_idx}"
                    if dedup_key not in job.chunk_dedup_keys:
                        job.chunk_dedup_keys.add(dedup_key)
                        job.chunks.append(fpath)
                        job.total_size += size

                if job.initialized:
                    jobs.append(job)
                else:
                    # No skeleton — can't merge
                    self.remove_job(session_id, page_hash)

        return jobs

    # ------------------------------------------------------------------
    # Helper methods
    # ------------------------------------------------------------------

    def _ensure_insertion_point(self, skeleton: str) -> str:
        """Ensure the skeleton HTML has the </body> insertion point.

        Port of ensureInsertionPoint from HtmlAssembler.ts.
        """
        if INSERTION_POINT in skeleton.lower():
            return skeleton

        lower = skeleton.lower()
        if "</body>" in lower:
            return skeleton

        if "</html>" in lower:
            return skeleton.replace("</html>", f"{INSERTION_POINT}\n</html>")

        # Fallback: append insertion point at the end
        return skeleton + INSERTION_POINT

    @staticmethod
    def _extract_body_content(html_content: str) -> Optional[str]:
        """Extract the innerHTML of <body> from an HTML string.

        Uses a fast string-split approach: O(N) time, O(1) extra memory
        (the returned slice references the input string — no parse tree is
        allocated).  Falls back to regex, and finally to lxml for bare HTML
        fragments that have no <body> tag (lxml wraps any fragment in
        html/body when it parses, so the body element is always present).
        """
        # Fast path: string-split
        lower = html_content.lower()
        start_tag = lower.find("<body")
        if start_tag != -1:
            tag_close = html_content.find(">", start_tag)
            end_tag = lower.rfind("</body>")
            if tag_close != -1 and end_tag > tag_close:
                return html_content[tag_close + 1 : end_tag]

        # Fallback: regex extraction
        match = re.search(
            r"<body[^>]*>(.*)</body>", html_content, re.DOTALL | re.IGNORECASE
        )
        if match:
            return match.group(1)

        # Final fallback: lxml for bare HTML fragments with no <body> tag.
        # lxml wraps bare fragments in a full html/body structure, so the body
        # element is always present after parsing.  This fallback is only
        # reached for fragment inputs (which are small by nature), so the
        # parse overhead is acceptable.
        try:
            tree = etree.HTML(html_content)
            if tree is not None:
                body = tree.find(".//body")
                if body is not None:
                    body_inner = (body.text or "") + "".join(
                        etree.tostring(c, encoding="unicode") for c in body
                    )
                    if body_inner:
                        return body_inner
        except Exception:
            pass

        return None

    @staticmethod
    def _create_simple_html_wrapper(content: str, template_html: str) -> str:
        """Create a simple HTML wrapper for merged content.

        Port of createSimpleHtmlWrapper from merge-html.ts.
        Uses lxml instead of BeautifulSoup to reduce memory overhead
        (~5–10× vs ~50–100× the template string size).
        """
        try:
            tree = etree.HTML(template_html)
            title_el = tree.find(".//title") if tree is not None else None
            title = (
                "".join(title_el.itertext()) if title_el is not None else None
            ) or "Merged Content"
            head_el = tree.find(".//head") if tree is not None else None
            if head_el is not None:
                head_content = (head_el.text or "") + "".join(
                    etree.tostring(c, encoding="unicode") for c in head_el
                )
            else:
                head_content = ""
        except Exception:
            title = "Merged Content"
            head_content = ""

        escaped_title = html.escape(title)
        return (
            f"<!DOCTYPE html>\n"
            f"<html>\n"
            f"<head>\n"
            f"  <meta charset=\"UTF-8\">\n"
            f"  <title>{escaped_title}</title>\n"
            f"  {head_content}\n"
            f"</head>\n"
            f"<body>\n"
            f"  {content}\n"
            f"</body>\n"
            f"</html>"
        )

    @staticmethod
    def _compare_html_blocks(html1: str, html2: str) -> bool:
        """Compare two HTML blocks after normalizing whitespace.

        Port of compareHTMLBlocks from merge-html.ts.
        """
        norm1 = re.sub(r"\s", "", html1).lower()
        norm2 = re.sub(r"\s", "", html2).lower()
        return norm1 == norm2


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

html_merger_service = HtmlMergerService()
