## Context

The WebsiteDownloader extension saves websites as ZIP files with separate `index.html`, `styles/`, `scripts/`, and `images/` directories. When users extract the ZIP and open `index.html` by double-clicking (which opens via `file://` protocol), Chrome blocks all external CSS and JS loads due to CORS policy. This makes downloaded websites visually broken.

The extension already has a "single-file" mode that inlines all resources as base64 data URIs, but it's not the default and produces very large files. We need a targeted fix for the default multi-file ZIP mode.

Additionally, some resource paths are malformed: extensionless filenames (`styles/style`, `scripts/client`) and URLs with `undefined` prefix from broken website JS.

## Goals / Non-Goals

**Goals:**
- Make CSS styles render correctly when downloaded websites are opened via `file://` protocol
- Fix broken resource paths (extensionless filenames, `undefined` prefix)
- Maintain backward compatibility — no breaking changes to existing functionality

**Non-Goals:**
- Making JS files work via `file://` (JS is less critical for visual rendering; users would need a local server for full interactivity)
- Changing the default download mode to single-file
- Handling all CORS-related issues (fonts referenced in CSS still need relative paths to work)

## Decisions

### 1. Inline CSS as `<style>` tags instead of changing to single-file mode

**Decision**: In multi-file ZIP mode, replace `<link rel="stylesheet">` with inline `<style>` tags containing the CSS content.

**Alternatives considered**:
- *Make single-file mode the default*: Would fix CSS but produces huge files with base64-encoded images. Bad UX for image-heavy sites.
- *Bundle a local server*: Complex, requires user to run a server process. Not practical for a browser extension.
- *Use `--allow-file-access-from-files` flag*: Requires user to launch Chrome with a special flag. Not discoverable.

**Rationale**: Inlining CSS is surgical — it solves the visual rendering problem without the overhead of base64-encoding all images. CSS is typically 50-500KB total, while images can be tens of MB.

### 2. Adjust CSS `url()` paths from `../` to `./` when inlining

**Decision**: When CSS content is inlined from `styles/` into root `index.html`, rewrite `url(../images/...)` to `url(./images/...)`.

**Rationale**: Phase 3 (CSS URL conversion) rewrites `url()` references with `../` prefix because CSS files live in `styles/`. After inlining into `index.html` at root level, the correct prefix is `./`. A simple string replacement of `../` → `./` handles all cases (images, fonts).

### 3. Keep CSS files in the ZIP alongside inline styles

**Decision**: Continue writing CSS files to `styles/` in the ZIP, even though the HTML has inline CSS.

**Rationale**: Belt-and-suspenders approach. Some pages may reference CSS dynamically or in ways the converter doesn't catch. The inline styles handle the primary rendering path; the separate files serve as fallback.

### 4. Append extension for extensionless CSS/JS filenames without Content-Type check

**Decision**: When a CSS/JS URL has no file extension, append `.css` or `.js` directly without checking the HTTP Content-Type header. The handler context already guarantees the resource type (CSS handler processes only stylesheets, JS handler processes only scripts).

**Rationale**: The Content-Type check is unnecessary because each handler only receives resources of the correct type. The CSS handler is invoked exclusively for `<link rel="stylesheet">` resources, and the JS handler for `<script>` resources. Adding a Content-Type check would be redundant belt-and-suspenders with no practical benefit.

### 5. UUID-based storage path resolution via `local_path_to_storage` mapping

**Decision**: Thread a `local_path → storage_path` mapping from the database through the assembly pipeline to `_resolve_local_path()`, rather than trying to derive disk paths from logical paths.

**Rationale**: Resources are stored on disk with UUID filenames (e.g., `resources/abc-123`) in the `resources/` directory. The `local_path` field (e.g., `styles/main.css`) only determines placement in the ZIP archive. The mapping between logical name and physical disk path lives in the database `resources` table. Without this mapping, `_resolve_local_path()` constructs wrong paths and `inline_css_into_html()` silently fails for all CSS files.

**Implementation**: Build a `{local_path: storage_path}` dict from `all_resources` in `zip_assembler.py` and pass it as a new optional parameter through the call chain (`_resolve_local_path` → `_read_text_resource` / `_read_resource_as_data_uri` → `_build_single_file_soup` / `inline_css_into_html`). The parameter defaults to `None` for backward compatibility with tests that create files at human-readable paths.

## Risks / Trade-offs

- **[Large CSS increases HTML size]** → Acceptable tradeoff. Total CSS is usually under 500KB. If a site has >2MB of CSS, the HTML gets larger but still renders correctly.

- **[CSS `@import` chains]** → Phase 3 already resolves `@import` references during CSS URL conversion. After inlining, redundant `@import` rules within `<style>` tags are harmless (they reference files that are also inlined). No special handling needed.

- **[CSS order dependencies]** → BeautifulSoup processes elements in document order, so replacing `<link>` with `<style>` preserves specificity rules.

- **[Linked pages in `pages/` directory]** → For linked pages, CSS inlining must keep `../images/` paths (since the page is in `pages/`). The path adjustment uses the same `path` parameter already passed to converters.

## Migration Plan

No migration needed. This change only affects new downloads. Existing downloaded ZIPs are not modified. The change is purely additive to the assembly pipeline.

## Open Questions

None — the approach is well-defined based on the existing single-file mode implementation.
