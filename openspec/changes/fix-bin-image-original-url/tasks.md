## 1. Extension: IStorageAdapter interface

- [x] 1.1 Add optional `originalUrl?: string` parameter to `IStorageAdapter.addFile()` in `storage-adapter.ts`
- [x] 1.2 Update `JSZipAdapter.addFile()` signature to accept the optional parameter (no behavioral change)
- [x] 1.3 Update `IndexedDBAdapter.addFile()` signature to accept the optional parameter (no behavioral change)

## 2. Extension: ServerStorageAdapter

- [x] 2.1 Add `originalUrl` parameter to `ServerStorageAdapter.addFile()` — when provided, use it as the `originalUrl` sent to the server instead of `path`

## 3. Extension: Image handler

- [x] 3.1 In `images.ts`, pass `originalSrc` (the web URL from the HTML attribute) as the 4th argument to `storage.addFile()`

## 4. Server: Build filename_ext_map in ZIP assembler

- [ ] 4.1 In `zip_assembler.py` `assemble_session()`, build `filename_ext_map: dict[str, str]` from resources where `local_path` starts with `images/` and `content_type` is available — map basename-without-extension → image extension
- [ ] 4.2 In `zip_assembler.py`, pass `filename_ext_map` to `html_converter_service.convert_html()` and CSS conversion calls

## 5. Server: Thread filename_ext_map through converter

- [ ] 5.1 Add `filename_ext_map: Optional[dict[str, str]]` parameter to `HtmlConverterService.convert_html()`
- [ ] 5.2 Add `filename_ext_map` parameter to `_convert_images()`, threading it through to `_convert_img_src()`, `_convert_lazy_load_attrs()`, `_convert_srcset()`, `_convert_srcset_attr_value()`, and `<source>` element handling
- [ ] 5.3 Add `filename_ext_map` parameter to `_convert_background_images()` and `_convert_bg_image_urls()`, threading it to `_convert_img_url()` where `generate_image_filename()` is called
- [ ] 5.4 Add `filename_ext_map` parameter to `HtmlConverterService.convert_css_file()` and its internal `_convert_css_file()` function, threading it to where `generate_image_filename()` is called for CSS `url()` references
- [ ] 5.5 Add `filename_ext_map` parameter to `HtmlConverterService.convert_linked_page_html()`

## 6. Server: Apply filename_ext_map correction in fallback paths

- [ ] 6.1 In `_convert_img_src()`, after `generate_image_filename()` returns a result, check if the filename ends with `.bin` — if so, look up the basename in `filename_ext_map` and substitute the extension if found
- [ ] 6.2 Apply the same `.bin` correction in `<source>` element fallback path within `_convert_images()`
- [ ] 6.3 Apply the same `.bin` correction in `_convert_lazy_load_attrs()` fallback path for single-value attributes
- [ ] 6.4 Apply the same `.bin` correction in `_convert_srcset()` fallback path for each srcset entry
- [ ] 6.5 Apply the same `.bin` correction in CSS `url()` fallback paths (`_convert_bg_image_urls()` and `_convert_css_file()`)

## 7. Verification

- [ ] 7.1 Run existing tests to ensure no regressions: `npm test` (extension) and server tests
- [ ] 7.2 Manual test: download a page containing Apple Store CDN images (e.g., apple.com) and verify that images in the output HTML reference `.png` / `.jpg` instead of `.bin`
