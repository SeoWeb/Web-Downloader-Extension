## ADDED Requirements

### Requirement: Checkpoint survives failed resume attempts
The resume flow SHALL NOT clear the interrupt checkpoint before the resume outcome is known. The checkpoint SHALL be cleared only after the resume succeeds or fails definitively (e.g., expired/invalid server session). On transient failure (network unavailable, server unreachable), the checkpoint SHALL remain so recovery can be retried, including after the panel is closed and reopened.

#### Scenario: Transient failure keeps recovery possible
- **WHEN** a resume attempt fails because the server is unreachable
- **THEN** the checkpoint remains in `chrome.storage.session`
- **AND** closing and reopening the panel still offers Resume

#### Scenario: Definitive failure clears the checkpoint
- **WHEN** a resume attempt fails because the server session is expired or invalid
- **THEN** the checkpoint is cleared and the panel offers Restart instead of Resume

#### Scenario: Successful resume clears the checkpoint
- **WHEN** a resume attempt completes the download successfully
- **THEN** the checkpoint is cleared as part of normal completion cleanup
