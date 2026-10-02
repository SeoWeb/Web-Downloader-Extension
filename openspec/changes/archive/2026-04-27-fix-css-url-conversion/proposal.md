## Why

CSS `url()` references in inline styles and `<style>` tags are only converted when they appear in `background-image` properties. Other CSS properties that use `url()` — such as custom properties (`--image-url`), shorthand `background`, `list-style-image`, `content`, `mask-image`, and `border-image` — are left with their original absolute URLs, causing broken images in downloaded pages (e.g., eBay product images using `--image-url: url(...)`).

## What Changes

- Expand the extension-side `background-image-converter.ts` to match **any** `url(...)` pattern in inline styles and `<style>` tags, not just `background-image: url(...)`
- Expand the server-side `html_converter.py` to match **any** `url(...)` pattern in inline styles and `<style>` tags, not just `background-image: url(...)`
- Update element selection selectors from `[style*='background-image']` to `[style*='url(']`
- Add tests for CSS custom property, shorthand `background`, and other `url()` property conversions

## Capabilities

### New Capabilities

- `css-url-conversion`: Generalized CSS `url()` conversion that handles all CSS properties containing `url()` references (not just `background-image`)

### Modified Capabilities

- `html-processing`: Background image URL conversion scenarios are expanded to cover all `url()` patterns, not just `background-image: url(...)`
- `server-html-converter`: Inline style conversion requirement is expanded from `background-image: url(...)` to all `url()` patterns in inline styles

## Impact

- `src/background/html-utils/background-image-converter.ts` — regex and element selector changes
- `server/app/services/html_converter.py` — regex and element selector changes
- `server/tests/test_html_converter.py` — new test cases
- Existing `background-image: url(...)` behavior is preserved as a subset of the generalized pattern
