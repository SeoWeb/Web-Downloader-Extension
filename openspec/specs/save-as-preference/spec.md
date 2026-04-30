## ADDED Requirements

### Requirement: Save As preference storage
The system SHALL store an `alwaysAskWhereToSave` boolean option as part of `FilterOptions`. The default value SHALL be `true`. When the field is absent from stored options (e.g., after upgrade), the default SHALL be applied automatically.

#### Scenario: New installation default
- **WHEN** the extension is installed for the first time
- **THEN** `alwaysAskWhereToSave` defaults to `true`
- **AND** the "Save As" dialog is shown on download

#### Scenario: Existing user upgrade
- **WHEN** a user upgrades from a version without this setting
- **AND** their stored options do not contain `alwaysAskWhereToSave`
- **THEN** the system applies the default value `true`
- **AND** existing behavior is preserved

### Requirement: Save As preference controls download dialog
The system SHALL use the `alwaysAskWhereToSave` option to control the `saveAs` parameter of `chrome.downloads.download()` for all final download triggers. When `alwaysAskWhereToSave` is `true`, the "Save As" dialog SHALL be shown. When `false`, the file SHALL download automatically to the default downloads folder.

#### Scenario: Automatic download when disabled
- **GIVEN** `alwaysAskWhereToSave` is `false`
- **WHEN** a download completes and the ZIP is ready
- **THEN** the file downloads automatically without a "Save As" dialog
- **AND** Chrome saves the file to the default downloads location

#### Scenario: Save As dialog when enabled
- **GIVEN** `alwaysAskWhereToSave` is `true`
- **WHEN** a download completes and the ZIP is ready
- **THEN** the "Save As" dialog is shown
- **AND** the user chooses the save location

#### Scenario: Multi-part downloads unaffected
- **GIVEN** `alwaysAskWhereToSave` is `true` or `false`
- **WHEN** a multi-part download writes individual parts
- **THEN** individual parts always download automatically (`saveAs: false`)
- **AND** only the final combined download respects the user's preference
