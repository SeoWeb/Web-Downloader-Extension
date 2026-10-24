## ADDED Requirements

### Requirement: Format options propagate in session options

The extension SHALL include `downloadHtml` and `downloadContentAsText` in the session-create options payload, matching the camelCase convention of existing options, so the server can honor the full format selection.

#### Scenario: Session create carries flags

- **WHEN** the user starts a download with HTML deselected and content-as-text selected
- **THEN** the `POST /sessions` body contains `downloadHtml: false` and `downloadContentAsText: true`

### Requirement: Inapplicable toggles disabled in the UI

When only text formats are selected (HTML off), the extension options UI SHALL disable the images, assets, documents, and single-file controls and show a short hint that they do not apply to text-only downloads.

#### Scenario: Text-only UI state

- **WHEN** the user unchecks HTML leaving only markdown
- **THEN** the inapplicable toggles render disabled with a hint and their values are ignored for the download
