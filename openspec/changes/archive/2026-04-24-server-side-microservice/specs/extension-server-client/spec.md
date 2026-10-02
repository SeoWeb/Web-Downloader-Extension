## ADDED Requirements

### Requirement: Server API Client

The extension SHALL provide a `ServerClient` class that encapsulates all HTTP communication with the Python microservice.

#### Scenario: Auto-registration on first use

- **WHEN** the ServerClient is initialized and no API key is stored in `chrome.storage.local`
- **THEN** a POST request is sent to `<serverUrl>/api/v1/auth/register` with a unique client identifier
- **AND** the returned API key is stored in `chrome.storage.local` for future use

#### Scenario: Server health check

- **WHEN** the ServerClient needs to verify server availability
- **THEN** a GET request is sent to `<serverUrl>/api/v1/health` without authentication
- **AND** if the server returns 200, the server is considered available
- **AND** if the request fails or times out, the server is considered unavailable

#### Scenario: Create session

- **WHEN** `createSession(url)` is called with a stored API key
- **THEN** a POST request is sent to `<serverUrl>/api/v1/sessions` with the URL and API key in the `X-API-Key` header
- **AND** the session ID from the response is returned

#### Scenario: Upload HTML chunk

- **WHEN** `uploadHtmlChunk(sessionId, html, scrollIndex)` is called
- **THEN** a POST request is sent to `<serverUrl>/api/v1/sessions/{sessionId}/html` with the HTML content and chunk index
- **AND** the response confirms the chunk was received or deduplicated

#### Scenario: Signal scraping completion

- **WHEN** `scrapeComplete(sessionId, resourceCount)` is called after all HTML chunks have been uploaded
- **THEN** a POST request is sent to `<serverUrl>/api/v1/sessions/{sessionId}/scrape-complete` with `{ resourceCount }` in the body
- **AND** the server stores `resourceCount` as `resources_discovered` for UI progress display ("X/Y resources uploaded")
- **AND** the response confirms the session transitioned to `uploading` status
- **AND** this MUST be called before finalization can succeed

#### Scenario: Upload resource file

- **WHEN** `uploadResource(sessionId, path, blob, originalUrl, contentType)` is called
- **THEN** a multipart POST request is sent to `<serverUrl>/api/v1/sessions/{sessionId}/resources` with the file, path, original URL, and content type
- **AND** if the blob is a text-based MIME type (`text/*`, `application/javascript`, `application/json`, `application/xml`), it is gzip-compressed and the request includes `X-Content-Gzipped: true` header
- **AND** binary resources (images, videos, PDFs, fonts) are uploaded uncompressed
- **AND** the response confirms the resource was stored

#### Scenario: Upload filename map

- **WHEN** `uploadFilenameMap(sessionId, map)` is called with the image filename map
- **THEN** a POST request is sent to `<serverUrl>/api/v1/sessions/{sessionId}/filename-map` with the JSON mapping
- **AND** the response confirms the mapping was stored

#### Scenario: Upload content text

- **WHEN** `uploadContent(sessionId, text)` is called with extracted page text
- **THEN** a POST request is sent to `<serverUrl>/api/v1/sessions/{sessionId}/content` with the plain text content
- **AND** the response confirms the content was stored for `content.txt` inclusion

#### Scenario: Finalize session

- **WHEN** `finalizeSession(sessionId)` is called
- **THEN** a POST request is sent to `<serverUrl>/api/v1/sessions/{sessionId}/finalize`
- **AND** the response indicates assembly has started (202 status)

#### Scenario: Get session status

- **WHEN** `getSessionStatus(sessionId)` is called
- **THEN** a GET request is sent to `<serverUrl>/api/v1/sessions/{sessionId}/status`
- **AND** the session status, progress, assembly phase, and download URL (if ready) are returned

#### Scenario: Server unreachable

- **WHEN** any API call fails due to network error or server unavailability
- **THEN** the client throws a `ServerUnavailableError` with details
- **AND** the extension displays "Server is unavailable. Please try again later."

#### Scenario: API key rejected (auto re-registration)

- **WHEN** any API call returns a 401 status
- **THEN** the client acquires a re-registration lock (promise-based mutex) to prevent concurrent re-registration attempts
- **AND** if a re-registration is already in progress (lock held), the caller waits for the ongoing registration to complete and retries with the new key
- **AND** if no re-registration is in progress, the client registers with the server to obtain a new API key and retries the original request once
- **AND** if the retried request also returns 401, or if re-registration itself fails, throws an `AuthenticationError`
- **AND** this ensures at most one registration call is in-flight at any time, regardless of how many concurrent requests receive 401

### Requirement: Upload Queue Manager

The extension SHALL provide an `UploadQueue` that manages concurrent uploads to the server, similar to the existing `RequestQueue` for downloads.

#### Scenario: Concurrent uploads with limit

- **WHEN** multiple resources need to be uploaded to the server
- **THEN** uploads are processed with a maximum concurrency of 5 parallel uploads
- **AND** each upload reports progress (bytes sent / total bytes)

#### Scenario: Upload retry on transient failure

- **WHEN** an upload fails with a 5xx server error or network timeout
- **THEN** the upload is retried up to 3 times with exponential backoff (1s, 2s, 4s)

#### Scenario: Upload retry on permanent failure

- **WHEN** an upload fails with a 4xx client error
- **THEN** the upload is not retried
- **AND** the failure is reported to the caller

#### Scenario: Upload queue cancellation

- **WHEN** the user cancels the download or the session is deleted
- **THEN** all pending uploads in the queue are removed immediately
- **AND** any in-progress upload fetches are aborted via `AbortController.abort()`
- **AND** the server session is left in its current state (`scraping` or `uploading`) and will be cleaned up automatically by the stale-session expiry mechanism (30-minute timeout)
- **AND** no local cleanup is required beyond cancelling the upload fetches

### Requirement: ServerStorageAdapter

The extension SHALL provide a `ServerStorageAdapter` that implements the existing `IStorageAdapter` interface, uploading files to the server instead of storing locally.

#### Scenario: Add file via server upload

- **WHEN** `addFile(path, content, mimeType)` is called on the ServerStorageAdapter
- **THEN** the content is uploaded to the server as a resource with the given path and content type
- **AND** the upload is tracked in the upload queue

#### Scenario: File path mapping

- **WHEN** a file is added with a path like `images/photo.jpg`
- **THEN** the path is preserved as the ZIP-relative path sent to the server
- **AND** the server stores the file at this path in the ZIP

#### Scenario: ServerStorageAdapter not support getFile

- **WHEN** `getFile(path)` is called on the ServerStorageAdapter
- **THEN** the method returns null (server storage is write-only from the extension's perspective)
- **AND** no error is thrown

#### Scenario: ServerStorageAdapter getAllFiles

- **WHEN** `getAllFiles()` is called on the ServerStorageAdapter
- **THEN** the method returns an empty array (the server manages file enumeration during ZIP assembly)
- **AND** no error is thrown

#### Scenario: ServerStorageAdapter clear

- **WHEN** `clear()` is called on the ServerStorageAdapter
- **THEN** all pending uploads in the UploadQueue are aborted immediately via `AbortController.abort()`
- **AND** a DELETE request is sent to the session endpoint
- **AND** the server removes all session data
- **AND** no local cleanup is needed

### Requirement: Server Download Handler

The extension SHALL provide a server download handler that replaces the panel-download flow when server mode is active.

#### Scenario: Download from server URL

- **WHEN** the server session is in `ready` status and the user triggers download
- **THEN** the download URL returned by the status endpoint is validated: if it uses `http://` (not `https://`), a console warning is logged and the existing HTTPS warning badge in the UI remains visible
- **AND** `chrome.downloads.download` is called with the server's download URL regardless of scheme (the user was already warned at configuration time)
- **AND** no side panel blob URL delegation is needed

#### Scenario: Download with custom filename

- **WHEN** the download is triggered with a specific filename
- **THEN** the `filename` parameter is set in `chrome.downloads.download`
- **AND** the browser downloads the ZIP directly from the server

#### Scenario: Wait for assembly completion

- **WHEN** the extension calls finalize and the server returns 202 (assembly started)
- **THEN** the extension polls the status endpoint every 2 seconds
- **AND** when the status becomes `ready`, the download URL and output type are returned
- **AND** if the status becomes `failed`, the error message is thrown
- **AND** polling has a maximum timeout of 5 minutes, after which an `AssemblyTimeoutError` is thrown
- **AND** finalize is only accepted by the server when the session is in `uploading` status (after scrape-complete has been called)

#### Scenario: Control-plane call retry on transient failure

- **WHEN** `scrapeComplete()`, `uploadFilenameMap()`, `uploadContent()`, or `finalizeSession()` fails with a 5xx error or network timeout
- **THEN** the call is retried up to 3 times with exponential backoff (1s, 2s, 4s)
- **AND** if all retries fail, a `ServerUnavailableError` is thrown and the download is treated as failed
- **AND** these control-plane calls are NOT retried on 4xx errors (which indicate a client-side logic error)

### Requirement: Linked Page Upload Flow

The extension SHALL upload linked page HTML and resources to the server during full-website scraping, maintaining incremental filename map updates.

#### Scenario: Upload linked page HTML chunks

- **WHEN** the extension scrapes a linked page and captures HTML from each scroll position
- **THEN** the HTML is uploaded with `pageType: "linked"` and `pageUrl` set to the linked page's URL
- **AND** chunks are streamed to the server as the page is scrolled

#### Scenario: Upload linked page resources

- **WHEN** the extension downloads resources for a linked page
- **THEN** resources not already in the AssetRegistry are uploaded to the server
- **AND** the AssetRegistry prevents duplicate uploads of resources already downloaded for the main page

#### Scenario: Incremental filename map update after linked page

- **WHEN** a linked page discovers new images not in the main page's filename map
- **THEN** the extension uploads an updated filename map via `uploadFilenameMap()` before processing the next linked page
- **AND** the map includes both main page and linked page image mappings
