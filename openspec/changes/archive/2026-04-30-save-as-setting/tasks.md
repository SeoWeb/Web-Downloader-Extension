## 1. Type Definition and Defaults

- [x] 1.1 Add `alwaysAskWhereToSave?: boolean` to `FilterOptions` interface in `src/types/filterTypes.ts`
- [x] 1.2 Add `alwaysAskWhereToSave: true` to `DEFAULT_FILTER_OPTIONS` in `src/types/filterTypes.ts`

## 2. Hook and Store Wiring

- [x] 2.1 Add `setAlwaysAskWhereToSave` convenience setter to `useFilterOptions()` in `src/hooks/useFilterOptions.ts`
- [x] 2.2 Add `alwaysAskWhereToSave` to `useDownloadOptions()` return in `src/hooks/useFilterOptions.ts`

## 3. Download Pipeline (Background)

- [x] 3.1 Add `saveAs: boolean = true` parameter to `initiateDownload()` in `src/background/download-utils.ts`, pass to `downloadViaPanel()` instead of hardcoded `true`
- [x] 3.2 Pass `downloadOptions.alwaysAskWhereToSave ?? true` to `initiateDownload()` call in `src/background/download-core.ts` (line ~628)
- [x] 3.3 Add `saveAs` parameter to `triggerServerDownload()`, `waitForDownload()`, and `downloadWithFallback()` in `src/background/server-download.ts`, thread through the chain
- [x] 3.4 Pass `downloadOptions.alwaysAskWhereToSave ?? true` to `handler.downloadWithFallback()` call in `src/background/download-core.ts` (line ~918)

## 4. Side Panel

- [x] 4.1 Add `alwaysAskWhereToSave?: boolean` to `Options` interface in `src/sidepanel.tsx`
- [x] 4.2 Update `onDownloadFromServer` callback to read `alwaysAskWhereToSave` from filter options storage instead of hardcoding `saveAs: true`

## 5. Filter UI

- [x] 5.1 Add `setAlwaysAskWhereToSave` to destructured hook return in `src/components/Filter.tsx`
- [x] 5.2 Add "Always ask where to save file" checkbox using `OptionItem` in the Configuration section, after mode selection cards and before granular content-type options

## 6. Localization

- [x] 6.1 Add `filter.alwaysAskWhereToSave` key to `src/i18n/locales/en.json`
- [x] 6.2 Add placeholder key to all other locale files (~45 files)
