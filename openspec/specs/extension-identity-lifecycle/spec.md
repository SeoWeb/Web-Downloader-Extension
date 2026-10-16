# Extension Identity Lifecycle Specification

## Purpose

How the extension's monolith identity behaves across browser restarts and key revocation: session-scoped key storage with clean restart semantics, deadlock-free single-flight re-registration, and server-side reaping of orphaned identities.

## Requirements

### Requirement: Session-scoped key storage with clean restart semantics
The extension SHALL continue storing its monolith API key and instance identity in `chrome.storage.session` (cleared on browser restart). A browser restart SHALL produce a fresh registration; this is accepted, documented behavior — old server sessions of the previous identity expire naturally, and the extension re-registers transparently on first use.

#### Scenario: Restart orphans old sessions without breaking the user
- **WHEN** the browser restarts and the user starts a new download
- **THEN** the extension registers a new client and proceeds normally
- **AND** old sessions belonging to the previous identity are never accessible to the new identity

### Requirement: Re-registration is deadlock-free
When a request returns 401 and the stored instance id resolves to a revoked or otherwise unusable key, the extension SHALL re-register with a fresh instance identifier instead of retrying the same doomed identity. Re-registration SHALL be single-flight (concurrent callers share one registration) and SHALL terminate in a definitive state (registered, or a surfaced authentication error) rather than looping.

#### Scenario: Revoked key does not loop
- **WHEN** the stored instance id's key was revoked server-side and a request receives 401
- **THEN** the extension re-registers using a newly generated instance id
- **AND** the retried request carries the new key
- **AND** if registration itself fails, the user sees an authentication error instead of infinite retries

#### Scenario: Concurrent 401s share one re-registration
- **WHEN** several parallel uploads receive 401 at the same time
- **THEN** exactly one re-registration flow executes
- **AND** all callers retry with the resulting key

### Requirement: Orphaned server-side identities are reaped
The monolith SHALL clean up clients that have no active sessions and no successful authentication activity beyond a configured age, and SHALL reap sessions belonging to dead clients via the existing expiry mechanism. Orphan accumulation SHALL NOT be unbounded.

#### Scenario: Stale client rows are removed
- **WHEN** the cleanup pass runs and finds clients with zero sessions and no auth activity for longer than the configured threshold
- **THEN** those client rows are deleted
- **AND** clients with active or recent sessions are untouched

#### Scenario: Orphaned sessions do not outlive their clients
- **WHEN** a client row is reaped
- **THEN** any sessions still associated with it are expired and their files removed by the normal expiry cleanup
