## 1. Server: proof-of-possession registration

- [x] 1.1 In `server/app/api/routes/auth.py`, split the dedup path: when `client_id` resolves to an existing client, require proof — read `X-API-Key` from the request; verify it against the resolved client using the `authenticate_client` lookup strategy (hash on `api_key_hash`, plaintext `api_key` fallback with lazy hash migration) scoped to that row
- [x] 1.2 Return 200 `RegisterResponse` with the existing key/identity when proof verifies; return 409 `{"error": "reauth_required", ...}` when no proof is presented; return 401 `{"error": "reauth_proof_invalid", ...}` when the presented key does not verify against the resolved client — all bodies in the repo's structured error style
- [x] 1.3 Update the route docstring/OpenAPI description (currently promises "returns the existing API key" unconditionally, `auth.py:117-118`) to document the proof requirement and the three outcomes
- [x] 1.4 Confirm ordering: per-IP limiter check remains the first gate so every outcome (fresh 201, 200 re-unlock, 409, 401) consumes the bucket; per-instance daily budget remains fresh-only

## 2. Server: session URL validation

- [x] 2.1 Create `server/app/services/url_validation.py`: parse with `urlsplit`; enforce the `http`/`https` scheme allowlist; require a host; classify hosts via `ipaddress` (lowercase, strip IPv6 brackets, pure-integer/hex fallback) against the blocked set (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0.0.0.0/8, 100.64.0.0/10, ::1, fc00::/7, fe80::/10, ::, ::ffff:0:0/96 evaluated as v4); return a structured verdict (allowed / reason: `scheme_not_allowed` | `private_address_not_allowed` | `invalid_url`) with no DNS resolution
- [x] 2.2 Wire the validator into `create_session` (`server/app/api/routes/sessions.py`) before any DB write, `os.makedirs`, or quota accounting; map rejections to 400 `{"error": "url_not_allowed", "reason": ..., "message": ..., "api_version": "v1"}` in the `content_too_large`/`resources_count_exceeded` body style
- [x] 2.3 Add config toggles/limits in `server/app/config.py` if needed (e.g., enabled flag, allowed-scheme list) following the existing settings conventions

## 3. Server: session-creation quota

- [x] 3.1 Add `max_active_sessions_per_client` (default 20) and `max_sessions_per_client_per_day` (default 200) to `server/app/config.py`
- [x] 3.2 In `create_session`, after URL validation and before insert: run the two indexed COUNT queries (`status IN ('scraping','uploading','assembling')` per client; `created_at > now-24h` per client) and reject with 429 `{"error": "session_limit_exceeded", "limit_type": "active_sessions"|"daily_creations", "limit": N, "retry_after": ..., "api_version": "v1"}`, emitting an accurate `Retry-After` header for the daily case (oldest in-window creation + 86400s − now)
- [x] 3.3 Verify `withRetry`/`throwForStatus` behavior for the new 400/429 codes from the extension side (no 429 retry loop) and adjust only if a retry path would churn the budget

## 4. Extension: registration recovery

- [x] 4.1 In `src/background/server-client.ts` `register()`: when an API key is held (in-memory or `chrome.storage.session`), send it as the `X-API-Key` proof header on the register call
- [x] 4.2 Handle 409 `reauth_required`: rotate the instance ID via `rotateInstanceId()` inside the same single-flight `registerWithMutex` flow and complete registration as a fresh client; persist the rotated ID
- [x] 4.3 Handle 401 `reauth_proof_invalid` (held key revoked/wrong): take the same fresh-instance recovery path
- [x] 4.4 Keep `MAX_REGISTRATION_ATTEMPTS`/Retry-After semantics intact: recovery consumes one attempt path, and permanent failure still surfaces as `AuthenticationError`

## 5. Server tests (pytest, real-SQLite fixtures per `server/tests/` conventions)

- [x] 5.1 Extend `server/tests/test_auth_security.py`: fresh registration 201 unchanged; re-unlock with correct proof returns 200 + same key, no duplicate row; ID-only re-registration of a registered ID → 409 `reauth_required` with no key material in the body; wrong-key proof → 401 `reauth_proof_invalid`
- [x] 5.2 **Bite-proof requirement:** prove the 409/401 tests fail on pre-fix code by running them against a HEAD worktree before implementing (record the observed failures in the PR description), the way previous changes did
- [x] 5.3 Extend `server/tests/test_auth_security.py` (limiter coverage): 409 and 200 re-register paths each consume the per-IP bucket (burst → 429 `rate_limit_exceeded`); per-instance budget still untouched by dedup/PoP hits; many-distinct-IDs flood from one IP stays per-IP bounded
- [x] 5.4 New `server/tests/test_session_url_validation.py` (or extend `test_session_lifecycle.py`): 201 for public http/https URLs and public IP literals; 400 `scheme_not_allowed` for `file://`, `data:`, `ftp:`; 400 `invalid_url` for hostless URLs; 400 `private_address_not_allowed` for each blocked family (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl. metadata IP, 0.0.0.0, 100.64/10, ::1, fc00::/7, fe80::/10, ::, `::ffff:127.0.0.1`, integer/hex-encoded v4); rejected creates leave no session row and no storage directory
- [x] 5.5 Quota tests: active cap (fill to `max_active_sessions_per_client` → 429 `active_sessions`); terminal transition frees budget; daily cap (fill window → 429 `daily_creations` with monotonic-clock-safe `Retry-After`); per-client independence; 429 leaves no session row
- [x] 5.6 Run the full server suite (`run-tests.sh` server portion) — no regressions in existing registration/session tests, especially the dedup-budget and Retry-After suites from `server-assembly-honesty`

## 6. Extension tests (vitest, `tests/unit/` conventions)

- [x] 6.1 Unit-test the register proof path: held key → `X-API-Key` header sent; no key → no proof header
- [x] 6.2 Unit-test 409 `reauth_required` recovery: fresh instance ID minted + persisted, single-flight (concurrent callers share one rotation), new key stored
- [x] 6.3 Unit-test 401 `reauth_proof_invalid` → same fresh-instance recovery, terminal `AuthenticationError` on persistent failure
- [x] 6.4 Unit-test `createSession` 400/429 propagation: thrown as terminal errors (no `withRetry` churn) with the server message intact

## 7. Validation and wrap-up

- [x] 7.1 `openspec validate api-abuse-hardening --strict` passes; all artifacts `done`
- [x] 7.2 Manual smoke: register fresh instance (201) → re-register with ID only (409) → re-register with key (200 same key) → create session with `file:///etc/passwd` (400) → hammer session-create past the caps (429 with `limit_type`)
- [x] 7.3 Update `docs/` API references if they document register/session-create behavior (check `docs/` for register endpoint mentions)
