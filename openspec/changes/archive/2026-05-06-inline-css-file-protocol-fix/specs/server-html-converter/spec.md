## ADDED Requirements

### Requirement: CSS inlining during ZIP assembly
The server SHALL inline CSS content into the main HTML file during ZIP assembly by replacing each `<link rel="stylesheet" href="./styles/...">` element with a `<style>` element containing the CSS file content read from disk.

#### Scenario: Stylesheet inlined into main page HTML
- **WHEN** the ZIP assembler processes a multi-file (non-single-file) session
- **THEN** each `<link rel="stylesheet">` in `index.html` is replaced with a `<style>` tag containing the CSS content
- **AND** the CSS content has `url()` paths adjusted from `../images/` to `./images/` (and similarly for `../fonts/`)
- **AND** CSS files are resolved via the `local_path_to_storage` mapping to handle UUID-based storage

#### Scenario: Stylesheet inlined into linked page HTML
- **WHEN** the ZIP assembler processes linked pages in `pages/` directory
- **THEN** each `<link rel="stylesheet">` in the linked page is replaced with a `<style>` tag containing the CSS content
- **AND** the CSS content preserves `../images/` paths (since linked pages are in `pages/` subdirectory)

### Requirement: CSS files still included in ZIP
The server SHALL continue writing CSS files to the `styles/` directory in the ZIP, even after inlining them into HTML, for completeness and fallback purposes.

#### Scenario: CSS files present in ZIP alongside inline styles
- **WHEN** ZIP assembly completes for a multi-file session
- **THEN** the ZIP contains both inline `<style>` tags in `index.html` AND the original CSS files in `styles/` directory

### Requirement: Missing CSS files handled gracefully
When a CSS file referenced by a `<link>` tag cannot be found on disk, the inlining function SHALL leave the `<link>` tag unchanged and log a warning.

#### Scenario: Referenced CSS file missing from storage
- **WHEN** a `<link rel="stylesheet" href="./styles/missing.css">` references a file that does not exist on disk
- **THEN** the `<link>` tag is preserved in the HTML as-is
- **AND** a warning is logged
