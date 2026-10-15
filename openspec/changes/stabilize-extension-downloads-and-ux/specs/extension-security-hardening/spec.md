## ADDED Requirements

### Requirement: No private keys in the repository
The repository SHALL NOT contain extension signing private keys or signed CRX artifacts. `dist.pem` and `dist.crx` SHALL be removed from the working tree and ignored, and key rotation SHALL be executed per the security runbook.

#### Scenario: Fresh clone contains no signing material
- **WHEN** the repository is cloned after the change
- **THEN** no `*.pem` private key or `*.crx` file exists in the working tree and `.gitignore` prevents re-adding them

### Requirement: Auth tokens live in session storage
PagePocket access/refresh tokens and the server API key SHALL be stored in `chrome.storage.session` (cleared when the browser closes), not `chrome.storage.local`.

#### Scenario: Tokens do not survive a browser restart on disk
- **WHEN** the user closes and reopens the browser
- **THEN** no auth tokens remain in `chrome.storage.local`
- **AND** the extension transparently re-registers the API key on first server call

### Requirement: Storage permission is required, not optional
The `storage` permission SHALL be declared in `permissions` (not `optional_permissions`), and all conditional permission-gating code for storage SHALL be removed. The app SHALL NOT block downloads on a storage-permission request.

#### Scenario: Download works without any permission prompt beyond install
- **WHEN** the extension is installed and the user starts a download
- **THEN** checkpoints and preferences persist via `chrome.storage` without an in-app permission gate

### Requirement: Minimal web-accessible resources
The manifest SHALL NOT expose extension resources to web pages via `web_accessible_resources` unless a page-context consumer exists. `locales/*.json` SHALL NOT be web-accessible.

#### Scenario: Locales are not probe-able by websites
- **WHEN** a website requests `chrome-extension://<id>/locales/en.json`
- **THEN** the request is denied

### Requirement: Manifest declares its runtime floor
The manifest SHALL declare `minimum_chrome_version` covering all APIs used unguarded (side panel APIs require Chrome 116).

#### Scenario: Older Chrome does not install a broken extension
- **WHEN** a user on Chrome 115 opens the listing
- **THEN** installation is blocked by the declared minimum version instead of failing at runtime

### Requirement: Server URL transport security is enforced
Server and PagePocket base URLs SHALL be rejected (not merely warned) at client construction when they are plain `http://` and not a loopback address.

#### Scenario: Plain-HTTP server URL is refused
- **WHEN** the build or runtime configuration points at `http://example.com`
- **THEN** the client fails fast with a configuration error instead of transmitting tokens in cleartext

#### Scenario: Loopback HTTP remains allowed for development
- **WHEN** the server URL is `http://localhost:8000`
- **THEN** the client starts normally
