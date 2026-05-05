## Context

The server-side HTML converter (`html_converter.py`) has a 3-tier fallback for determining image extensions when rewriting `<img src>` URLs:

1. **filename_map** — exact URL-to-filename mapping uploaded by the extension
2. **content_type_map** — URL-to-MIME-type mapping built from stored resources
3. **filename_ext_map** — base-name-to-extension safety net built from stored resource paths

When tiers 1 and 2 miss (e.g. URL format mismatch), tier 3 (`_maybe_fix_bin_extension`) compares the base name of the fallback filename against keys in `filename_ext_map`. But the extension's `generateImageFilename()` includes a DJB2 hash of the query string in filenames (e.g. `image_123_a1b2c3d4.jpg`), while the server's `generate_image_filename()` does not (e.g. `image_123.bin`). The base names never match, so the safety net fails.

## Goals / Non-Goals

**Goals:**
- Make the server's `generate_image_filename()` produce the same base name (including query hash) as the extension's `generateImageFilename()`
- Ensure `_maybe_fix_bin_extension()` finds matching base names for all downloaded images

**Non-Goals:**
- Changing how the extension generates filenames
- Modifying the filename_map or content_type_map lookup logic
- Handling images that were never downloaded (those correctly produce `.bin` since no file exists)
- Adding query hash to `fix_filename()` (only the no-extension branch of `generate_image_filename` needs it)

## Decisions

**Decision: Port DJB2 query hash exactly from TypeScript**

The extension uses a DJB2 hash of the full query string (`?` included), producing an 8-char zero-padded hex string. The Python implementation must produce identical output for the same inputs. Using a different hash algorithm would break the base-name match.

**Decision: Pass `original_url` as separate parameter rather than using `url_src`**

Callers currently strip query params from `url_src` before passing it to `generate_image_filename()`. The hash needs the original URL with query params intact. Adding an optional `original_url` parameter is the cleanest approach — existing callers work unchanged (backward compatible), and only the 6 fallback call sites need updating.

**Decision: Hash is computed from the query string only (same as TypeScript)**

The hash uses `url.search` (the `?key=value` portion), not the full URL. This matches the TypeScript implementation exactly.

## Risks / Trade-offs

- **[Hash mismatch]** If the Python DJB2 doesn't produce identical output to JavaScript → images still get `.bin`. Mitigation: verify with cross-language test vectors (e.g. `"?width=200"` → same hex in both).
- **[Existing test breakage]** Tests for `generate_image_filename` that use extensionless URLs with query params may get different output. Mitigation: update test expectations; URLs without query params are unaffected.
- **[Performance]** Negligible — DJB2 is O(n) on query string length, already computed on every image in the extension.
