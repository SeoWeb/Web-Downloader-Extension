## Context

Both the extension-side (`background-image-converter.ts`) and server-side (`html_converter.py`) CSS URL converters only match `background-image: url(...)` patterns. The server already has a `CSS_URL_PATTERN` that matches any `url(...)` — it's used for CSS file conversion but not for inline style conversion. The extension uses a `background-image\s*:\s*url(...)` regex. This change generalizes both to match any CSS property containing `url()`.

## Goals / Non-Goals

**Goals:**
- Convert all `url()` references in inline styles and `<style>` tags, regardless of which CSS property they appear in (custom properties, shorthand `background`, `list-style-image`, `content`, `mask-image`, `border-image`, etc.)
- Preserve existing `background-image: url(...)` conversion behavior as a subset
- Apply the same change consistently to both extension-side (TypeScript) and server-side (Python) converters

**Non-Goals:**
- Changing how standalone CSS file conversion works (it already uses the general `CSS_URL_PATTERN`)
- Adding new resource type detection logic (images, fonts, etc.) — all `url()` references in inline styles are treated as images, matching current behavior for `background-image`
- Converting `url()` references in JavaScript or other non-CSS contexts

## Decisions

### Decision 1: Use `CSS_URL_PATTERN` instead of `BG_IMAGE_URL_PATTERN` for inline style conversion

The server already defines `CSS_URL_PATTERN = re.compile(r"url\(\s*(['"]?)(.*?)\1\s*\)")` which matches any `url(...)` — not just `background-image: url(...)`. The `BG_IMAGE_URL_PATTERN` is more restrictive. For inline style and `<style>` tag conversion, switching to `CSS_URL_PATTERN` is the minimal change.

For the extension, replace the `background-image\s*:\s*url\(['"]?(.*?)['"]?\)` regex with `url\(['"]?(.*?)['"]?\)` — matching the same general pattern.

**Alternative considered**: Create a new combined regex that explicitly lists all CSS properties that can contain URLs. Rejected because it would be fragile — new CSS properties (like `container-background`) would be missed, and custom properties (`--*`) can't be enumerated.

### Decision 2: Change element selector from `[style*='background-image']` to `[style*='url(']`

Both the extension and server filter elements by checking if their `style` attribute contains `background-image`. This misses elements with other `url()`-containing properties. Changing to `[style*='url(']` catches all inline styles with URL references.

**Alternative considered**: Don't filter at all — process every element with a `style` attribute. Rejected because it would be less efficient; `url(` is a precise enough filter.

### Decision 3: Keep function names unchanged but update docstrings

Renaming `convert_background_images` → `convert_css_urls` would require updating all call sites across both codebases. Since this is an internal function, keeping the name and updating the docstring is less disruptive. The function's behavior expands but the name remains a recognizable entry point.

### Decision 4: Server-side single-file inlining uses the same pattern change

The `_inline_style_bg_images` function in single-file mode also uses `BG_IMAGE_URL_PATTERN`. It should switch to `CSS_URL_PATTERN` as well, so that custom property URLs etc. are inlined as base64 in single-file mode too.

## Risks / Trade-offs

- **Over-matching `url()` references**: Some CSS `url()` values point to non-image resources (SVG filters, clip-paths, etc.). These would be treated as images and converted to `./images/` paths. → **Mitigation**: This is already the existing behavior for `background-image` URLs — the converters don't distinguish image vs. non-image `url()` references. The risk is low because most inline `url()` references are images.

- **CSS custom properties with non-URL values**: A custom property like `--icon: url(...)` where the URL is a fragment identifier (e.g., `url(#gradient)`) would be incorrectly treated as an external resource. → **Mitigation**: Fragment-only URLs (starting with `#`) are already skipped by the extension-side code and should be handled by checking for non-absolute URLs. Data URIs are already explicitly skipped.

- **Performance**: `[style*='url(']` selector may match more elements than `[style*='background-image']`. → **Mitigation**: The number of additional elements is typically small, and the processing per element is lightweight (regex substitution).
