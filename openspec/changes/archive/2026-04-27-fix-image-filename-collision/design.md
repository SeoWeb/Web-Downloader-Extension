## Context

Both the extension-side (`urlUtils.ts`) and server-side (`html_converter.py`) `generateImageFilename` functions produce filenames from only the last URL path segment when it has a recognized image extension. The extension-less path already joins all segments with `_` for uniqueness, but the image-extension path skips this. CDN URLs from sites like eBay use a unique directory identifier per image but share a common filename suffix (e.g., `s-l960.webp`), causing silent data loss when multiple images overwrite the same file.

The fix has already been implemented in both codebases. This change documents the design decision retroactively.

## Goals / Non-Goals

**Goals:**
- Include parent path segments in image filenames to prevent collisions when different URLs share the same last path segment
- Maintain parity between TypeScript (`generateImageFilename`) and Python (`generate_image_filename`) implementations
- Preserve single-segment URL behavior unchanged (no unnecessary path prefix)

**Non-Goals:**
- Changing how the extension-less URL branch works (already joins all segments)
- Adding explicit collision detection or deduplication at download time
- Changing the filename map structure or ZIP assembly process

## Decisions

### Decision 1: Join all segments with `_` when multiple segments exist

When a URL has multiple path segments and the last segment has a recognized image extension, join all segments with `_` and pass the result through `fixFilename` (which sanitizes and truncates to 100 chars).

For example: `/images/g/hXIAAOSwu-BoJfB9/s-l960.webp` → `images_g_hXIAAOSwu-BoJfB9_s-l960.webp`

**Alternative considered**: Include only the parent segment (second-to-last). Rejected because it would still collide for URLs like `/images/g/ABC/photo.jpg` and `/images/h/ABC/photo.jpg` where the parent segment is the same but in different directories.

**Alternative considered**: Hash-based suffix. Rejected because it produces non-human-readable filenames and adds complexity. The full-path approach is simpler and consistent with the extension-less branch.

### Decision 2: Single-segment paths unchanged

When the URL has only one path segment (e.g., `/photo.jpg`), the behavior remains `photo.jpg` — no prefix needed since there's nothing to collide with at that level.

## Risks / Trade-offs

- **Longer filenames**: Multi-segment URLs produce longer filenames (e.g., `images_g_hXIAAOSwu-BoJfB9_s-l960.webp` instead of `s-l960.webp`). → **Mitigation**: `fixFilename` truncates the name part to 100 characters, and most filesystems support 255-char filenames.

- **Existing downloads produce different filenames**: If a user re-downloads the same page, image filenames will differ from a previous download. → **Mitigation**: This only affects the local filename in the ZIP; the content is identical. No migration needed since each download is independent.

- **Very deep paths could truncate uniqueness**: A deeply nested URL with many segments might have its name truncated, potentially re-introducing collisions. → **Mitigation**: 100-char name limit is generous; real-world CDN URLs rarely have more than 4-5 segments. The truncation preserves the tail of the name (which includes the filename), making collisions unlikely.
