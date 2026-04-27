## Why

The extension displays "Server mode" badges in the Filter component and DownloadStatus component. These are visual noise — the mode is a build-time configuration, not actionable information for the user. Removing them simplifies the UI.

## What Changes

- Remove the "Server mode" badge from `Filter.tsx` (lines ~194-201), including the surrounding container div
- Remove the "Server mode" badge from `DownloadStatus.tsx` (lines ~308-313)
- Remove the associated HTTP warning badge in `Filter.tsx` (lines ~207-210) since it only appears alongside the server mode badge

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `user-interface`: Remove server mode badge indicators from Filter and DownloadStatus components

## Impact

- `src/components/Filter.tsx` — remove badge markup and unused imports
- `src/sidepanel/components/DownloadStatus.tsx` — remove badge markup and unused `serverModeState` reference
- Translation keys `filter.serverMode` and `filter.insecureServerWarning` become unused
