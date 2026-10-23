## ADDED Requirements

### Requirement: Download content as Markdown option

The configuration UI SHALL offer a "Download content as Markdown" checkbox that controls the `downloadContentAsMarkdown` download option. The option SHALL be independent of "Download content as text" (enabling one SHALL NOT enable or disable the other) and SHALL count as a content selection on its own (satisfying the "nothing selected" guard). When single-file mode is enabled, the option SHALL be disabled and stored as `false`, consistent with the other granular options. The choice SHALL persist across panel restarts like other filter options.

#### Scenario: Checkbox toggles markdown export

- **WHEN** the user checks "Download content as Markdown" and starts a server-mode download
- **THEN** the created session carries `downloadContentAsMarkdown: true`

#### Scenario: Independent from text option

- **WHEN** the user enables "Download content as Markdown" while "Download content as text" is on
- **THEN** both options remain enabled

#### Scenario: Counts as a content selection

- **WHEN** "Download content as Markdown" is the only enabled option
- **THEN** the download is allowed (the nothing-selected validation passes)

#### Scenario: Disabled under single-file mode

- **WHEN** the user enables single-file mode
- **THEN** the markdown checkbox is disabled and cleared, like the other granular options

#### Scenario: Localized label

- **WHEN** the panel renders the options list in any supported locale
- **THEN** the checkbox label is shown translated (no raw i18n keys), with all locales backfilled from English until translated
