## Context

The extension always passes `saveAs: true` to `chrome.downloads.download()`, which forces a "Save As" dialog for every download. This is hardcoded in three places:

1. `src/background/download-utils.ts` — `initiateDownload()` calls `downloadViaPanel(blob, filename, true, tabId)`
2. `src/background/server-download.ts` — `triggerServerDownload()` passes `saveAs: true`
3. `src/sidepanel.tsx` — the "Download from server" button hardcodes `saveAs: true`

The extension already has a complete settings pipeline: `FilterOptions` type → `DEFAULT_FILTER_OPTIONS` → Zustand store → Chrome storage → Filter UI. The `downloadOptions` object already flows through the entire download pipeline from UI to background scripts.

## Goals / Non-Goals

**Goals:**
- Allow users to toggle "Always ask where to save" on/off
- Default to `true` (current behavior) for backward compatibility
- Apply the setting to all download paths (local, server, manual server button)

**Non-Goals:**
- Detecting or respecting Chrome's native "Ask where to save each file" setting — not possible via extension APIs
- Changing multi-part download behavior (always `saveAs: false` for individual parts)

## Decisions

### 1. Add to existing `FilterOptions` rather than a separate setting

The `FilterOptions` / Zustand / Chrome storage pipeline already exists and `downloadOptions` already flows through the entire download chain. Adding a field to `FilterOptions` requires zero plumbing changes. A separate storage key would duplicate boilerplate for no benefit.

**Alternative considered:** Separate storage key — rejected due to unnecessary duplication.

### 2. Field name: `alwaysAskWhereToSave`

Named from the user's perspective (positive-checked). The value maps directly to the `saveAs` Chrome API parameter: `true` = show dialog, `false` = auto-download.

### 3. Placement in UI: Configuration section, after mode selection

The toggle goes in the collapsible "Configuration" section of the Filter component, after the mode selection cards (Full Website / Single File) and before the granular content-type checkboxes. It's a download behavior setting, not a content filter, so it sits at the boundary.

### 4. `initiateDownload()` gains a `saveAs` parameter with default `true`

This preserves backward compatibility for any callers that don't pass it.

## Risks / Trade-offs

- **Users upgrading** won't have the field in storage → mitigated automatically by the spread merge `{ ...DEFAULT_FILTER_OPTIONS, ...storedOptions }` in `filterStorage.ts`
- **Multi-part downloads** must stay `saveAs: false` → already handled; they use `downloadViaPanelAndWait()` directly, not `initiateDownload()`
