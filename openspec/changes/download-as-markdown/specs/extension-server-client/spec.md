## ADDED Requirements

### Requirement: Markdown option in session creation

The extension's server client SHALL include `downloadContentAsMarkdown` in the `SessionOptions` it sends to `POST /api/v1/sessions`, carrying the user's filter-panel choice. The value SHALL default to `false` and the field SHALL be sent on every session creation (the server stores it in the session options blob). The extension SHALL NOT perform any HTML→Markdown conversion itself.

#### Scenario: Flag forwarded on session creation

- **WHEN** the user starts a download with "Download content as Markdown" enabled
- **THEN** `createSession` is called with `downloadContentAsMarkdown: true` in the options

#### Scenario: Default omitted value

- **WHEN** the user starts a download with the option disabled
- **THEN** `createSession` sends `downloadContentAsMarkdown: false`

#### Scenario: No client-side conversion

- **WHEN** the markdown option is enabled
- **THEN** the extension uploads only the HTML/text it already uploads today (no markdown artifact is generated in the extension)
