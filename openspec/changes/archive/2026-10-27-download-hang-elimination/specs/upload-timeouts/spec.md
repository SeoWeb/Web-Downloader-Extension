## MODIFIED Requirements

### Requirement: Control-plane API call timeout

The system SHALL apply a 60-second timeout to ALL server control-plane API calls, authenticated or not. This includes session creation, scrape-complete, finalize, filename map upload, content upload, client registration (`register()`), and the server health check (`checkHealth()`). A server that accepts the connection but never responds SHALL therefore fail the call with a timeout error instead of hanging the caller, so download start cannot stall indefinitely on registration or health checking.

#### Scenario: API call completes within timeout

- **WHEN** a control-plane call sends a request that completes in under 60 seconds
- **THEN** the request proceeds normally

#### Scenario: API call exceeds timeout

- **WHEN** a control-plane call does not complete within 60 seconds
- **THEN** the request is aborted and the error propagates to the caller

#### Scenario: Registration cannot hang session creation

- **GIVEN** no API key is stored and the server accepts the TCP connection but never responds
- **WHEN** `register()` runs inside `createSession()` at download start
- **THEN** each registration fetch aborts at the 60-second bound and consumes the existing retry budget
- **AND** persistent failure surfaces as an authentication failure so START_DOWNLOAD answers with an error instead of hanging

#### Scenario: Health check cannot hang

- **GIVEN** the server accepts the TCP connection but never responds
- **WHEN** `checkHealth()` is called
- **THEN** the fetch aborts at the 60-second bound
- **AND** the server is reported unavailable via `ServerUnavailableError`
