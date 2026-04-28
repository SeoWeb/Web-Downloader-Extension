## MODIFIED Requirements

### Requirement: Server API Client
The extension SHALL provide a `ServerClient` class that encapsulates all HTTP communication with the Python microservice. The server session tracking (`activeServerSessionId`, `serverScrollIndex`) SHALL be maintained per-tab so that multiple tabs can have independent server sessions simultaneously.

#### Scenario: Auto-registration on first use
- **WHEN** the ServerClient is initialized and no API key is stored in `chrome.storage.local`
- **THEN** a POST request is sent to `<serverUrl>/api/v1/auth/register` with a unique client identifier
- **AND** the returned API key is stored in `chrome.storage.local` for future use

#### Scenario: Create session
- **WHEN** `createSession(url)` is called with a stored API key
- **THEN** a POST request is sent to `<serverUrl>/api/v1/sessions` with the URL and API key in the `X-API-Key` header
- **AND** the session ID from the response is returned
- **AND** the session ID is stored in the per-tab session state map keyed by the calling tab's `tabId`

#### Scenario: Upload HTML chunk routes to per-tab session
- **WHEN** `uploadHtmlChunk` is called during scrolling for a specific tab
- **THEN** the HTML chunk is uploaded to the session stored in that tab's per-tab session state
- **AND** the scroll index is tracked independently per tab

#### Scenario: Per-tab session isolation
- **WHEN** Tab A creates session `s1` and Tab B creates session `s2`
- **THEN** Tab A's HTML chunks and resource uploads go to `s1`
- **AND** Tab B's HTML chunks and resource uploads go to `s2`
- **AND** neither tab's session state affects the other

#### Scenario: Session cleanup on tab close
- **WHEN** a tab is closed while it has an active server session
- **THEN** the tab's session state entry is removed from the per-tab map
- **AND** the server session itself is NOT deleted (remains available for download until server retention expires)

#### Scenario: Server health check
- **WHEN** the ServerClient needs to verify server availability
- **THEN** a GET request is sent to `<serverUrl>/api/v1/health` without authentication
- **AND** if the server returns 200, the server is considered available
- **AND** if the request fails or times out, the server is considered unavailable

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
