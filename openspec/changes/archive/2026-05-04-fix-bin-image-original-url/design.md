## Context

The server-side HTML converter uses two strategies to determine image filename extensions:

1. **Filename map** (primary): Uploaded by the extension, maps web URLs → local paths (e.g., `"https://..."` → `"images/foo.png"`). The extension generates correct extensions because it has access to HTTP `Content-Type` headers or MIME sniffing.

2. **Content-type map** (fallback): Built from the Resource DB, maps `original_url` → `content_type`. Used when the filename map lookup misses.

The content-type map was broken from the start because `ServerStorageAdapter.addFile()` sets `originalUrl` to the local file path (e.g., `"images/foo.png"`) instead of the actual web URL. Since `_lookup_content_type()` tries to match web URLs against the map, it never finds entries, and `generate_image_filename()` defaults to `.bin`.

Two prior fixes addressed other causes:
- `2026-05-01-fix-bin-image-extensions` added the content-type map fallback (broken due to the wrong key).
- `2026-05-04-sniff-image-mime-type` fixed the extension-side filename generation for opaque CORS responses by sniffing blob bytes.

Both fixes are insufficient because the `original_url` is still the file path, so the server-side fallback remains broken.

## Goals / Non-Goals

**Goals:**
- Store the actual web URL in the server's Resource DB so the content-type map works correctly when filename map lookup misses.
- Add a secondary `filename_ext_map` safety net derived from `local_path` values, so even when web URL lookup fails, the converter can recover the correct extension from files already on disk.
- Zero behavioral change for images that already have correct extensions.

**Non-Goals:**
- Change the filename map lookup logic or URL matching strategies.
- Add new API endpoints or change the resource upload wire protocol (the `originalUrl` field already exists).
- Change the extension's MIME sniffing or filename generation logic.
- Fix all cases where images aren't downloaded — only fix the server-side `.bin` fallback.

## Decisions

### Decision: Pass original image URL as `originalUrl` from the image handler

**Choice:** Extend `IStorageAdapter.addFile()` with an optional `originalUrl?: string` parameter. In `images.ts`, pass `originalSrc` (the web URL from the HTML attribute) to `storage.addFile()`.

**Why this over alternatives:**
- *vs. building the URL from the local path on the server*: The local path is a mangled version of the URL path, not reversible.
- *vs. passing URLs via a separate API*: The `originalUrl` field already exists in the upload endpoint; we just need to send the right value.
- *vs. fixing only the server*: The server has no way to reconstruct the web URL from a file path.

**Trade-off:** Adds a parameter to the `IStorageAdapter` interface. Non-server adapters (JSZipAdapter, IndexedDBAdapter) ignore it — no behavioral change.

### Decision: Build `filename_ext_map` from `local_path` values on the server

**Choice:** In `zip_assembler.py`, build a `dict[str, str]` mapping basename-without-extension → image-extension from each resource where `local_path` starts with `images/` and `content_type` is available.

**Why this over alternatives:**
- *vs. looking up files on disk during conversion*: Requires filesystem I/O in a pure conversion function; breaks testability.
- *vs. modifying `_lookup_content_type()` to try multiple key formats*: The `content_type_map` is already keyed by web URL (after fix 1); adding local path keys would cause false matches. A separate `filename_ext_map` is cleaner.
- *vs. building the content_type_map with both URL and local_path keys*: Mixing key types in one map is error-prone; a separate map has clear semantics.

### Decision: Thread `filename_ext_map` through the converter chain

**Choice:** Add `filename_ext_map: Optional[dict[str, str]]` parameter to `convert_html()`, `_convert_images()`, `_convert_img_src()`, `_convert_lazy_load_attrs()`, `_convert_srcset()`, `_convert_srcset_attr_value()`, `_convert_source_elements()`, and the CSS conversion fallback path.

In each fallback path where `generate_image_filename()` is called, after getting the result, if the filename ends in `.bin`, look up the base name in `filename_ext_map` and substitute the correct extension if found.

**Why this over alternatives:**
- *vs. looking up in the converter globally*: The converter functions are stateless by design; threading the map is consistent with how `filename_map` and `content_type_map` are already threaded.
- *vs. modifying only `_convert_img_src`*: Other paths (lazy-load, srcset, CSS `url()`) also call `generate_image_filename()` and would miss the fix.

### Decision: Fix both the original URL AND add the local-path safety net

**Why two fixes:** The original URL fix (Fix 1) is the primary solution — it makes the content-type map correctly resolve web URLs to content types. However, the filename map lookup can still miss for various reasons (CSS backgrounds extracted from stylesheets, URLs not in the images array, encoding mismatches). The `filename_ext_map` (Fix 2) is a safety net that works regardless of whether the URL could be matched — it uses the fact that the correct file already exists on disk with the right extension.

## Risks / Trade-offs

- **Risk: Interface change breaks existing adapter implementations.** Mitigation: Parameter is optional with undefined default. All existing callers that don't pass it continue to work.
- **Risk: URL encoding mismatches between extension and server.** Mitigation: The web URL sent to the server is the same URL used for filename map keys. The `_lookup_content_type()` function already handles resolution and query-param stripping.
- **Risk: Large `filename_ext_map` increases memory during assembly.** Mitigation: The map is one short string per image resource — negligible compared to the HTML and file content already in memory.
- **Risk: Base name collisions in `filename_ext_map` (two different images with different extensions but same basename).** Mitigation: The extension-side filename generation already prevents collisions by including parent path segments and query hashes. The last matching entry wins, which is acceptable since collisions would mean two resources with the same filename were uploaded (which can't happen due to dedup).

## Migration Plan

No migration needed. Changes are additive:
- Existing `addFile()` calls without `originalUrl` fall back to current behavior.
- The `filename_ext_map` is only consulted when a `.bin` filename would be generated — no change to existing successful conversion paths.
- Rolling back is a revert of the touched files with no data migration required.
