## Context

The Website Downloader extension supports 45 locales via i18next with lazy-loaded JSON files in `src/i18n/locales/`. The recent server-mode and panel-unavailability implementations added 35 new i18n keys to `en.json`, but the other 44 locale files were not updated. Some keys (e.g., `filter.serverMode`, `actions.resume`, `actions.pause`) exist in non-English files but contain hardcoded English strings instead of proper translations. Other keys (e.g., the full server-mode status group, panel-unavailability group) are entirely missing from non-English files.

The i18next fallback mechanism displays English when a key is missing, so the extension is functional — but the UX is inconsistent for non-English users, who see a mix of translated and untranslated text.

## Goals / Non-Goals

**Goals:**

- Translate all 35 new i18n keys into all 44 non-English locales
- Ensure existing keys that contain English placeholders (serverMode, insecureServerWarning, resume, pause) are properly translated
- Maintain consistency with each locale's existing translation style and terminology
- Preserve i18next interpolation placeholders (e.g., `{{completed}}`, `{{error}}`) in all translations

**Non-Goals:**

- Adding new i18n keys or new locales
- Changing the i18next configuration or loading mechanism
- Updating Chrome `_locales` files (those only contain 3 manifest-level strings and are already translated)
- Refactoring the key structure or renaming existing keys
- Removing the `featureRequest` section present in some non-English locales but absent from en.json (separate concern)

## Decisions

### Decision 1: Machine translation with human review pattern

All 35 keys × 44 locales = 1,540 string translations. Using machine translation as the base with structured review is the most practical approach.

**Alternatives considered:**

- Professional human translation: Too costly and slow for 1,540 strings
- Community contributions: Unreliable timeline, inconsistent quality
- English-only fallback: Defeats the purpose of i18n support

**Approach:** Generate translations programmatically, with special attention to:

- Technical terms (CSS, JS, ZIP, HTML) kept as-is across all locales
- Interpolation placeholders preserved exactly (`{{completed}}`, `{{total}}`, etc.)
- RTL languages (ar, he, fa, ur) getting direction-appropriate translations
- Consistent tone matching each locale's existing translations

### Decision 2: Batch translation by language family

Group locales by language family to maintain consistency within related languages and allow efficient batch processing.

**Groups:**

1. **Germanic**: de, nl, af (not present — skip)
2. **Romance**: es, fr, it, pt, pt-BR, ro
3. **Slavic**: bg, cs, hr, pl, ru, sk, sl, sr, uk
4. **Uralic**: et, fi, hu
5. **Baltic**: lt, lv
6. **Nordic**: da, no, sv
7. **Semitic (RTL)**: ar, he
8. **Iranian (RTL)**: fa
9. **Indic**: bn, hi, ta, ur
10. **Sinosphere**: zh-CN, zh-TW, ja, ko
11. **Southeast Asian**: id, ms, fil, th, vi
12. **Other**: el, tr, sw, ko

### Decision 3: Add missing keys rather than restructure

New keys will be added to each locale file in the same structure as en.json, preserving the existing key order. Keys currently containing English text will be replaced with proper translations.

## Risks / Trade-offs

- **[Translation accuracy]** → Machine translations may have minor inaccuracies or unnatural phrasing. Mitigation: follow each locale's existing translation patterns and terminology; technical UI strings are short and formulaic, reducing ambiguity.
- **[Interpolation placeholder corruption]** → A corrupted placeholder (e.g., `{{completed}}` → `{completed}}`) would break the UI at runtime. Mitigation: strict validation that all placeholders match en.json exactly.
- **[RTL rendering]** → Arabic, Hebrew, Farsi, Urdu strings may render incorrectly if the i18next interpolation placeholders interact with bidirectional text. Mitigation: ensure RTL locale strings follow the same placeholder pattern; the existing RTL support in the app handles direction.
- **[Stale translations over time]** → New features will continue adding English-only keys. Mitigation: this is an inherent i18n maintenance concern; the localization spec's fallback-to-English behavior prevents breakage.
