## Why

Downloaded websites look broken when opened via `file://` protocol because Chrome blocks all external CSS/JS file loads due to CORS policy. Users extracting the ZIP and double-clicking `index.html` see an unstyled page. Additionally, some resource paths are malformed (missing file extensions, `undefined` prefix in URLs), causing further resource load failures.

## What Changes

- Inline CSS content into HTML as `<style>` tags during ZIP assembly, so styles work without external file loads via `file://` protocol
- Keep CSS files in `styles/` directory in the ZIP for completeness, but make HTML self-sufficient for rendering
- Adjust CSS `url()` paths from `../images/` to `./images/` when inlining into root `index.html`
- Fix extensionless CSS/JS filenames by using Content-Type headers to determine correct extension
- Strip `undefined` prefix from resource URLs (caused by website JS variables being undefined at capture time)
- Add server-side fallback in `_convert_stylesheets` and `_convert_scripts` for URLs without file extensions

## Capabilities

### New Capabilities

- `css-inlining-for-file-protocol`: Inlines CSS content into HTML during ZIP assembly so downloaded websites render correctly when opened via `file://` protocol without a web server

### Modified Capabilities

- `server-html-converter`: Add CSS inlining function and fix extensionless URL handling in stylesheet/script converters
- `server-zip-assembly`: Add CSS inlining step (Phase 3b) between CSS URL conversion and ZIP assembly
- `download-engine`: Fix CSS/JS filename generation for extensionless URLs and `undefined` prefix on client side

## Impact

- **Server**: `html_converter.py` (new inlining function, converter fixes), `zip_assembler.py` (assembly pipeline change)
- **Extension client**: `css.ts`, `js.ts` (filename generation fixes)
- **User experience**: Downloaded websites render correctly when opened locally via `file://`
- **Backward compatibility**: No breaking changes — single-file mode unaffected, ZIP output gains inline CSS in addition to separate files
