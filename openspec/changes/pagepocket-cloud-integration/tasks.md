## 1. Backend — Ingest REST Endpoint

- [ ] 1.1 Add `POST /api/v1/archive/pages/ingest` to `pagepocket/services/api-gateway/routers/archive.py` — accept `multipart/form-data` with `url`, `title`, `html_content` (file), `extension_job_id`, `plan`, and `assets` (list of files); construct `IngestPageRequest` protobuf; call `archive_stub().IngestPage()`; return `{ success, page_id, message, api_version }`
- [ ] 1.2 Test the ingest endpoint manually with `curl` (register, get JWT, upload a page with assets)

## 2. Extension — Types and Feature Flag

- [ ] 2.1 Create `src/types/authTypes.ts` — define `PagePocketAuthState` interface and storage key constants (`pagepocket_auth`, `pagepocket_cloud_enabled`)
- [ ] 2.2 Create `src/common/pagepocket-mode.ts` — export `PAGEPOCKET_URL` from `VITE_PAGEPOCKET_URL` env var and `IS_PAGEPOCKET_AVAILABLE` boolean; add `VITE_PAGEPOCKET_URL` to Vite env type declarations

## 3. Extension — PagePocket HTTP Client

- [ ] 3.1 Create `src/background/pagepocket-client.ts` — implement `PagePocketClient` class with base URL from `VITE_PAGEPOCKET_URL`, error classes (`PagePocketAuthError`, `PagePocketUploadError`, `PagePocketQuotaError`), and singleton export `pagepocketClient`
- [ ] 3.2 Implement auth methods: `register(email, password, name)`, `login(email, password)`, `refreshToken(token)`, `logout()`
- [ ] 3.3 Implement `authenticatedFetch()` with JWT Bearer header, auto-refresh on 401 with promise-based mutex, token load/save from `chrome.storage.local`
- [ ] 3.4 Implement `ingestPage(params)` — build `FormData` with HTML content and asset files, POST to `/api/v1/archive/pages/ingest` with progress tracking
- [ ] 3.5 Implement `checkHealth()` — GET `/api/v1/health` without auth

## 4. Extension — Zustand Store and Hook

- [ ] 4.1 Create `src/stores/pagepocketStore.ts` — Zustand store with state: `cloudStorageEnabled`, `isAuthenticated`, `authUser`, `isAuthLoading`; actions: `setCloudStorageEnabled()`, `login()`, `register()`, `logout()`, `initializeFromStorage()`; persist to `chrome.storage.local`; subscribe to `chrome.storage.onChanged` for cross-tab sync
- [ ] 4.2 Create `src/hooks/usePagePocket.ts` — convenience hook that initializes store from storage on mount and returns all state and actions

## 5. Extension — UI Components

- [ ] 5.1 Create `src/components/PagePocketToggle.tsx` — toggle card with cloud icon, label, description; uses Radix Checkbox; shows auth status indicator (connected/login required); only rendered when `IS_PAGEPOCKET_AVAILABLE`
- [ ] 5.2 Create `src/components/PagePocketAuth.tsx` — login/register form with two-tab layout; email, password, name inputs; submit with loading state; error display; uses `usePagePocket` hook for auth actions
- [ ] 5.3 Create `src/components/CloudUploadStatus.tsx` — upload progress indicator with progress bar; success state with page ID and "View in PagePocket" link; error state with retry button; quota-exceeded message

## 6. Extension — Pipeline Integration

- [ ] 6.1 Add message actions to `src/common/message.ts`: `PAGEPOCKET_UPLOAD_START`, `PAGEPOCKET_UPLOAD_PROGRESS`, `PAGEPOCKET_UPLOAD_COMPLETE`, `PAGEPOCKET_UPLOAD_ERROR`
- [ ] 6.2 Modify `src/background/download-core.ts` — add `shouldUseCloudUpload()` function that reads cloud state from chrome.storage; add cloud upload branch in `downloadResources()` after resource processing: gather HTML + assets, call `pagepocketClient.ingestPage()`, send progress messages, skip ZIP generation and `chrome.downloads.download()`
- [ ] 6.3 Modify `src/components/Filter.tsx` — import and render `PagePocketToggle` at the top of the Configuration section, conditionally on `IS_PAGEPOCKET_AVAILABLE`

## 7. Extension — Sidepanel Integration

- [ ] 7.1 Modify `src/sidepanel/components/MainContent.tsx` — accept `showAuthForm` prop; when true, render `PagePocketAuth` instead of `Filter`
- [ ] 7.2 Modify `src/sidepanel.tsx` — import `usePagePocket` hook; add cloud-mode conditional: when `cloudEnabled && !isAuthenticated && !isScraping`, pass `showAuthForm=true` to MainContent; handle PAGEPOCKET_* message actions in `messageWorker`; track cloud upload progress state; pass cloud upload result to DownloadComplete
- [ ] 7.3 Modify `src/sidepanel/components/DownloadComplete.tsx` — accept `cloudUploadResult` prop; when present, show "Saved to PagePocket" badge instead of "Show in Folder"; show "View in PagePocket" link
- [ ] 7.4 Modify `src/sidepanel/components/DownloadStatus.tsx` — accept cloud upload state props; show `CloudUploadStatus` component during cloud uploads

## 8. Extension — i18n

- [ ] 8.1 Add translation keys to `src/i18n/locales/en.json` under `filter`: `cloudStorage`, `cloudStorageDescription`, `cloudLoginRequired`, `cloudEmail`, `cloudPassword`, `cloudName`, `cloudLogin`, `cloudRegister`, `cloudLogout`, `cloudLoggedInAs`, `cloudNoAccount`, `cloudHasAccount`, `cloudAuthError`
- [ ] 8.2 Add translation keys under `status`: `pagepocketUploading`, `pagepocketUploadProgress`, `pagepocketUploadComplete`, `pagepocketUploadError`, `pagepocketUploadRetry`, `pagepocketViewPage`
