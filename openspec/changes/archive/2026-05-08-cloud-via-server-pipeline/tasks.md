## 1. Server: Accept PagePocket user ID in session creation

- [x] 1.1 Add `pagepocketUserId: str | None = None` to `SessionOptions` Pydantic model in `server/app/api/routes/sessions.py`
- [x] 1.2 In `create_session`, prefer `opts.pagepocketUserId` over `client.pagepocket_user_id` when setting `session.pagepocket_user_id`
- [x] 1.3 Store `pagepocketUserId` in `session.options` dict for reference during assembly

## 2. Server: Add cloud-only assembly branch in zip_assembler

- [x] 2.1 Add `_assemble_cloud_push()` method to `ZipAssemblerService` that: encodes processed `main_html` as UTF-8, builds asset list via `_build_cloud_assets()`, appends linked page HTMLs as `pages/`-prefixed assets, calls `push_to_archive()`, updates session cloud fields
- [x] 2.2 In `assemble_session()`, add a conditional branch after Phase 3 (CSS conversion, ~line 276): if `session.pagepocket_user_id` is set, call `_assemble_cloud_push()` instead of `_assemble_zip()` or `_assemble_single_file()`
- [x] 2.3 Handle single-file cloud mode: when `singleFile=true` + cloud, run `_assemble_single_file()`, read the resulting HTML from disk, push with no assets, delete local file
- [x] 2.4 Remove the old cloud push block at lines 312-354 (which ran after ZIP creation and had the bug of reading ZIP bytes as HTML)

## 3. Extension: Add cloud fields to server-client types

- [x] 3.1 Add `pagepocketUserId?: string` to `SessionOptions` interface in `src/background/server-client.ts`
- [x] 3.2 Add `cloud_status?: string | null`, `cloud_page_id?: string | null`, `cloud_error?: string | null` to `SessionStatusResponse` interface
- [x] 3.3 In `createSession()`, include `pagepocketUserId` in the `options` body when provided

## 4. Extension: Route cloud mode through server pipeline

- [x] 4.1 In `download-core.ts`, modify `downloadResources()`: read PagePocket auth state to get user ID when cloud is enabled, pass it as `pagepocketUserId` to `serverClient.createSession()`
- [x] 4.2 Remove the `shouldUseCloudUpload()` early-return branch that called `executeDownloadCloudMode`
- [x] 4.3 Remove `executeDownloadCloudMode()` function entirely
- [x] 4.4 Remove `shouldUseCloudUpload()` function (or simplify to just return the user ID)

## 5. Extension: Handle cloud completion in server-download handler

- [x] 5.1 Add `cloudPageId?: string` and `cloudError?: string` to `ServerDownloadResult` interface in `src/background/server-download.ts`
- [x] 5.2 In `pollAssemblyStatus` or `downloadWithFallback`: when session status is `ready` and `cloud_page_id` is set, return result with `cloudPageId` instead of triggering `chrome.downloads.download`
- [x] 5.3 In `executeDownloadServerMode()` in `download-core.ts`: after `downloadWithFallback` returns, check `downloadResult.cloudPageId` and send `status.pagepocketUploadComplete` + `status.complete` instead of the normal download flow

## 6. Cleanup

- [x] 6.1 Remove `BlobCollector` import from `download-core.ts` and delete `src/background/storage/blob-collector.ts`
- [x] 6.2 Remove unused imports from `download-core.ts`: `pagepocketClient`, `PagePocketAuthError`, `PagePocketQuotaError`
- [x] 6.3 Verify `BlobCollector` is not imported anywhere else before deleting

## 7. Verification

- [x] 7.1 Test cloud OFF: session created without `pagepocketUserId`, ZIP assembly works as before, extension triggers download
- [x] 7.2 Test cloud ON: session created with `pagepocketUserId`, server pushes to PagePocket, extension shows cloud page link
- [x] 7.3 Test cloud ON push failure: server sets `cloud_status=failed`, extension shows error
- [x] 7.4 Test cloud ON single-file: server assembles single-file HTML, pushes without assets, local file cleaned up
