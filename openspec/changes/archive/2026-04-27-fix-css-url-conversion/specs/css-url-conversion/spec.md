## ADDED Requirements

### Requirement: General CSS url() Conversion

The system SHALL convert all `url()` references in inline styles and `<style>` tags to local paths, regardless of which CSS property contains the URL reference. This includes but is not limited to: `background-image`, `background` (shorthand), CSS custom properties (`--*`), `list-style-image`, `content`, `mask-image`, `border-image`, `cursor`, and any other CSS property that accepts a `url()` value.

#### Scenario: CSS custom property url() conversion

- **WHEN** an HTML element has an inline style containing `--image-url: url(https://example.com/photo.jpg)`
- **THEN** the URL inside `url()` is converted to a local path using the filename map or generated filename

#### Scenario: Shorthand background url() conversion

- **WHEN** an HTML element has an inline style containing `background: url(https://example.com/bg.jpg)`
- **THEN** the URL inside `url()` is converted to a local path using the filename map or generated filename

#### Scenario: list-style-image url() conversion

- **WHEN** an HTML element has an inline style containing `list-style-image: url(https://example.com/bullet.png)`
- **THEN** the URL inside `url()` is converted to a local path using the filename map or generated filename

#### Scenario: CSS custom property url() in style tag

- **WHEN** a `<style>` tag contains `--hero-image: url(https://example.com/hero.jpg)`
- **THEN** the URL inside `url()` is converted to a local path using the filename map or generated filename

#### Scenario: Data URI preserved

- **WHEN** a CSS property contains `url(data:image/png;base64,...)`
- **THEN** the data URI is left unchanged

#### Scenario: Fragment URL preserved

- **WHEN** a CSS property contains `url(#gradient)` (fragment-only reference)
- **THEN** the fragment URL is left unchanged

#### Scenario: Multiple url() references in same style

- **WHEN** an HTML element has an inline style containing multiple `url()` references in different properties (e.g., `background: url(...); --icon: url(...)`)
- **THEN** each `url()` reference is independently converted to a local path
