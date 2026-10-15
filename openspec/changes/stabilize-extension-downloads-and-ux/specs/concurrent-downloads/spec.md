## ADDED Requirements

### Requirement: Download-scoped shared mutable state
All mutable state used during asset processing SHALL be scoped to a single download (a per-download context created by `downloadResources`), not module-level globals. This includes the image filename map, dedup registries, and assembly-polling control. Existing per-tab state isolation requirements continue to apply.

#### Scenario: Concurrent tabs do not corrupt each other's filename maps
- **WHEN** Tab A and Tab B run linked-page downloads simultaneously
- **THEN** each download writes to and reads from its own filename map
- **AND** neither download's rewriting references the other's entries

#### Scenario: Assembly polling cancellation is scoped per download
- **WHEN** Tab A and Tab B are both polling assembly status and the user stops Tab A
- **THEN** only Tab A's polling loop is cancelled; Tab B's polling continues to completion

#### Scenario: No global state persists between downloads
- **WHEN** a download completes and a new one starts in the same tab
- **THEN** the new download's context starts empty (no stale filename entries or dedup keys)
