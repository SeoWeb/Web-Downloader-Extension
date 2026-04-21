# Localization Specification

## Purpose

Internationalization (i18n), locale management, and right-to-left (RTL) layout support for the Website Downloader extension. Covers how the extension supports 45 locales with lazy loading and dual context initialization (browser vs service worker).

## Requirements

### Requirement: Multi-Language Support

The system SHALL support 45 locales across multiple regions.

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

### Requirement: Language Detection and Persistence

The system SHALL detect the user's preferred language and persist the selection.

#### Scenario: First-time language detection

- GIVEN the user has not previously selected a language
- WHEN the extension loads
- THEN the language is detected from Chrome storage first
- AND if not found, the browser navigator language is used
- AND if not found, the HTML tag language attribute is used
- AND the detected language is cached in memory and stored in Chrome storage

#### Scenario: Previously selected language

- GIVEN the user has previously selected a language
- WHEN the extension loads
- THEN the cached language from Chrome storage is used
- AND the i18n instance is updated if it was initialized with a different language

#### Scenario: Language change persistence

- GIVEN the user changes the language
- WHEN the new language is applied
- THEN the selection is cached in memory
- AND the selection is persisted to Chrome storage
- AND the document direction is updated

### Requirement: Lazy Locale Loading

The system SHALL load locale files on demand rather than bundling all translations upfront.

#### Scenario: Loading a locale on demand

- GIVEN the user switches to a new language
- WHEN the locale file is needed
- THEN the locale JSON file is fetched from the extension's locale directory
- AND the translations are applied without requiring a page reload

#### Scenario: Locale file not found

- GIVEN a locale code that does not have a corresponding file
- WHEN the locale is requested
- THEN the fallback language (English) is used

### Requirement: Dual Context Initialization

The system SHALL initialize i18n differently for browser contexts (side panel) and service worker contexts (background).

#### Scenario: Browser context initialization

- GIVEN the extension is running in a browser context (side panel)
- WHEN i18n is initialized
- THEN the lazy locale backend is used for on-demand loading
- AND the browser language detector is used (Chrome storage, navigator, HTML tag)
- AND React integration is enabled
- AND the document direction is applied when the language changes

#### Scenario: Service worker context initialization

- GIVEN the extension is running in a service worker context (background)
- WHEN i18n is initialized
- THEN the service worker backend is used (no browser APIs)
- AND a simplified language detector is used (Chrome storage only, fallback to English)
- AND React integration is not needed

### Requirement: RTL Layout Support

The system SHALL automatically apply right-to-left layout for RTL languages.

#### Scenario: RTL language detection

- GIVEN a language code of "ar", "he", "fa", or "ur"
- WHEN the RTL check is performed
- THEN the language is identified as RTL

#### Scenario: Non-RTL language

- GIVEN a language code not in the RTL list (e.g., "en", "es", "zh-CN")
- WHEN the RTL check is performed
- THEN the language is identified as LTR

#### Scenario: Document direction application

- GIVEN a language change to an RTL language
- WHEN the direction is applied
- THEN the document's `dir` attribute is set to "rtl"
- AND the document's `lang` attribute is set to the language code

#### Scenario: Document direction reversal

- GIVEN a language change from RTL to LTR
- WHEN the direction is applied
- THEN the document's `dir` attribute is set to "ltr"
- AND the document's `lang` attribute is updated

#### Scenario: Direction in service worker context

- GIVEN the extension is running in a service worker context
- WHEN a language change occurs
- THEN no document direction is applied (document is not available)
- AND the operation is silently skipped

### Requirement: Language Switcher Component

The system SHALL provide a language switcher component in the UI.

#### Scenario: Displaying available languages

- GIVEN the side panel is open
- WHEN the language switcher is displayed
- THEN all supported languages are listed with their native names
- AND the current language is highlighted

#### Scenario: Switching languages

- GIVEN the user selects a different language from the switcher
- WHEN the selection is made
- THEN the i18n language is changed
- AND all UI text is updated to the new language
- AND the document direction is adjusted if needed

### Requirement: Chrome \_locales Integration

The system SHALL provide Chrome \_locales files for extension-level localization.

#### Scenario: Extension name localization

- GIVEN the Chrome extension management page
- WHEN the extension name and description are displayed
- THEN the localized name and description from `_locales/<lang>/messages.json` are used
- AND the fallback is the default locale (en)

#### Scenario: Supported \_locales

- GIVEN the extension's \_locales directory
- WHEN the available locales are enumerated
- THEN a \_locales directory exists for each supported language code
