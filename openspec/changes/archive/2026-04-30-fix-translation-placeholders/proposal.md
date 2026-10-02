## Why

Two categories of incomplete translations exist across all 44 non-English locale files: (1) `filter.alwaysAskWhereToSave` was added with English placeholder text instead of translations, and (2) 9 download-interruption keys in the `status` section are missing entirely from every non-English file. Both violate the existing localization spec's completeness and non-English-value requirements.

## What Changes

- Translate `filter.alwaysAskWhereToSave` ("Always ask where to save file") in all 44 non-English locale files
- Add 9 missing `status.*` keys with proper translations to all 44 non-English locale files:
  - `downloadInterruptedTitle`, `downloadInterruptedMessage`, `restartDownload`, `dismissInterrupt`, `downloadInterrupted`
  - `interruptedPhase.scraping`, `interruptedPhase.uploading`, `interruptedPhase.assembling`, `interruptedPhase.packing`

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `localization`: extends the translation completeness requirement to cover the new `filter.alwaysAskWhereToSave` key and the missing download-interruption status keys

## Impact

- All 44 non-English JSON files under `src/i18n/locales/`
- No code changes — only translation string updates
- No API or dependency changes
