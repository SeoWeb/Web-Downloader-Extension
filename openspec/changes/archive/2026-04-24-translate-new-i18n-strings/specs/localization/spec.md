## MODIFIED Requirements

### Requirement: Multi-Language Support

The system SHALL support 45 locales across multiple regions with complete translations for all UI keys.

#### Scenario: Available languages

- GIVEN the extension's language catalog
- WHEN the supported languages are enumerated
- THEN the following regions are represented: Europe (25 languages), Asia (14 languages), Middle East (3 languages), Americas (1 language), Southeast Asia (1 language), Africa (1 language)

#### Scenario: Language metadata

- GIVEN a language entry in the catalog
- WHEN the metadata is inspected
- THEN the entry includes: language code, English name, native name, RTL flag, and region

#### Scenario: Fallback language

- GIVEN a language that does not have a complete translation
- WHEN a translation key is missing in the current locale
- THEN the English translation is used as the fallback

#### Scenario: Server-mode keys available in all locales

- GIVEN any of the 44 non-English locale files
- WHEN the following keys are looked up in the `status` section
- THEN each key SHALL exist with a properly translated value (not English text):
  - `uploadProgress`, `uploadingResources`, `sendingScrapeComplete`, `scrapeComplete`
  - `waitingForUploads`, `finalizingServer`, `assemblingServer`, `assemblyProgress`
  - `assemblyPhaseMerging`, `assemblyPhaseConverting`, `assemblyPhaseZipping`, `assemblyPhaseInlining`
  - `serverFallbackOffer`, `serverError`, `serverUnavailable`
  - `assemblyTimeout`, `assemblyFailed`, `authFailed`
  - `retryServer`, `downloadLocally`, `localFallbackWarning`
  - `downloadFromServer`, `serverDownloadUrl`, `copyUrl`, `urlCopied`
  - `serverSessionFailed`, `memoryWarningServerMode`, `serverModeActive`

#### Scenario: Panel-unavailability keys available in all locales

- GIVEN any of the 44 non-English locale files
- WHEN the following keys are looked up in the `app` section
- THEN each key SHALL exist with a properly translated value:
  - `panelUnavailable`, `panelUnavailableTitle`, `panelUnavailableTip`

#### Scenario: Filter and action keys properly translated

- GIVEN any of the 44 non-English locale files
- WHEN the following keys are looked up
- THEN each key SHALL exist with a properly translated value (not English text):
  - `filter.serverMode`, `filter.insecureServerWarning`
  - `actions.resume`, `actions.pause`

#### Scenario: Interpolation placeholders preserved

- GIVEN any translated key that contains i18next interpolation placeholders in the English source
- WHEN the translated value is inspected
- THEN all interpolation placeholders (e.g., `{{completed}}`, `{{total}}`, `{{error}}`, `{{part}}`, `{{reason}}`, `{{phase}}`, `{{progressPct}}`, `{{availableMB}}`, `{{count}}`, `{{current}}`, `{{succeeded}}`, `{{failed}}`, `{{skipped}}`, `{{streamed}}`, `{{percent}}`) SHALL be present in the translated value with identical syntax

#### Scenario: RTL locale translation format

- GIVEN an RTL locale file (ar, he, fa, ur)
- WHEN the translated values are inspected
- THEN the translations SHALL be written in the natural RTL language
- AND interpolation placeholders SHALL follow the same `{{key}}` syntax without bidirectional text disruption

## ADDED Requirements

### Requirement: Translation Completeness Validation

The system SHALL ensure all non-English locale files contain translations for every key present in the English locale.

#### Scenario: Missing key detection

- GIVEN the English locale file as the reference
- WHEN a non-English locale file is compared against it
- THEN every key in the English file SHALL have a corresponding key in the non-English file
- AND the value SHALL NOT be the same as the English value (indicating an untranslated string)
