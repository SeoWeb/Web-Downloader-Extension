## ADDED Requirements

### Requirement: Viewer format switcher

The page viewer SHALL fetch `content_formats` with the page detail data and render a format switcher (HTML | Markdown | Text) whenever more than one format exists; HTML SHALL be the default tab when present. The HTML view SHALL remain the existing sandboxed iframe. The markdown view SHALL render the document with raw HTML escaped and offer a raw-source toggle; the text view SHALL display plain text. The public share viewer SHALL offer the same switching.

#### Scenario: Switching on a multi-format page

- **WHEN** a page with html + markdown + text is opened in the dashboard
- **THEN** the viewer shows the HTML tab by default and the user can switch to rendered markdown (with raw toggle) or plain text

#### Scenario: Markdown rendered safely

- **WHEN** a stored markdown document contains an embedded `<script>` tag
- **THEN** the rendered view does not execute or inject it, and the raw toggle shows the original source

#### Scenario: Share viewer parity

- **WHEN** a multi-format page is opened via a public share link
- **THEN** the share viewer offers the same format switcher with the same defaults

#### Scenario: Legacy page renders bare

- **WHEN** a page reports only the `html` format
- **THEN** no switcher renders and the iframe view appears exactly as today
