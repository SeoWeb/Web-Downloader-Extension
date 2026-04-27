## 1. Extension-side (TypeScript) Changes

- [x] 1.1 Update `convertBackgroundImageUrlsToRelative()` in `src/background/html-utils/background-image-converter.ts` — change regex from `background-image\s*:\s*url\(['"]?(.*?)['"]?\)` to `url\(['"]?(.*?)['"]?\)` so it matches any CSS `url()` pattern
- [x] 1.2 Update `convertBackgroundImagesToRelative()` in the same file — change element selector from `[style*='background-image']` to `[style*='url(']`
- [x] 1.3 Update `convertBackgroundImageUrlsToBase64()` in the same file — change regex from `background-image\s*:\s*url\(['"]?(.*?)['"]?\)` to `url\(['"]?(.*?)['"]?\)`
- [x] 1.4 Update `convertBackgroundImagesToBase64()` in the same file — change element selector from `[style*='background-image']` to `[style*='url(']`
- [x] 1.5 Update docstrings/comments in `background-image-converter.ts` to reflect generalized CSS URL conversion

## 2. Server-side (Python) Changes

- [x] 2.1 Update `convert_background_images()` in `server/app/services/html_converter.py` — change `soup.find_all(attrs={"style": re.compile("background-image", ...)})` to `soup.find_all(attrs={"style": re.compile("url\\(", ...)})`
- [x] 2.2 Update `_convert_bg_image_urls()` in the same file — change from using `BG_IMAGE_URL_PATTERN` to `CSS_URL_PATTERN` and adjust the replacement function to use group index 2 (the URL content) instead of group index 1
- [x] 2.3 Update `_inline_style_bg_images()` in the same file — change from using `BG_IMAGE_URL_PATTERN` to `CSS_URL_PATTERN` and adjust the replacement function accordingly
- [x] 2.4 Update `_build_single_file_soup()` in the same file — change the inline style background-image detection from `"background-image" in style.lower() and "url(" in style` to just `"url(" in style` for the element filtering
- [x] 2.5 Update docstrings in `html_converter.py` to reflect generalized CSS URL conversion

## 3. Tests

- [x] 3.1 Add test case in `server/tests/test_html_converter.py` for CSS custom property `--image-url: url(...)` conversion in inline styles
- [x] 3.2 Add test case in `server/tests/test_html_converter.py` for shorthand `background: url(...)` conversion in inline styles
- [x] 3.3 Add test case for `list-style-image: url(...)` conversion in inline styles
- [x] 3.4 Add test case for CSS custom property `url()` conversion in `<style>` tags
- [x] 3.5 Add test case for multiple `url()` references in the same inline style
- [x] 3.6 Add test case for data URI preservation in non-background-image `url()` contexts
- [x] 3.7 Verify existing `background-image: url(...)` tests still pass
