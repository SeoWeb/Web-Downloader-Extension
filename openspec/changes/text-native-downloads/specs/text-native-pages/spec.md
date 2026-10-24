## ADDED Requirements

### Requirement: Format selection determines artifacts

The system SHALL honor the download format selector end to end. When only text formats are selected (markdown and/or content-as-text, with HTML off), no HTML file SHALL appear in the delivered artifact and no HTML page SHALL be stored in the cloud. When HTML is selected together with text formats, the HTML artifact remains primary and the text files accompany it locally and in the cloud. The scraped HTML SHALL always remain the internal conversion input regardless of selection.

#### Scenario: Markdown-only download

- **WHEN** the user downloads a page with markdown selected and HTML deselected
- **THEN** the delivered artifact is the markdown document alone, with no `index.html` inside

#### Scenario: Text-only cloud save

- **WHEN** a PagePocket-mode download completes with only a text format selected
- **THEN** the cloud page stores the text document and no `index.html`

#### Scenario: HTML plus text

- **WHEN** HTML and markdown are both selected
- **THEN** the local bundle contains both and the cloud page stores both formats with HTML as default

### Requirement: Single-file outputs are not zipped

When the assembled artifact consists of exactly one top-level file, the system SHALL deliver that file raw with its natural extension and MIME type instead of a zip. Artifacts with more than one top-level file SHALL be zipped as before.

#### Scenario: Lone markdown file

- **WHEN** a single-page markdown-only download produces one `.md` file
- **THEN** the browser receives `name.md` directly, not `name.zip`

#### Scenario: Multi-file still zipped

- **WHEN** an artifact contains two or more top-level files (e.g. markdown for main + linked pages)
- **THEN** the artifact is delivered as a zip

### Requirement: Inapplicable toggles ignored in text-only modes

When only text formats are selected, the images, assets, documents, and single-file options SHALL have no effect on the artifact, and the options UI SHALL disable them with a visible hint so the state is not silently ignored.

#### Scenario: Toggles disabled

- **WHEN** the user deselects HTML leaving only markdown
- **THEN** the images/assets/documents/single-file controls become disabled with a hint and do not affect the download

### Requirement: Multi-format page storage and viewer switching

A stored cloud page SHALL record its available content formats (`html`, `markdown`, `text`). The page viewer and public share viewer SHALL offer a format switcher when more than one format exists, defaulting to HTML when present. Markdown SHALL render formatted with embedded raw HTML escaped, plus a raw-source toggle; text SHALL display as plain text. Pages with a single format SHALL display it directly without a switcher.

#### Scenario: Toggle between formats

- **WHEN** a page stores html + markdown + text
- **THEN** the viewer defaults to the HTML view and can switch to rendered markdown (with raw toggle) and plain text

#### Scenario: Text-only page view

- **WHEN** a page stores only markdown
- **THEN** the viewer renders the markdown directly with a raw-source toggle and no HTML tab

#### Scenario: Legacy page unchanged

- **WHEN** a previously stored HTML-only page is opened
- **THEN** it renders exactly as before with no switcher

### Requirement: Backward compatibility of wire and storage

All schema changes SHALL be additive. Pages stored before this change SHALL keep rendering and exporting as HTML. A pusher that does not send text content and a backend that does not understand text content SHALL both continue to function with graceful degradation.

#### Scenario: Old page opens

- **WHEN** a pre-change HTML page is fetched
- **THEN** its detail response reports `html` as its format and it renders as before

#### Scenario: Old pusher to new backend

- **WHEN** a monolith without text support pushes a normal HTML page
- **THEN** ingest succeeds exactly as before
