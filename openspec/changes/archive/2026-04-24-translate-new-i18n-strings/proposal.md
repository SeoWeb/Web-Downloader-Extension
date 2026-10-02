## Why

Recent server-mode and panel-unavailability features added 35+ new i18n keys to the English locale (`src/i18n/locales/en.json`), but these strings remain untranslated across all 44 non-English locales. Users who switch to any non-English language see raw English text for server-mode status messages, server error/fallback UI, panel-unavailability warnings, and filter actions like resume/pause. This creates a poor localized experience for the majority of the extension's supported languages.

## What Changes

- Add translations for 35 new i18n keys across all 44 non-English locale files in `src/i18n/locales/`
- New key groups requiring translation:
  - **app.panelUnavailable** (3 keys): panel unavailability warning, title, and tip
  - **filter.serverMode / insecureServerWarning** (2 keys): server mode toggle and HTTPS warning — currently hardcoded English in locale files
  - **actions.resume / pause** (2 keys): action buttons — currently hardcoded English in locale files
  - **status.server-mode keys** (28 keys): upload progress, server assembly phases, server error/fallback states, download-from-server UI, copy URL, session failure, memory warnings, and server-mode active indicator

## Capabilities

### New Capabilities

_None_

### Modified Capabilities

- `localization`: Extending the localization spec to cover the new server-mode and panel-unavailability i18n keys across all 44 non-English locales

## Impact

- **Files**: All 44 non-English JSON files in `src/i18n/locales/` (ar, bg, bn, cs, da, de, el, es, et, fa, fi, fil, fr, he, hi, hr, hu, id, it, ja, ko, lt, lv, ms, nl, no, pl, pt, pt-BR, ro, ru, sk, sl, sr, sv, sw, ta, th, tr, uk, ur, vi, zh-CN, zh-TW)
- **No code changes**: Only JSON translation files are affected
- **No API or dependency changes**
- **RTL languages** (ar, he, fa, ur): Translations must be verified for correct RTL rendering context
