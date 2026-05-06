## 1. Server-side CSS inlining function

- [x] 1.1 Add `inline_css_into_html()` function in `server/app/services/html_converter.py` that reads CSS files from disk and replaces `<link rel="stylesheet">` with `<style>` tags, adjusting `url()` paths from `../` to `./` for root-level HTML
- [x] 1.2 Add `inline_css_into_html()` method to `HtmlConverterService` facade class
- [x] 1.3 Add Phase 3b CSS inlining step in `server/app/services/zip_assembler.py` `assemble_session()` — runs for non-single-file sessions, inlines CSS into main HTML and linked page HTMLs

## 2. Server-side converter path fixes

- [x] 2.1 Fix `_convert_stylesheets()` in `html_converter.py` to generate `.css` filename fallback for extensionless URLs instead of leaving them unchanged
- [x] 2.2 Fix `_convert_scripts()` in `html_converter.py` to generate `.js` filename fallback for extensionless URLs instead of leaving them unchanged
- [x] 2.3 Add `undefined` prefix stripping in `_convert_stylesheets()` and `_convert_scripts()` for filenames starting with "undefined"

## 3. Client-side filename fixes

- [x] 3.1 Fix `src/background/fileHandlers/css.ts` — add `.css` extension for extensionless filenames using Content-Type header, strip `undefined` prefix
- [x] 3.2 Fix `src/background/fileHandlers/js.ts` — add `.js` extension for extensionless filenames using Content-Type header, strip `undefined` prefix

## 4. Verification

- [x] 4.1 Run server tests (`pytest server/tests/`) to verify no regressions
- [ ] 4.2 Build extension and manually test downloading a complex website, extracting ZIP, opening via `file://` to confirm CSS renders correctly and no broken paths in console
