## ADDED Requirements

### Requirement: Spoof-Proof Client IP Derivation
The API Gateway SHALL derive the client IP by walking `X-Forwarded-For` right-to-left and taking the first entry not matching `TRUSTED_PROXIES`, and SHALL honor `CF-Connecting-IP` only when the immediate peer is a trusted proxy AND no untrusted entry exists beyond it in `X-Forwarded-For` (mirroring the monolith's implementation in `server/app/api/routes/auth.py`).

#### Scenario: Leftmost spoofed entry ignored
- **WHEN** a request arrives via a trusted proxy with `X-Forwarded-For: 1.2.3.4, 203.0.113.7` where `203.0.113.7` is the real client appended by the trusted proxy
- **THEN** the limiter MUST use `203.0.113.7` as the client identity and MUST NOT use the attacker-supplied leftmost `1.2.3.4`

#### Scenario: CF-Connecting-IP from an untrusted peer is ignored
- **WHEN** a request with `CF-Connecting-IP: 6.6.6.6` originates from a peer not in `TRUSTED_PROXIES`
- **THEN** the limiter MUST ignore the header and derive identity from the connection peer / untrusted XFF walk

#### Scenario: Trusted proxy chain resolves to the real client
- **WHEN** only trusted proxies appear in `X-Forwarded-For` and the immediate peer is trusted
- **THEN** the limiter MUST use the `CF-Connecting-IP` value (or the rightmost untrusted entry) as the client identity

### Requirement: Narrowed Trusted Proxy Default
The compose configuration SHALL default `TRUSTED_PROXIES` to the specific reverse-proxy and Next.js hop addresses only (not the whole docker bridge network), overridable via environment, with the chosen values documented in the operations runbook.

#### Scenario: Default no longer trusts the whole bridge
- **WHEN** the production compose configuration is rendered
- **THEN** `TRUSTED_PROXIES` MUST list only the specific nginx/host and Next.js hop addresses (e.g. not `172.16.0.0/12`)

#### Scenario: Env override supported
- **WHEN** an operator sets `TRUSTED_PROXIES` explicitly
- **THEN** the gateway MUST use the provided list verbatim

### Requirement: Frontend Forwards the Real Client IP
The Next.js server SHALL forward the inbound client IP (as seen by Next from nginx's `X-Forwarded-For`) as an outbound `X-Forwarded-For` header on every server-to-gateway fetch, so the gateway's per-identity buckets reflect real end users instead of collapsing all web traffic into one identity.

#### Scenario: Proxied request carries per-client identity
- **WHEN** user A (IP `203.0.113.7`) logs in through the Next.js `/api/session` route and user B (IP `198.51.100.9`) does the same
- **THEN** each outbound fetch to the gateway MUST carry that user's own IP in `X-Forwarded-For`
- **AND** the gateway MUST bucket them separately (no shared 20/min bucket across all users)

#### Scenario: All five fetch sites forward the header
- **WHEN** the frontend makes any server-side gateway call from `app/api/session/route.ts`, `app/api/session/register/route.ts`, `app/api/pp/[...path]/route.ts`, `app/api/v1/auth/[...path]/route.ts`, or `lib/api/http.ts`
- **THEN** each call MUST pass through the shared forwarding helper (no fetch site bypasses it)

#### Scenario: No inbound header to forward
- **WHEN** the frontend receives a request without `X-Forwarded-For`
- **THEN** the outbound call MUST forward the connection peer address or omit the header (never synthesize a fixed shared value)

### Requirement: Public Share Routes Are Rate Limited
The gateway SHALL apply a per-IP rate bucket to the unauthenticated `/api/v1/share/public/*` routes (same 20/min class as auth routes), returning HTTP 429 with `Retry-After` when exceeded.

#### Scenario: Anonymous share traffic is throttled
- **WHEN** an unauthenticated client exceeds the configured rate on `/api/v1/share/public/{token}`
- **THEN** the gateway MUST return HTTP 429 with a `Retry-After` header and MUST NOT forward the request upstream

#### Scenario: Legitimate share viewers are unaffected
- **WHEN** a client stays within the configured rate while viewing a shared page and its assets
- **THEN** all requests MUST be forwarded normally
