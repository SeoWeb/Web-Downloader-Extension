## 1. Server-side CSS inlining function

- [x] 1.1 Add `inline_css_into_html()` function in `server/app/services/html_converter.py` that reads CSS files from disk and replaces `<link rel="stylesheet">` with `<style>` tags, adjusting `url()` paths from `../` to `./` for root-level HTML
- [x] 1.2 Add `inline_css_into_html()` method to `HtmlConverterService` facade class
- [x] 1.3 Add Phase 3b CSS inlining step in `server/app/services/zip_assembler.py` `assemble_session()` — runs for non-single-file sessions, inlines CSS into main HTML and linked page HTMLs

## 2. Server-side converter path fixes

- [x] 2.1 Fix `_convert_stylesheets()` in `html_converter.py` to generate `.css` filename fallback for extensionless URLs instead of leaving them unchanged
- [x] 2.2 Fix `_convert_scripts()` in `html_converter.py` to generate `.js` filename fallback for extensionless URLs instead of leaving them unchanged
- [x] 2.3 Add `undefined` prefix stripping in `_convert_stylesheets()` and `_convert_scripts()` for filenames starting with "undefined"

## 3. Client-side filename fixes

- [x] 3.1 Fix `src/background/fileHandlers/css.ts` — add `.css` extension for extensionless filenames, strip `undefined` prefix
- [x] 3.2 Fix `src/background/fileHandlers/js.ts` — add `.js` extension for extensionless filenames, strip `undefined` prefix

## 4. UUID storage path resolution fix

- [x] 4.1 Fix `_resolve_local_path()` in `html_converter.py` to accept a `local_path_to_storage` mapping that translates logical paths (e.g., `styles/main.css`) to actual UUID-based disk paths, inserted as primary lookup before existing direct-path fallback
- [x] 4.2 Thread `local_path_to_storage` parameter through: `_read_text_resource`, `_read_resource_as_data_uri`, `_inline_css_urls`, `_inline_style_bg_images`, `_build_single_file_soup`, `convert_html_to_single_file`, `write_single_file_to_disk`, `inline_css_into_html`, and corresponding `HtmlConverterService` facade methods
- [x] 4.3 Build `local_path_to_storage` dict from `all_resources` in `zip_assembler.py` after fetching resources, pass to Phase 3b `inline_css_into_html` calls (main HTML + linked pages) and to `_assemble_single_file`
- [x] 4.4 Add `local_path_to_storage` parameter to `_assemble_single_file()` and pass through to `write_single_file_to_disk`

## 5. Verification

- [x] 5.1 Run server tests (`pytest server/tests/`) to verify no regressions
- [x] 5.2 Add tests for UUID-based path resolution: create UUID-named file on disk, build mapping, verify `inline_css_into_html()` inlines correctly
- [ ] 5.3 Build extension and manually test downloading a complex website (e.g., mercadolivre.com.br), extracting ZIP, opening via `file://` to confirm CSS renders correctly and no broken paths in console
