## ADDED Requirements

### Requirement: Markdown export option gating

The server SHALL accept a `downloadContentAsMarkdown` boolean in session options, defaulting to `false`. Markdown export SHALL be produced only when the option is `true` on a multi-file (ZIP) session. The option SHALL be independent of `downloadContentAsText` (either, both, or neither may be set). In single-file mode the option SHALL be ignored (no markdown embedded). The cloud push branch SHALL ignore the option in v1.

#### Scenario: Option defaults to off

- **WHEN** a session is created without `downloadContentAsMarkdown`
- **THEN** assembly produces no `content.md` and no `pages/*.md`

#### Scenario: Independent of text option

- **WHEN** a session is created with both `downloadContentAsMarkdown` and `downloadContentAsText`
- **THEN** the ZIP contains both `content.md` and `content.txt` with independent content

#### Scenario: Ignored in single-file mode

- **WHEN** a session has both `singleFile` and `downloadContentAsMarkdown`
- **THEN** the single-file output is unchanged (no markdown block embedded)

### Requirement: Markdown conversion timing and URL fidelity

The server SHALL convert the session's merged HTML to Markdown **after** HTML merge and **before** Phase-2 URL rewriting, so that markdown links and images reference **original absolute URLs**. Relative URLs in the source HTML SHALL be resolved against the page's original URL before conversion. The main page's original URL SHALL be taken from the session record; each linked page's from its stored page URL.

#### Scenario: Original URLs preserved

- **WHEN** the merged HTML contains `<a href="/about">` on a page originally at `https://example.com/docs`
- **THEN** the markdown contains `[...](https://example.com/about)`, not an archive-relative or rewritten path

#### Scenario: Conversion runs on merged HTML

- **WHEN** lazy-loaded content arrives in scroll chunks after the initial HTML
- **THEN** the converted markdown includes that content (conversion input is the merged document)

### Requirement: Non-content elements stripped before conversion

The converter SHALL remove `script`, `style`, `noscript`, `template`, and `svg` elements before HTML→Markdown conversion, matching the non-content rule used for text extraction.

#### Scenario: No script leakage

- **WHEN** the page HTML contains an inline `<script>` or `<style>`
- **THEN** their contents appear nowhere in the produced markdown

### Requirement: Main page markdown in the ZIP root

When the option is enabled on a ZIP session, the assembler SHALL write the main page's markdown as `content.md` in the ZIP root, alongside `index.html`.

#### Scenario: Content markdown present

- **WHEN** a ZIP session with `downloadContentAsMarkdown` assembles successfully
- **THEN** the ZIP contains `content.md` with the main page's markdown

#### Scenario: Linked pages excluded from main markdown

- **WHEN** linked-pages scraping is enabled
- **THEN** `content.md` contains only the main page's markdown (linked pages get their own files)

### Requirement: Linked page markdown files

When the option is enabled and linked-pages scraping is enabled, the assembler SHALL write one `pages/<hash>.md` for every `pages/<hash>.html`, using the same hash/filename mapping. Each markdown file SHALL begin with a source stamp identifying the page's original URL.

#### Scenario: Per-page markdown files

- **WHEN** a ZIP session with linked pages and the markdown option assembles
- **THEN** for each `pages/<hash>.html` in the ZIP there is a corresponding `pages/<hash>.md`

#### Scenario: Source stamp

- **WHEN** a linked page originally at `https://example.com/pricing` is saved as `pages/ab12cd34.html`
- **THEN** `pages/ab12cd34.md` begins with a stamp containing `https://example.com/pricing`

### Requirement: Conversion failure isolation

Markdown conversion failure SHALL NOT fail ZIP assembly. If conversion raises an error for any page, the assembler SHALL log the failure and continue producing the archive without the affected markdown file(s); `index.html` and all other outputs SHALL be unaffected.

#### Scenario: Converter error does not break the download

- **WHEN** markdown conversion throws for one linked page
- **THEN** assembly completes successfully
- **AND** the ZIP omits that page's `pages/<hash>.md` but still contains its `pages/<hash>.html` and `content.md` (if the main page converted)
