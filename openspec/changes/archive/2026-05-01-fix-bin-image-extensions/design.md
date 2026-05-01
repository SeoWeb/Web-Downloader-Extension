## Context

The server-side HTML converter (`server/app/services/html_converter.py`) rewrites image URLs in merged HTML to local paths. It first looks up the URL in the `filename_map` (built by the browser extension during download, which uses HTTP Content-Type to pick extensions). When the lookup misses, the fallback calls `generate_image_filename(url)` without any content-type, defaulting to `.bin`.

The server already stores each uploaded resource's `content_type` in the `Resource` DB model (`server/app/models/resource.py`) alongside `original_url`. This information is available during assembly but not currently passed to the converter.

**Current flow**:
1. Extension downloads image, detects Content-Type → generates filename with correct extension (e.g., `.jpg`)
2. Extension uploads the file to server (stored with correct local_path) + uploads filename map
3. Server assembles: tries filename map → miss → `generate_image_filename(url)` → `.bin`
4. Result: HTML references `images/foo.bin` but the actual file in ZIP is `images/foo_abc123.jpg`

## Goals / Non-Goals

**Goals:**
- Eliminate `.bin` extensions for images where the server has content-type information
- Make the fallback path content-type-aware using data already stored in the DB

**Non-Goals:**
- Fix the filename map lookup itself (separate concern, may have multiple root causes)
- Change the extension-side download or filename generation logic
- Add new API endpoints or change existing API contracts

## Decisions

### Decision: Build content-type map at assembly time and pass to converter

**Approach**: In `zip_assembler.py`, after querying resources from the DB, build a `dict[str, str]` mapping `original_url → content_type` and pass it as a new `content_type_map` parameter through `convert_html()` → `_convert_images()` → each fallback call site.

**Why this over alternatives**:
- *vs. querying DB inside converter*: Converter is a pure function (synchronous, no DB access). Keeping it that way preserves testability.
- *vs. fixing filename map lookup*: The map lookup can fail for many reasons (encoding, normalization, timing). Content-type awareness is a safety net that handles all cases.
- *vs. storing content-type in filename map*: Would require changing the extension-to-server protocol. Current approach uses data already available server-side.

### Decision: Use content-type map as fallback only, not primary path

The filename map remains the primary lookup. Content-type map is only used when the filename map misses. This preserves the existing behavior for successfully mapped images (which may have query-hash suffixes unique to the extension) and only improves the fallback.

### Decision: Resolve URL for content-type lookup

When looking up in the content-type map, resolve the image URL to its full form (same as `_lookup_filename_map` does) to maximize match probability. Also try the clean URL (without query params).

## Risks / Trade-offs

- **[Duplicate content-type keys]** → Multiple resources may share the same `original_url` (e.g., deduplication). The map uses the first entry found. Since duplicates have the same content-type, this is safe.
- **[Missing content-type in DB]** → Some resources may have `None` content-type (e.g., failed uploads, streaming chunks). These are filtered out during map construction. Fallback remains `.bin` for these, which is correct — no content-type means we genuinely don't know the type.
- **[Performance]** → Building the map is a single dict comprehension over already-queried resources. No additional DB queries.
