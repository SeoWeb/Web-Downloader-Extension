# Download Fetch Pipeline Specification

## Purpose

Defines the behavior of the asset fetch pipeline (`RequestQueue` and its consumers): hard fetch timeouts, credentialed requests with cookieless fallback, a consumable dedup cache, correct handling of opaque `no-cors` responses, and fair scheduling across rate-limited domains.

## Requirements

### Requirement: Fetch timeout enforcement
The system SHALL enforce a hard timeout on every asset fetch executed by the `RequestQueue`. A request that has not completed within the configured `requestTimeout` (default 30 seconds) SHALL be aborted and returned as a failed request with a `timeout` error category.

#### Scenario: Hung socket does not block the queue
- **WHEN** an asset host accepts the TCP connection but never responds
- **THEN** the request is aborted after `requestTimeout` elapses
- **AND** the queue slot is released and the failure is recorded with category `timeout`

#### Scenario: Timeout respects download cancellation
- **WHEN** the user stops the download while a request is in flight
- **THEN** the request is aborted immediately via the download's abort signal, independent of the timeout

### Requirement: Credentialed asset fetches
The system SHALL send asset fetches with `credentials: "include"` so that session cookies are attached to cross-origin asset requests permitted by host permissions.

#### Scenario: Asset behind a login session downloads
- **WHEN** a page references an asset on a CDN that requires the site's session cookie
- **THEN** the fetch includes the cookie and the asset downloads successfully

#### Scenario: Fallback to cookieless fetch on credentialed failure
- **WHEN** a credentialed fetch fails with a 4xx response
- **THEN** the queue retries the same URL once with `credentials: "omit"` before recording failure

### Requirement: Consumable dedup cache
The dedup cache SHALL store a response snapshot (status, headers, bytes or text, content type) rather than a `Response` object, and SHALL provide each consumer an independently readable result. A cached entry whose body exceeds 5 MB SHALL not be cached.

#### Scenario: Same URL referenced twice succeeds twice
- **WHEN** two different CSS files reference the same background image URL within the cache TTL
- **THEN** both handlers receive independently readable bytes and both uploads succeed

#### Scenario: Large responses bypass the cache
- **WHEN** a response body exceeds 5 MB and the URL is requested again within the TTL
- **THEN** the URL is fetched again instead of served from cache

### Requirement: Opaque response handling
The system SHALL detect opaque (`no-cors`) responses and SHALL NOT attempt to read their bodies. Image and JS handlers SHALL record opaque results as a categorized `cors` failure; CSS SHALL treat opaque responses as failures.

#### Scenario: CORS-blocked image is skipped, not crashed
- **WHEN** an image URL can only be fetched in `no-cors` mode and returns an opaque response
- **THEN** the image handler records the asset as failed with reason `cors`
- **AND** the overall download continues and completes

#### Scenario: Opaque CSS response fails cleanly
- **WHEN** a stylesheet is only available as an opaque response
- **THEN** the CSS handler records a `cors` failure without throwing

### Requirement: Fair scheduling across rate-limited domains
The `RequestQueue` processing loop SHALL continue dispatching requests to non-limited domains when the head of the queue belongs to a saturated domain, and SHALL NOT busy-spin while all eligible requests are domain-blocked.

#### Scenario: Slow domain does not starve fast domains
- **WHEN** the queue head targets a domain whose limiter is cooling down and later queued requests target other ready domains
- **THEN** the ready requests start before the limited domain's cooldown expires

#### Scenario: Idle loop waits instead of spinning
- **WHEN** every queued request is blocked by its domain limiter
- **THEN** the processing loop waits for the nearest limiter availability instead of polling at a fixed 10 ms interval
