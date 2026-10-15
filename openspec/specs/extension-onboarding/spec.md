# Extension Onboarding Specification

## Purpose

Defines the first-run and day-to-day onboarding surface of the extension: a real welcome experience on install, a single coherent user-facing surface, enforced locale key coverage, and a download flow that is never gated on auxiliary permissions.

## Requirements

### Requirement: First-run experience exists
On installation, the extension SHALL open a built welcome page (or in-panel tour) that explains what the extension does, shows the download flow, and directs the user to the side panel. The install listener SHALL NOT be empty.

#### Scenario: Fresh install shows onboarding
- **WHEN** the user installs the extension
- **THEN** a real welcome page opens once, explaining the feature and how to start a download
- **AND** subsequent browser starts do not re-open it

#### Scenario: Updated installs are not nagged
- **WHEN** the extension updates to a new version
- **THEN** the welcome page does not open

### Requirement: One coherent UI surface
The extension SHALL ship exactly one user-facing surface (the side panel). Dead or unbuilt surfaces (popup, legacy sidepanel, placeholder welcome content) SHALL be removed from the source tree, and the build SHALL produce only shipped entry points.

#### Scenario: Build inputs match shipped UI
- **WHEN** the production build runs
- **THEN** every HTML entry produced is reachable from the manifest or runtime code
- **AND** no component with dead controls or test-only utilities ships

### Requirement: Locale key coverage is enforced
Every user-visible string SHALL exist as a key in the English locale, and every non-English locale SHALL contain all English keys (falling back to English text is acceptable for untranslated entries; missing keys are not). A check in the test suite SHALL fail the build on violations.

#### Scenario: No raw keys rendered to users
- **WHEN** any UI state renders in any language
- **THEN** every interpolated key resolves to a translated or English-fallback string, never a raw key like `status.finalizingPartial`

#### Scenario: Coverage check fails on a missing key
- **WHEN** a developer adds a `t("new.key")` usage without adding `new.key` to `en.json`
- **THEN** the test suite fails with the offending key name

### Requirement: Downloads are not gated on auxiliary permissions
No permission request other than what installation already grants SHALL block the core download flow. Settings-related permissions, if any, SHALL degrade gracefully to in-context prompts.

#### Scenario: Panel is usable immediately after install
- **WHEN** the user opens the side panel on a supported page
- **THEN** the download form is available with no full-screen permission gate
