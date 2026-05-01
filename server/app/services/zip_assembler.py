"""ZIP Assembly Service: create ZIP archives or single-file HTML from session data.

Orchestrates the full assembly pipeline:
1. Merge HTML chunks (via HtmlMergerService)
2. Convert URLs in merged HTML (via HtmlConverterService)
3. Convert CSS file url() references (via HtmlConverterService)
4. Assemble ZIP with correct directory structure, or produce single-file HTML

Tasks covered:
  6.1 – ZIP creation using DEFLATE compression level 6
  6.2 – Merged HTML as index.html, resources at designated paths, linked pages in pages/
  6.3 – content.txt inclusion (skip if not uploaded)
  6.4 – Safe ZIP filename generation, path traversal sanitization
  6.5 – Single-file HTML mode with streaming base64 inlining
  6.6 – Assembly error handling (missing resources skipped, unrecoverable → failed)
  6.7 – Assembly progress updates (assembly_phase, assembly_progress_pct in DB)
"""

import asyncio
import logging
import os
import re
import time
import zipfile
from pathlib import PurePosixPath
from typing import Optional
from urllib.parse import urlparse

from app.config import settings
from app.services.html_merger import html_merger_service, MergeResult
from app.services.html_converter import html_converter_service, generate_page_filename

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ZIP_COMPRESSION_LEVEL = 6          # DEFLATE level per spec
MAX_FILENAME_LENGTH = 200          # Max chars for ZIP filename
CONTENT_TXT_MAX_SIZE = 1 * 1024 * 1024  # 1 MB cap for single-file content embedding


# ---------------------------------------------------------------------------
# ZipAssemblerService
# ---------------------------------------------------------------------------


class ZipAssemblerService:
    """Assemble ZIP archives or single-file HTML from session data."""

    def __init__(self, storage_root: Optional[str] = None) -> None:
        self.storage_root = storage_root or settings.storage_root

    # ------------------------------------------------------------------
    # Main entry point (called as background task)
    # ------------------------------------------------------------------

    async def assemble_session(
        self,
        session_id: str,
        db_session_factory,
    ) -> None:
        """Run the full assembly pipeline for a session.

        This method is designed to be run as an asyncio.Task (registered
        with AssemblyTaskManager).  It updates assembly_phase and
        assembly_progress_pct in the database after each major step.

        Args:
            session_id: The session to assemble.
            db_session_factory: Callable that returns a new AsyncSession.
        """
        from app.services.assembly_manager import assembly_task_manager

        try:
            async with db_session_factory() as db:
                session = await self._get_session(db, session_id)
                if session is None:
                    logger.error("Assembly: session %s not found", session_id)
                    return

                tab_url = session.url
                filename_map = session.filename_map or {}
                is_single_file = bool(session.options and session.options.get("singleFile"))

                # ---- Phase 1: Merging HTML ----
                await self._update_progress(db, session, "merging_html", 0)
                # Run synchronous merge in a thread to avoid blocking the
                # asyncio event loop.  With large pages (100K+ elements),
                # merge_session() can take tens of seconds, during which the
                # server would be unable to respond to GET /status polls.
                merge_results = await asyncio.to_thread(
                    html_merger_service.merge_session, session_id,
                )
                await self._update_progress(db, session, "merging_html", 100)

                # Get main page merged HTML
                main_result = merge_results.get("main")
                if not main_result or not main_result.success:
                    await self._mark_failed(
                        db, session,
                        main_result.reason if main_result else "No main page HTML found",
                    )
                    return

                main_html = main_result.html
                if not main_html:
                    await self._mark_failed(db, session, "Main page HTML is empty")
                    return

                # ---- Phase 2: Converting URLs ----
                await self._update_progress(db, session, "converting_urls", 0)

                # Build content-type map from uploaded resources for
                # extension-aware fallback when filename map misses.
                all_resources = await self._get_all_resources(db, session_id)
                content_type_map: dict[str, str] = {
                    r.original_url: r.content_type
                    for r in all_resources
                    if r.content_type
                }

                # Build page_filename_map BEFORE converting main HTML so that
                # convert_html() can rewrite intra-site links to linked pages.
                linked_results: dict[str, MergeResult] = {
                    page_hash: result
                    for page_hash, result in merge_results.items()
                    if page_hash != "main" and result.success and result.html
                }

                page_filename_map: dict[str, str] = {}
                used_filenames: set[str] = set()
                page_hash_to_filename: dict[str, str] = {}  # page_hash → final filename
                for page_hash, lp_result in linked_results.items():
                    if not lp_result.page_url:
                        page_hash_to_filename[page_hash] = f"{page_hash}.html"
                        continue
                    base_filename = generate_page_filename(lp_result.page_url)
                    filename = base_filename
                    if filename in used_filenames:
                        name_base = base_filename.rsplit(".", 1)[0]
                        hash_suffix = page_hash[:4]
                        filename = f"{name_base}-{hash_suffix}.html"
                    used_filenames.add(filename)
                    page_filename_map[lp_result.page_url] = filename
                    page_hash_to_filename[page_hash] = filename

                main_html = await asyncio.to_thread(
                    html_converter_service.convert_html,
                    main_html, tab_url,
                    filename_map,      # filename_map (positional)
                    False,             # is_linked_page
                    None,              # path
                    page_filename_map, # page_filename_map (positional)
                    content_type_map,  # content_type_map (positional)
                )
                await self._update_progress(db, session, "converting_urls", 100)

                # ---- Phase 2b: Convert linked pages ----
                # merge_session() already merged ALL pages (main + linked) and
                # cleaned up chunk files / removed in-memory jobs.  The linked
                # page results are already inside merge_results — extract them
                # here instead of trying to re-merge (which would fail because
                # chunks are already deleted).
                linked_page_htmls: dict[str, str] = {}
                linked_page_urls: dict[str, str] = {}  # page_hash → page_url mapping
                if linked_results:
                    total_linked = len(linked_results)
                    lp_sem = asyncio.Semaphore(10)
                    lp_completed = 0

                    async def _convert_linked_page_one(page_hash: str, lp_result):
                        nonlocal lp_completed
                        if lp_result.success and lp_result.html:
                            async with lp_sem:
                                converted = await asyncio.to_thread(
                                    html_converter_service.convert_linked_page_html,
                                    lp_result.html, tab_url, filename_map, page_filename_map,
                                    content_type_map,
                                )
                                linked_page_htmls[page_hash] = converted
                                if lp_result.page_url:
                                    linked_page_urls[page_hash] = lp_result.page_url
                        lp_completed += 1
                        pct = int(lp_completed / max(total_linked, 1) * 100)
                        should_flush = lp_completed % 10 == 0 or lp_completed == total_linked
                        await self._update_progress(
                            db, session, "converting_urls", pct,
                            flush=should_flush,
                        )

                    await asyncio.gather(*[
                        _convert_linked_page_one(ph, lr)
                        for ph, lr in linked_results.items()
                    ])

                # ---- Phase 3: Converting CSS files (parallel) ----
                await self._update_progress(db, session, "converting_css", 0)
                css_resources = await self._get_resources_by_prefix(db, session_id, "styles/")
                total_css = len(css_resources)
                if css_resources:
                    css_sem = asyncio.Semaphore(10)
                    css_completed = 0

                    async def _convert_css_one(resource):
                        nonlocal css_completed
                        async with css_sem:
                            await self._convert_css_resource(
                                resource, tab_url, filename_map, session_id,
                                content_type_map,
                            )
                            css_completed += 1
                            pct = int(css_completed / max(total_css, 1) * 100)
                            should_flush = css_completed % 10 == 0 or css_completed == total_css
                            await self._update_progress(
                                db, session, "converting_css", pct,
                                flush=should_flush,
                            )

                    await asyncio.gather(*[_convert_css_one(r) for r in css_resources])
                await self._update_progress(db, session, "converting_css", 100)

                # ---- Phase 4: Assembling output ----
                await self._update_progress(db, session, "assembling_zip", 0)

                # Read content.txt if present
                content_text = self._read_content_txt(session_id)

                if is_single_file:
                    output_path = await self._assemble_single_file(
                        session_id, db, session,
                        main_html, tab_url, filename_map, content_text,
                    )
                else:
                    output_path = await self._assemble_zip(
                        session_id, db, session,
                        main_html, linked_page_htmls, linked_page_urls,
                        page_hash_to_filename, filename_map, content_text,
                        all_resources,
                    )

                if output_path is None:
                    return  # already marked failed

                # Mark session as ready
                session.status = "ready"
                session.zip_path = output_path
                session.assembly_phase = None
                session.assembly_progress_pct = None
                await db.flush()

                logger.info(
                    "Assembly complete: session=%s output=%s",
                    session_id, output_path,
                )

        except asyncio.CancelledError:
            logger.info("Assembly cancelled for session %s", session_id)
            # Clean up partial output
            await self._cleanup_on_cancel(session_id, db_session_factory)
            raise
        except Exception as exc:
            logger.exception("Assembly failed for session %s: %s", session_id, exc)
            try:
                async with db_session_factory() as db:
                    session = await self._get_session(db, session_id)
                    if session:
                        await self._mark_failed(db, session, str(exc))
            except Exception:
                logger.exception(
                    "Failed to mark session %s as failed after assembly error",
                    session_id,
                )
        finally:
            assembly_task_manager.unregister(session_id)

    # ------------------------------------------------------------------
    # ZIP assembly (6.1, 6.2, 6.3)
    # ------------------------------------------------------------------

    async def _assemble_zip(
        self,
        session_id: str,
        db,
        session,
        main_html: str,
        linked_page_htmls: dict[str, str],
        linked_page_urls: dict[str, str],
        page_hash_to_filename: dict[str, str],
        filename_map: dict[str, str],
        content_text: Optional[str],
        all_resources: list | None = None,
    ) -> Optional[str]:
        """Assemble a ZIP archive with the correct directory structure.

        Structure:
          index.html          – merged main page
          content.txt         – text content (if uploaded)
          images/             – image resources
          styles/             – CSS files
          scripts/            – JS files
          fonts/              – font files
          documents/          – document resources
          pages/              – linked page HTML files
        """
        session_dir = os.path.join(self.storage_root, session_id)
        zip_filename = generate_safe_filename(session.url, ".zip")
        zip_path = os.path.join(session_dir, zip_filename)

        resources = all_resources if all_resources is not None else await self._get_all_resources(db, session_id)
        total_steps = len(resources) + len(linked_page_htmls) + 2  # +index.html +content.txt
        steps_done = 0

        try:
            with zipfile.ZipFile(
                zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=ZIP_COMPRESSION_LEVEL,
            ) as zf:
                # 1. Write index.html
                zf.writestr("index.html", main_html)
                steps_done += 1
                await self._update_progress(
                    db, session, "assembling_zip",
                    int(steps_done / max(total_steps, 1) * 100),
                )

                # 2. Write content.txt if present (6.3)
                if content_text is not None:
                    zf.writestr("content.txt", content_text)
                    steps_done += 1
                    await self._update_progress(
                        db, session, "assembling_zip",
                        int(steps_done / max(total_steps, 1) * 100),
                    )

                # 3. Write resources at their designated paths (6.2)
                batch_size = 10
                for i, resource in enumerate(resources):
                    local_path = resource.local_path
                    if not local_path:
                        # Skip resources without a local path
                        steps_done += 1
                        continue

                    # Sanitize the local path to prevent path traversal (6.4)
                    safe_path = sanitize_zip_path(local_path)
                    if not safe_path:
                        steps_done += 1
                        continue

                    storage_path = resource.storage_path
                    if not os.path.isfile(storage_path):
                        # Missing resource — skip with warning (6.6)
                        logger.warning(
                            "Missing resource file skipped: session=%s path=%s storage=%s",
                            session_id, safe_path, storage_path,
                        )
                        steps_done += 1
                        continue

                    try:
                        zf.write(storage_path, safe_path)
                    except Exception as exc:
                        logger.warning(
                            "Failed to add resource to ZIP: session=%s path=%s exc=%s",
                            session_id, safe_path, exc,
                        )
                    steps_done += 1
                    await self._update_progress(
                        db, session, "assembling_zip",
                        int(steps_done / max(total_steps, 1) * 100),
                        flush=(i + 1) % batch_size == 0 or (i + 1) == len(resources),
                    )

                # 4. Write linked pages in pages/ directory (6.2)
                # Use pre-computed filenames (with collision dedup) from assemble_session()
                for j, (page_hash, page_html) in enumerate(linked_page_htmls.items()):
                    filename = page_hash_to_filename.get(page_hash, f"{page_hash}.html")
                    page_filename = sanitize_zip_path(f"pages/{filename}")
                    if page_filename:
                        zf.writestr(page_filename, page_html)
                    steps_done += 1
                    await self._update_progress(
                        db, session, "assembling_zip",
                        int(steps_done / max(total_steps, 1) * 100),
                        flush=(j + 1) % batch_size == 0 or (j + 1) == len(linked_page_htmls),
                    )

            await self._update_progress(db, session, "assembling_zip", 100)
            return zip_path

        except Exception as exc:
            # Clean up partial ZIP (6.6)
            if os.path.exists(zip_path):
                try:
                    os.remove(zip_path)
                except OSError:
                    pass
            await self._mark_failed(db, session, f"ZIP assembly error: {exc}")
            return None

    # ------------------------------------------------------------------
    # Single-file HTML assembly (6.5)
    # ------------------------------------------------------------------

    async def _assemble_single_file(
        self,
        session_id: str,
        db,
        session,
        main_html: str,
        tab_url: str,
        filename_map: dict[str, str],
        content_text: Optional[str],
    ) -> Optional[str]:
        """Assemble a single self-contained HTML file with all resources inlined.

        Per spec (6.5):
        - Read resources from disk, inline all CSS/JS/images/fonts as base64
        - Ignore linked pages
        - Escape '--' in content.txt before injecting as HTML comment
        - Output .html instead of .zip
        - Use streaming/generator assembly to prevent RAM spikes
        """
        session_dir = os.path.join(self.storage_root, session_id)
        html_filename = generate_safe_filename(session.url, ".html")
        html_path = os.path.join(session_dir, html_filename)

        try:
            # Write single-file HTML to disk using streaming writer
            # This avoids holding both the soup tree and the full output
            # string in memory simultaneously (6.5 streaming requirement).
            await asyncio.to_thread(
                html_converter_service.write_single_file_to_disk,
                main_html, tab_url, self.storage_root, session_id,
                html_path, filename_map,
            )
            await self._update_progress(db, session, "assembling_zip", 50)

            # Embed content.txt if present (6.5 spec)
            if content_text is not None:
                self._embed_content_txt(html_path, content_text)

            await self._update_progress(db, session, "assembling_zip", 100)

            return html_path

        except Exception as exc:
            if os.path.exists(html_path):
                try:
                    os.remove(html_path)
                except OSError:
                    pass
            await self._mark_failed(db, session, f"Single-file assembly error: {exc}")
            return None

    # ------------------------------------------------------------------
    # CSS file conversion (Phase 3 helper)
    # ------------------------------------------------------------------

    async def _convert_css_resource(
        self,
        resource,
        tab_url: str,
        filename_map: dict[str, str],
        session_id: str,
        content_type_map: Optional[dict[str, str]] = None,
    ) -> None:
        """Rewrite url() references in a CSS resource file on disk."""
        storage_path = resource.storage_path
        if not os.path.isfile(storage_path):
            return

        try:
            with open(storage_path, "r", encoding="utf-8") as f:
                css_content = f.read()

            converted = await asyncio.to_thread(
                html_converter_service.convert_css_file,
                css_content, tab_url, filename_map,
                self.storage_root, session_id,
                content_type_map,
            )

            # Only rewrite if changed
            if converted != css_content:
                with open(storage_path, "w", encoding="utf-8") as f:
                    f.write(converted)
                logger.debug(
                    "CSS file rewritten: session=%s path=%s",
                    session_id, resource.local_path,
                )
        except Exception as exc:
            logger.warning(
                "Failed to convert CSS file: session=%s path=%s exc=%s",
                session_id, resource.local_path, exc,
            )

    # ------------------------------------------------------------------
    # Database helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _get_session(db, session_id: str):
        """Load a session from the database."""
        from sqlalchemy import select
        from app.models.session import Session
        stmt = select(Session).where(Session.id == session_id)
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    @staticmethod
    async def _get_all_resources(db, session_id: str) -> list:
        """Get all resources for a session."""
        from sqlalchemy import select
        from app.models.resource import Resource
        stmt = select(Resource).where(Resource.session_id == session_id)
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def _get_resources_by_prefix(db, session_id: str, prefix: str) -> list:
        """Get resources whose local_path starts with a given prefix."""
        from sqlalchemy import select
        from app.models.resource import Resource
        stmt = (
            select(Resource)
            .where(Resource.session_id == session_id)
            .where(Resource.local_path.startswith(prefix))
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def _update_progress(db, session, phase: str, pct: int, *, flush: bool = True) -> None:
        """Update assembly progress in the database.

        When flush=False, only update in-memory session fields without
        calling db.flush(). Caller is responsible for flushing later
        (e.g. at batch boundaries).
        """
        session.assembly_phase = phase
        session.assembly_progress_pct = max(0, min(100, pct))
        if flush:
            await db.flush()

    @staticmethod
    async def _mark_failed(db, session, reason: str) -> None:
        """Mark a session as failed with an error message."""
        from app.models.session import SessionStatus
        session.status = SessionStatus.FAILED
        session.error_message = reason
        session.assembly_phase = None
        session.assembly_progress_pct = None
        await db.flush()
        logger.error("Session marked as failed: id=%s reason=%s", session.id, reason)

    async def _cleanup_on_cancel(self, session_id: str, db_session_factory) -> None:
        """Clean up partial output after assembly cancellation."""
        try:
            async with db_session_factory() as db:
                session_obj = await self._get_session(db, session_id)
                if session_obj and session_obj.zip_path and os.path.exists(session_obj.zip_path):
                    os.remove(session_obj.zip_path)
        except Exception:
            logger.exception("Failed to clean up after cancellation for session %s", session_id)

    # ------------------------------------------------------------------
    # File helpers
    # ------------------------------------------------------------------

    def _read_content_txt(self, session_id: str) -> Optional[str]:
        """Read content.txt if it exists for a session."""
        content_path = os.path.join(self.storage_root, session_id, "content.txt")
        if os.path.isfile(content_path):
            try:
                with open(content_path, "r", encoding="utf-8") as f:
                    return f.read()
            except OSError as exc:
                logger.warning(
                    "Failed to read content.txt: session=%s exc=%s",
                    session_id, exc,
                )
        return None

    def _embed_content_txt(self, html_path: str, content_text: str) -> None:
        """Embed content.txt into an existing single-file HTML on disk.

        Reads the file, injects the content as an HTML comment before
        </body>, and writes it back.  Uses chunked write to avoid
        holding the entire file as both a string and encoded bytes
        simultaneously.

        Per spec (6.5):
        - Escape '--' in content to prevent breaking HTML comment
        - Cap at 1MB; truncate if exceeded
        """
        # Escape '--' to prevent breaking HTML comment
        safe_content = content_text.replace("--", "&#45;&#45;")
        # Cap at 1MB
        if len(safe_content.encode("utf-8")) > CONTENT_TXT_MAX_SIZE:
            safe_content = safe_content[:CONTENT_TXT_MAX_SIZE] + "\n[content truncated at 1MB limit]"
            safe_content = safe_content.replace("--", "&#45;&#45;")

        content_block = (
            f"\n<!-- content-txt-start -->\n{safe_content}\n<!-- content-txt-end -->\n"
        )

        # Read the existing file
        with open(html_path, "r", encoding="utf-8") as f:
            html = f.read()

        # Insert before </body> or append at end
        if "</body>" in html:
            html = html.replace("</body>", f"{content_block}</body>", 1)
        else:
            html += content_block

        # Write back in chunks, freeing the string after encoding
        encoded = html.encode("utf-8")
        del html  # Free the string — only hold encoded bytes
        chunk_size = 256 * 1024  # 256 KB
        with open(html_path, "wb") as f:
            offset = 0
            while offset < len(encoded):
                f.write(encoded[offset : offset + chunk_size])
                offset += chunk_size


# ---------------------------------------------------------------------------
# Module-level utility functions
# ---------------------------------------------------------------------------


def generate_safe_filename(url: str, extension: str) -> str:
    """Generate a safe filename from a URL (6.4).

    Format: hostname-path-timestamp, max 200 chars.
    Special characters in hostname → underscores; in path → hyphens.

    Args:
        url: The original page URL.
        extension: File extension including dot (e.g. ".zip", ".html").

    Returns:
        A sanitized filename string.
    """
    parsed = urlparse(url)
    hostname = parsed.hostname or "download"
    path = parsed.path.strip("/")

    # Replace special chars in hostname with underscores
    safe_hostname = re.sub(r"[^\w.\-]", "_", hostname)

    # Replace path separators with hyphens, other special chars with underscores
    if path:
        path_parts = path.split("/")
        safe_path = "-".join(re.sub(r"[^\w.\-]", "_", p) for p in path_parts if p)
    else:
        safe_path = ""

    base = f"{safe_hostname}-{safe_path}" if safe_path else safe_hostname

    # Truncate to leave room for extension and timestamp
    max_base = MAX_FILENAME_LENGTH - len(extension) - 12  # 12 for _timestamp
    if len(base) > max_base:
        base = base[:max_base]

    timestamp = int(time.time())
    return f"{base}_{timestamp}{extension}"


def sanitize_zip_path(path: str) -> Optional[str]:
    """Sanitize a client-provided file path for ZIP inclusion (6.4).

    Prevents path traversal outside the intended ZIP directory structure.
    Returns None if the path is fundamentally unsafe.

    Args:
        path: Client-provided path (e.g., "images/photo.jpg").

    Returns:
        Sanitized path safe for ZIP inclusion, or None.
    """
    if not path or not path.strip():
        return None

    # Normalize the path
    normalized = os.path.normpath(path).lstrip("/.")

    # Use PurePosixPath for validation (ZIP uses forward slashes)
    posix = PurePosixPath(normalized)

    # Reject absolute paths and path traversal
    if posix.is_absolute() or ".." in posix.parts:
        # Try to salvage by using just the filename
        if posix.name and posix.name != ".":
            # Check the name is not itself dangerous
            name_posix = PurePosixPath(posix.name)
            if not name_posix.is_absolute() and ".." not in name_posix.parts:
                return posix.name
        return None

    # Ensure no empty parts (e.g., double slashes)
    parts = [p for p in posix.parts if p]
    if not parts:
        return None

    return "/".join(parts)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

zip_assembler_service = ZipAssemblerService()
