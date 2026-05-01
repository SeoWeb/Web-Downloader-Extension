## 1. Build content-type map in assembler

- [x] 1.1 In `server/app/services/zip_assembler.py`, after querying resources via `_get_all_resources()`, build `content_type_map` dict from `{r.original_url: r.content_type}` for resources where `content_type` is not None
- [x] 1.2 Pass `content_type_map` to `html_converter_service.convert_html()` call (main page, ~line 140)
- [x] 1.3 Pass `content_type_map` to `html_converter_service.convert_linked_page_html()` call (linked pages, ~line 169)

## 2. Add content-type map parameter to HTML converter pipeline

- [x] 2.1 Add `content_type_map: Optional[dict[str, str]] = None` parameter to `convert_html()` function in `server/app/services/html_converter.py`
- [x] 2.2 Add same parameter to `HtmlConverterService.convert_html()` facade method
- [x] 2.3 Add same parameter to `HtmlConverterService.convert_linked_page_html()` facade method
- [x] 2.4 Pass `content_type_map` through `convert_html()` → `_convert_images()` and `_convert_background_images()`

## 3. Use content-type map in image fallback paths

- [x] 3.1 Add helper `_lookup_content_type(url, tab_url, content_type_map)` that tries exact URL, clean URL (no query params), and resolved full URL lookups
- [x] 3.2 Update `_convert_img_src()` fallback (~line 402): look up content-type, pass to `generate_image_filename(clean_src, content_type)`
- [x] 3.3 Update `_convert_lazy_load_attrs()` fallback (~line 426): look up content-type, pass to `generate_image_filename(clean, content_type)`
- [x] 3.4 Update `_convert_srcset_attr_value()` fallback (~line 472): look up content-type, pass to `generate_image_filename(clean, content_type)`
- [x] 3.5 Update `_convert_background_images()` fallback paths: same content-type lookup pattern
- [x] 3.6 Update `<source src>` fallback (~line 321): same content-type lookup pattern

## 4. Verify

- [x] 4.1 Run server test suite: `cd server && python -m pytest`
- [ ] 4.2 Manual test: download a page with extensionless image URLs (e.g., Apple Store) and verify images get correct extensions in output HTML
