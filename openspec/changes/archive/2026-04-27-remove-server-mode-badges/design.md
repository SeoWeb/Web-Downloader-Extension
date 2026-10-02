## Context

The extension conditionally renders "Server mode" badges in two components based on the build-time `IS_SERVER_MODE` flag. These badges display a pill-shaped indicator with a Server icon next to the download button (Filter.tsx) and in the download status header (DownloadStatus.tsx). The HTTP warning badge in Filter.tsx is nested inside the same container as the server mode badge.

## Goals / Non-Goals

**Goals:**
- Remove the server mode badge from Filter.tsx and DownloadStatus.tsx
- Remove the HTTP security warning badge from Filter.tsx (only shown alongside server mode badge)
- Clean up unused imports (`Server`, `ShieldAlert`) and references (`serverModeState`)

**Non-Goals:**
- Removing server mode functionality itself — only the visual badges
- Changing translation files — keys become unused but can stay for now
- Modifying the download pipeline or status steps

## Decisions

- **Remove the entire conditional block in Filter.tsx** (lines ~193-211) rather than just the badge text, since the wrapper div and HTTP warning are both conditional on server mode
- **Remove the conditional span in DownloadStatus.tsx** (lines ~308-313) including the `serverModeState` reference
- Leave translation keys (`filter.serverMode`, `filter.insecureServerWarning`) in place — they don't cause errors if unused and removing them from all locale files is a separate concern

## Risks / Trade-offs

- [Users lose visibility into whether they're running server or local mode] → Acceptable: the mode is a build-time configuration, not a runtime choice. Users know which build they installed.
- [HTTP warning for insecure server URLs disappears] → Acceptable: insecure URLs are a dev-time concern, not something end users configure at runtime.
