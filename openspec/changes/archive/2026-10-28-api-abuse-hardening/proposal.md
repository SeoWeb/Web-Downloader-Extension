## Why

An external security report (2026-10) demonstrated that `POST /api/v1/auth/register` is unauthenticated yet mints a fully working API key, and that re-posting a known `extension_instance_id` hands back that client's existing key with no proof of possession (`server/app/api/routes/auth.py:151-160` — dedup lookup returns `api_key`, same 201 as a fresh registration). Anyone who learns a user's instance ID — a client-controlled string (`ext-<timestamp>-<random>`), echoed in logs and API payloads — gains full access to that user's download sessions and files. The same report showed an attacker can create unbounded download sessions targeting arbitrary URLs (`localhost`, `169.254.169.254`, `file:///etc/passwd`) because session creation stores the `url` field with zero validation (`server/app/api/routes/sessions.py:353-427`) and no per-client session quota exists. Verified context: volumetric registration abuse is already bounded (per-IP 5/min, per-instance 10/day, capped Retry-After — landed by `server-assembly-honesty`), so the real gap is not request volume but that a _learned instance ID alone yields the key_, and that session creation has neither input validation nor a creation budget. The server never fetches session URLs itself (no outbound HTTP client anywhere in `server/app`), so the URL threat is latent SSRF / stored-garbage today — but the URL is echoed in API responses and baked into archive metadata, and any future server-side fetch turns it live.

## What Changes

**Proof-of-possession re-registration (the core fix):**

- Re-registering an already-registered `client_id` now requires proof of possession: presenting the client's existing API key on the register call returns the existing key/identity (the "re-unlock" path). A register request for an already-registered ID _without_ proof is rejected with 409 `reauth_required` — the instance ID alone no longer yields a key. **BREAKING** for any client that relied on ID-only dedup (the bundled extension is updated in the same change).
- First registration stays exactly as today: unauthenticated, rate-limited, 201 with a fresh key. Fresh instance IDs (the extension's post-401 recovery path, `rotateInstanceId`) are unaffected.
- Rate limiting needs no new machinery: every register request — including dedup and PoP paths — already consumes the per-IP bucket before any lookup (`auth.py:127-139`); the change keeps that invariant pinned by tests. The PoP gate removes the value of ID-guessing entirely (guessing a _key_ remains infeasible at 64 hex chars).

**Session URL validation at creation:**

- `POST /api/v1/sessions` validates the `url` before creating anything: scheme allowlist (`http`/`https` only — `file:`, `ftp:`, `data:`, etc. rejected) and rejection of literal private/loopback/link-local/unique-local IP targets (IPv4 `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `0.0.0.0`; IPv6 `::1`, `fc00::/7`, `fe80::/10`, `::ffff:`-mapped v4). Rejections are 400 `url_not_allowed` in the repo's error-body style.
- v1 validates IP literals only (no hostname resolution): the server performs no outbound fetches, so DNS-rebinding hardening buys nothing today while costing blocking I/O; the limitation is documented in the spec.
- This is defense-in-depth against latent SSRF: it stops garbage/unsafe URLs from being stored, echoed in API responses, and embedded in archive metadata.

**Session-creation quota per API key:**

- Config-backed caps enforced at session creation, counted in SQL per client: a concurrency cap on _active_ sessions (`scraping`/`uploading`/`assembling`) and a daily creation cap. Exceeding either returns 429 `session_limit_exceeded` with the limit type and bound in the body — no billing/plan system is invented (`pagepocket_plan` exists but is null for unbound clients; caps are plan-independent in v1).
- The extension's `createSession` caller already treats non-retryable 4xx as terminal (`withRetry` retries only 5xx/network), so the new 429 surfaces as a normal download error without stranding the client.

**Extension client delta:**

- `ServerClient.register()` recognizes 409 `reauth_required` (registered ID, no proof presented) and recovers the established way: rotate to a fresh instance ID (single-flight mutex, persisted) and register as a new client. When the extension does hold a key, it sends it as proof so identity survives registration retries (e.g., a lost response after a server-side commit).

## Capabilities

### New Capabilities

- `server-session-input-validation`: session-create URL validation — scheme allowlist, private/loopback/link-local IP-literal rejection, the `url_not_allowed` error contract, and the explicit literal-only (no DNS resolution) v1 scope.

### Modified Capabilities

- `server-api`: the Client Registration requirement gains proof-of-possession semantics (proof-bearing re-registration re-unlocks the same key; ID-only re-registration of a registered instance is rejected 409 `reauth_required`; first registration unchanged) and the Session Creation requirement gains the URL-validation and session-quota rejection outcomes.
- `server-resource-guards`: new requirement for per-client session-creation quotas (active-session cap + daily creation cap, config-backed, 429 `session_limit_exceeded`) and a requirement pinning that every registration outcome (fresh, dedup/PoP re-registration, rejection) consumes the per-IP registration bucket.
- `extension-server-client`: the auto-registration behavior handles 409 `reauth_required` by rotating to a fresh instance ID (single-flight), and sends the stored key as proof when it has one.

## Impact

- **Server (`server/`):** `app/api/routes/auth.py` (PoP gate on the dedup path, proof verification against `api_key_hash`), `app/api/routes/sessions.py` (URL validation + quota gates in `create_session`), new `app/services/url_validation.py` (scheme + IP-literal checks), `app/api/rate_limiter.py` (unchanged; coverage pinned by tests), `app/config.py` (new settings: active-session cap, daily creation cap, validation toggles).
- **Extension:** `src/background/server-client.ts` (`register()` sends `X-API-Key` proof when a key exists; handles 409 `reauth_required` via `rotateInstanceId` recovery).
- **Tests:** `server/tests/test_auth_security.py` (PoP accept/reject, ID-only 409, limiter coverage on all paths), `server/tests/test_session_lifecycle.py` or new `test_session_url_validation.py` (scheme/IP-literal rejections, quota caps), extension vitest for the 409 recovery path; behavioral tests must be proven failing on pre-fix code via a HEAD worktree before implementation merges.
- **No DB migration** — quota counts are SQL aggregates over the existing `sessions` table (`ix_sessions_client_id`); PoP verifies against the existing `api_key_hash` column. **No ops work** (no key purge, no rotation campaign) — scoped to the four reported asks.
