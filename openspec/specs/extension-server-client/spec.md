# Extension Server Client Specification

## Purpose

The extension's HTTP client for the Python microservice: automatic registration and deadlock-free re-registration with the API key held in `chrome.storage.session`, per-tab server-session tracking, and the full upload/finalize/status call surface.

## Requirements

### Requirement: Server API Client

The extension SHALL provide a `ServerClient` class that encapsulates all HTTP communication with the Python microservice. The API key SHALL be stored in `chrome.storage.session` (cleared on browser restart; re-registration is automatic and deadlock-free per `extension-identity-lifecycle`). The server session tracking (`activeServerSessionId`, `serverScrollIndex`) SHALL be maintained per-tab so that multiple tabs can have independent server sessions simultaneously.

#### Scenario: Auto-registration on first use

- **WHEN** the ServerClient is initialized and no API key is stored in `chrome.storage.session`
- **THEN** a POST request is sent to `<serverUrl>/api/v1/auth/register` with a unique client identifier
- **AND** the returned API key is stored in `chrome.storage.session` for future use

#### Scenario: Re-registration on revoked key terminates

- **WHEN** a request returns 401 and re-registration with the stored instance id cannot produce a working key
- **THEN** the client re-registers with a fresh instance identifier (single-flight) and retries once
- **AND** persistent failure surfaces as an authentication error instead of looping

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

#### Scenario: Create session with PagePocket user ID

- **WHEN** `createSession(url, { singleFile, retentionDays, pagepocketUserId })` is called with a non-null `pagepocketUserId`
- **THEN** the POST request body SHALL include `options.pagepocketUserId` alongside existing options
- **AND** the server response is unchanged

#### Scenario: Create session without PagePocket user ID

- **WHEN** `createSession(url, { singleFile, retentionDays })` is called without `pagepocketUserId`
- **THEN** the POST request body SHALL NOT include `pagepocketUserId` in options
- **AND** existing behavior is preserved

#### Scenario: Status response with cloud fields

- **WHEN** `getSessionStatus(sessionId)` is called for a session that has cloud push data
- **THEN** the response SHALL include `cloud_status` (null | "pending" | "success" | "failed"), `cloud_page_id` (null | UUID string), and `cloud_error` (null | error message)

#### Scenario: Status response without cloud fields

- **WHEN** `getSessionStatus(sessionId)` is called for a non-cloud session
- **THEN** `cloud_status`, `cloud_page_id`, and `cloud_error` SHALL be `null`

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

### Requirement: Register retry honors Retry-After

When the registration request returns 429 with a `Retry-After` header, the extension's `register()` SHALL wait before the next attempt — bounded client-side to 60 seconds regardless of the header value — instead of retrying immediately; the wait SHALL NOT consume one of the bounded registration attempts. A 429 without a usable `Retry-After` header SHALL keep the existing exponential backoff, and total attempts remain bounded by `MAX_REGISTRATION_ATTEMPTS`.

#### Scenario: 429 with Retry-After delays the retry

- **GIVEN** the server responds 429 to a registration attempt with `Retry-After: 5`
- **WHEN** the retry loop processes the failure
- **THEN** the next attempt is made after approximately 5 seconds, not immediately
- **AND** the attempt budget still allows the subsequent attempt to succeed

#### Scenario: Retry-After is capped client-side

- **WHEN** a 429 response carries `Retry-After: 9999`
- **THEN** the client waits at most 60 seconds before retrying

#### Scenario: 429 without Retry-After uses existing backoff

- **WHEN** a registration attempt fails with 429 and no usable `Retry-After` header
- **THEN** the client applies the existing 1 s/2 s exponential backoff between attempts
- **AND** registration still fails after `MAX_REGISTRATION_ATTEMPTS` attempts if the server keeps rejecting

### Requirement: Proof-of-possession registration recovery

When the server rejects a registration with 409 `reauth_required` (the stored instance identifier is already registered and no proof of possession was presented), the extension SHALL recover by rotating to a fresh instance identifier (`rotateInstanceId`, persisted, single-flight via the registration mutex) and completing registration as a new client — the same recovery semantics as the post-401 fresh-instance path. When the extension does hold an API key at registration time, it SHALL send it as the `X-API-Key` proof so the registration can re-unlock the same identity. Recovery failures surface as `AuthenticationError` instead of looping.

#### Scenario: 409 reauth_required triggers fresh-instance registration

- **GIVEN** the extension holds a stored instance identifier whose server-side client exists, and no API key
- **WHEN** the registration attempt is rejected with 409 `reauth_required`
- **THEN** the extension rotates to a fresh instance identifier and registers as a new client within the same single-flight registration
- **AND** the resulting key is stored and used for subsequent calls

#### Scenario: Held key is sent as proof and re-unlocks the identity

- **GIVEN** the extension holds an API key at registration time
- **WHEN** it registers with its stored instance identifier
- **THEN** the request carries the key as `X-API-Key` proof
- **AND** a 200 re-unlock response keeps the existing identity and key

#### Scenario: Recovery failure terminates instead of looping

- **WHEN** fresh-instance registration after a 409 `reauth_required` also fails permanently
- **THEN** the extension throws an `AuthenticationError`
- **AND** no unbounded registration retry loop is entered

#### Scenario: New session-create error codes do not strand the caller

- **WHEN** `createSession` receives 400 `url_not_allowed` or 429 `session_limit_exceeded`
- **THEN** the error surfaces to the download pipeline as a terminal (non-retried) failure carrying the server's message
- **AND** no automatic retry loop consumes the daily creation budget
