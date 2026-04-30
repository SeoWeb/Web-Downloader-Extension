## Why

The extension always prompts "Save As" when downloading a ZIP file, overriding Chrome's native download behavior. Users who have disabled Chrome's "Ask where to save each file before downloading" setting expect automatic downloads. There is currently no way to control this within the extension.

## What Changes

- Add a new `alwaysAskWhereToSave` option (boolean, default `true`) to the existing `FilterOptions` settings
- Add a toggle checkbox in the Configuration section of the Filter UI
- Thread the setting through all download paths (local mode, server mode) so `saveAs` respects the user's preference
- Multi-part downloads remain unchanged (`saveAs: false` for individual parts)

## Capabilities

### New Capabilities
- `save-as-preference`: Controls whether the "Save As" dialog is shown when downloading, giving users the choice between always being prompted or automatic downloads

### Modified Capabilities
- `user-interface`: New checkbox added to the Configuration section of the Filter component
- `download-engine`: `initiateDownload()` and server download functions accept and use the `saveAs` preference

## Impact

- **Types**: `FilterOptions` interface gains a new optional field
- **Background scripts**: `download-utils.ts`, `download-core.ts`, `server-download.ts` — parameter threading
- **UI**: `Filter.tsx` — one new checkbox; `sidepanel.tsx` — `Options` interface + server download button
- **Hooks**: `useFilterOptions.ts` — convenience setter and download options passthrough
- **i18n**: New translation key in all ~45 locale files
- **Storage**: No migration needed — existing spread merge with defaults handles the new field automatically
