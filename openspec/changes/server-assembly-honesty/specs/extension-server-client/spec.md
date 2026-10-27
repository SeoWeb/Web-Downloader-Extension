## ADDED Requirements

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
