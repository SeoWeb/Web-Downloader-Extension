## Requirements

### Requirement: Cloud storage toggle in extension settings
The extension SHALL display a "PagePocket Cloud Storage" toggle in the Configuration section of the Filter component. The toggle SHALL only be visible when the build-time environment variable `VITE_PAGEPOCKET_URL` is set to a non-empty string.

#### Scenario: Toggle hidden when PagePocket not configured
- **GIVEN** `VITE_PAGEPOCKET_URL` is not set or is empty at build time
- **WHEN** the user views the Configuration section
- **THEN** the PagePocket Cloud Storage toggle is not displayed

#### Scenario: Toggle visible when PagePocket is configured
- **GIVEN** `VITE_PAGEPOCKET_URL` is set to a non-empty string at build time
- **WHEN** the user views the Configuration section
- **THEN** the PagePocket Cloud Storage toggle is displayed at the top of the Configuration section

#### Scenario: Toggle defaults to OFF
- **GIVEN** the user has never toggled cloud storage before
- **WHEN** the Configuration section is displayed
- **THEN** the toggle is in the OFF position

#### Scenario: Toggle state persists across sessions
- **GIVEN** the user has toggled cloud storage ON
- **WHEN** the user closes and reopens the extension sidepanel
- **THEN** the toggle is in the ON position
- **AND** the setting was loaded from `chrome.storage.local`

### Requirement: Cloud toggle shows authentication status
When the cloud storage toggle is ON, the extension SHALL display the current authentication status alongside the toggle.

#### Scenario: Toggle ON with user authenticated
- **GIVEN** cloud storage is toggled ON and the user is authenticated
- **WHEN** the Configuration section is displayed
- **THEN** a green "Connected as {email}" indicator is shown next to the toggle
- **AND** a "Sign Out" link is displayed

#### Scenario: Toggle ON without authentication
- **GIVEN** cloud storage is toggled ON and the user is not authenticated
- **WHEN** the Configuration section is displayed
- **THEN** an amber "Login required" indicator is shown next to the toggle

#### Scenario: Sign out from toggle area
- **GIVEN** cloud storage is ON and the user is authenticated
- **WHEN** the user clicks "Sign Out"
- **THEN** the stored JWT tokens are cleared from `chrome.storage.local`
- **AND** the authentication status changes to "Login required"
- **AND** the login/register form is shown

### Requirement: Cloud mode stored separately from filter options
The cloud storage toggle state SHALL be stored under its own `chrome.storage.local` key (`pagepocket_cloud_enabled`), independent of the `FilterOptions` stored under `webPageDownloader_filterOptions`.

#### Scenario: Cloud toggle does not affect filter options
- **GIVEN** the user has specific filter options set (e.g., downloadImages: true)
- **WHEN** the user toggles cloud storage ON or OFF
- **THEN** all filter options remain unchanged

#### Scenario: Filter reset does not affect cloud toggle
- **GIVEN** cloud storage is toggled ON
- **WHEN** filter options are reset to defaults
- **THEN** the cloud storage toggle remains ON
