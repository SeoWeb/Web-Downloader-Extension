## MODIFIED Requirements

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
