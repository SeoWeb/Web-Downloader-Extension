## 1. Add query hash helper

- [x] 1.1 Add `_get_query_hash()` function to `server/app/services/html_converter.py` — DJB2 hash of query string, returns 8-char zero-padded hex or empty string, matching the TypeScript `getQueryHash()` in `src/background/urlUtils.ts:401-415`
- [x] 1.2 Verify the Python DJB2 produces identical output to TypeScript for test vectors: `"?width=200"`, `"?wid=400&hei=400&fmt=jpeg"`, empty query, `"?modules=site.styles&only=styles"`

## 2. Update generate_image_filename

- [x] 2.1 Add optional `original_url: Optional[str] = None` parameter to `generate_image_filename()` in `server/app/services/html_converter.py`
- [x] 2.2 In the no-extension branch (line 226-237), compute query hash from `original_url or url_src` and append it to the filename: `f"{sanitized}_{query_hash}.{extension}"` when hash is non-empty

## 3. Update all fallback call sites

- [x] 3.1 `_convert_img_src` (line ~459): pass `original_url=original_src` to `generate_image_filename()`
- [x] 3.2 `_convert_lazy_load_attrs` (line ~490): pass `original_url=original` to `generate_image_filename()`
- [x] 3.3 `_convert_srcset_attr_value` (line ~544): pass `original_url=url` to `generate_image_filename()`
- [x] 3.4 `_convert_images` for `<source src>` (line ~338): pass `original_url=src` to `generate_image_filename()`
- [x] 3.5 `_convert_bg_image_urls` (line ~622): pass `original_url=image_url` to `generate_image_filename()`
- [x] 3.6 `_convert_css_file_impl` (line ~1039): pass `original_url=url` to `generate_image_filename()`

## 4. Verify

- [x] 4.1 Run existing server tests: `cd server && python -m pytest` — confirm no regressions
- [x] 4.2 Test with a page containing extensionless image URLs with query params — verify assembled HTML references correct `.jpg`/`.png` extensions instead of `.bin`
