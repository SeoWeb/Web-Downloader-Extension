## ADDED Requirements

### Requirement: Auto-Registration with Server

The extension SHALL automatically register with the server on first use, obtaining an API key that is stored locally for future requests. The user does not see or manage the API key.

#### Scenario: First-time registration

- **WHEN** the extension starts for the first time and the server URL is configured (via .env / Vite env variable)
- **THEN** the extension sends a registration request to `POST /api/v1/auth/register`
- **AND** the server creates a new user with a unique API key
- **AND** the extension stores the API key in `chrome.storage.local` for all future requests

#### Scenario: Subsequent requests use stored API key

- **WHEN** the extension has a stored API key from a previous registration
- **THEN** all API requests include the `X-API-Key` header with the stored key
- **AND** no re-registration occurs

#### Scenario: API key rejected by server

- **WHEN** the server rejects the stored API key (e.g., server was reset, key revoked)
- **THEN** the extension re-registers automatically to obtain a new API key
- **AND** the new key replaces the old one in `chrome.storage.local`

### Requirement: Server URL from Build Configuration

The extension SHALL read the server URL from the build environment configuration (Vite env variable or manifest), not from user input. The server URL is set in the server's `.env` file and injected at build time.

#### Scenario: Server URL available at runtime

- **WHEN** the extension is built with `VITE_SERVER_URL` set in the `.env` file
- **THEN** the server URL is available at runtime via `import.meta.env.VITE_SERVER_URL`
- **AND** no user-facing configuration is needed for the server URL

#### Scenario: Server URL not configured

- **WHEN** the extension is built without a `VITE_SERVER_URL`
- **THEN** the extension operates in local-only mode
- **AND** no server communication is attempted

### Requirement: Server Mode Determined by Configuration

Whether the extension uses server mode or local mode SHALL be determined by the `.env` configuration, not by user action. The user cannot toggle between modes.

#### Scenario: Server mode active

- **WHEN** the extension is built with a valid `VITE_SERVER_URL`
- **THEN** all downloads use the server-side pipeline
- **AND** a visual indicator shows "Server mode" in the filter panel

#### Scenario: Local mode active

- **WHEN** the extension is built without a `VITE_SERVER_URL`
- **THEN** all downloads use the existing local pipeline
- **AND** no server communication occurs

### Requirement: Server Unavailable Error Handling

When the server is configured but unreachable, the extension SHALL display an error message with an option to fall back to local mode.

#### Scenario: Server unreachable at download start

- **WHEN** server mode is active and the server is unreachable when the user initiates a download
- **THEN** the extension displays "Server is unavailable. Try again or download locally."
- **AND** the user can choose to retry the server or fall back to local mode
- **AND** if the user chooses local mode, a warning is displayed: "Local mode requires re-scraping the page from scratch."
- **AND** if the user confirms, the download proceeds using the existing local pipeline

#### Scenario: Server becomes unreachable during download

- **WHEN** server mode is active and the server becomes unreachable during an active download
- **THEN** the extension displays "Server connection lost. Try again or download locally."
- **AND** the download is stopped
- **AND** the user can retry when the server is available again
- **AND** the user can choose to restart the download in local mode
- **AND** a warning is displayed that local mode requires re-scraping the page from scratch

#### Scenario: Server unreachable during registration

- **WHEN** the extension attempts to register with the server and the server is unreachable
- **THEN** the extension displays "Cannot connect to server. Please check your network connection."
- **AND** retries registration automatically when the extension is next used

#### Scenario: User chooses local fallback

- **WHEN** the user selects the local fallback option after a server error
- **THEN** the current download is cancelled on the server side (if a session was created)
- **AND** the user is warned that re-scraping is required since HTML and resources were streamed to the server
- **AND** the server mode indicator remains active for future downloads
- **AND** a notification indicates the download is proceeding in local mode

### Requirement: HTTPS Enforcement Warning

The extension SHALL warn the user if the configured server URL does not use a secure HTTPS connection.

#### Scenario: Non-HTTPS server URL configured

- **WHEN** the `VITE_SERVER_URL` begins with `http://` instead of `https://`
- **THEN** the extension displays a warning badge or notice in the filter panel
- **AND** the notice states: "Server is not using HTTPS. API key and data may be exposed."
- **AND** this warning is shown whenever server mode is active with an insecure URL
- **AND** the server mode indicator remains active for future downloads
