## Context

An external security report (2026-10) exercised three abuse paths against the monolith server and all three verified against current code:

1. **Key replay.** `POST /api/v1/auth/register` is unauthenticated and creates a working API key. Re-posting a known `extension_instance_id` returns that client's existing key with the same 201 as a fresh registration (`server/app/api/routes/auth.py:151-160`; route-level `status_code=201` at `auth.py:115`). There is no proof that the caller is the instance's owner — the instance ID _is_ the only credential. Instance IDs are client-controlled strings minted as `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` (`src/background/server-client.ts:1565,1577,1586`) — high-entropy per instance, but leaked wherever instance IDs appear (logs, storage inspection, shared devices), and never rotatable by the user.
2. **No session-URL validation.** `create_session` stores `body.url` verbatim (`server/app/api/routes/sessions.py:353-427`); the reporter stored `file:///etc/passwd`, `localhost`, and `169.254.169.254` targets. Verified: the server performs **no outbound fetches** (no httpx/aiohttp/requests anywhere in `server/app`; `urllib.parse` is used only for parsing), so SSRF is _latent_ — the URL is echoed in API responses, drives filename derivation (`server/app/api/routes/download.py:184-200`), and lands in archive metadata, but nothing fetches it server-side today.
3. **No creation quota.** Session creation has no per-client bound. Existing quota structures are all _per-session_ (`max_session_size_mb`, `max_resources_per_session`, `max_content_text_mb` — `server/app/config.py:18,89,95`); the only plan concept is `Client.pagepocket_plan`, a nullable string recorded at cloud-link time (`server/app/models/client.py:79-84`), null for unbound clients. No billing system exists.

Volumetric rate limiting is **already done** (landed by `server-assembly-honesty`): per-IP 5/min registration bucket (`auth.py:129`, `rate_limiter.py:129`), per-instance 10/day budget (`config.py:73-76`, `rate_limiter.py:135-141`) that dedup'd lookups no longer burn, Retry-After capped at 300 s (`config.py:80`, `auth.py:67-79`), honored client-side clamped to 60 s (`server-client.ts:376,386-391,1102-1111`). An attacker guessing many distinct instance IDs from one IP is throttled by the per-IP bucket. The gap is not volume — it is that a _learned_ ID yields the key on the first try.

**Constraints:**

- The user chose proof-of-possession (the old key re-unlocks the same identity), explicitly rejecting the "409 Conflict, key granted once" alternative.
- The extension's normal flows must keep working: first registration is unauthenticated, and post-401 recovery _mints a fresh instance ID_ (`rotateInstanceId`, `server-client.ts:1538-1556`) — fresh IDs are unregistered, so they never hit the PoP gate.
- Single-process FastAPI + in-memory limiters; MySQL (real-SQLite in tests); no migrations without cause.

## Goals / Non-Goals

**Goals:**

- An instance ID alone grants nothing: re-registration of a registered ID requires proving possession of its current API key.
- First-registration UX unchanged (unauthenticated, rate-limited, 201).
- Session-create rejects non-http(s) schemes and private/loopback/link-local IP literals with a conventional error body.
- Config-backed per-key session-creation caps (active sessions + rolling 24h creations) with a clear 429 error contract.
- Extension handles the new outcomes without stranding any caller.

**Non-Goals:**

- No key-history purge, key-rotation campaign, or CWS-store release work.
- No billing/plan system; caps are plan-independent v1 (tiers can later read `client.pagepocket_plan`).
- No DNS resolution / rebinding defense in v1 (the server fetches nothing; see D4).
- No new rate-limiting machinery — the existing per-IP/per-instance limiters suffice; we pin their coverage instead.

## Decisions

### D1 — PoP mechanism: present the existing API key (not a signed token)

Re-registration with an already-registered `client_id` MUST carry that client's current API key in the `X-API-Key` header (the repo's existing credential channel — `authenticatedFetch` sets it on every call, `server-client.ts:1137`; `get_current_client` reads it, `dependencies.py:94`). The register route resolves the client by instance ID, then verifies the presented key against that row using the same lookup strategy as `authenticate_client` (`dependencies.py:32-73`): SHA-256 hash compare on `api_key_hash`, plaintext `api_key` fallback for legacy rows (with lazy hash migration).

- **Why the key itself:** possession of the key is _by definition_ the proof sought; the client already stores it (`chrome.storage.session`), and verification reuses primitives that exist today. Zero new credentials, zero crypto beyond the existing `hash_api_key`.
- **Alternative rejected — signed re-registration tokens:** a server-signed HMAC over the instance ID (or a one-time token returned by some pre-flight endpoint) adds a second credential type, signing/verification code, token storage and expiry semantics, and a bootstrap question (how does the client get the first token?) — all to prove something the key already proves. Revisit only if headers-on-register proves awkward for non-extension clients.
- **Why `X-API-Key` not `Authorization: Bearer`:** consistency with every authenticated endpoint in this codebase; one credential channel for clients to reason about.

### D2 — Register endpoint outcomes

| Case                                              | Response                                           |
| ------------------------------------------------- | -------------------------------------------------- |
| Fresh `client_id` (or absent)                     | 201 + new key (unchanged)                          |
| Registered ID + matching key proof                | 200 + existing key/identity (re-unlock)            |
| Registered ID + no proof                          | 409 `reauth_required` (body names the requirement) |
| Registered ID + proof that doesn't match that row | 401 `reauth_proof_invalid`                         |

- **Why 200 for re-unlock:** distinguishes "existing identity confirmed" from 201 "created", at zero client cost (the extension checks `res.ok`).
- **Why 409 for missing proof:** the request conflicts with server state (identity already provisioned) — matches the repo's use of 409 + structured body for state conflicts (`invalid_status`, `scraping_not_complete`).
- **Why 401 for a non-matching key:** the presented credential is wrong; 401 is the repo's code for bad keys (`_invalid_key_error`, `dependencies.py:21-29`). This is also the case a _revoked_ key lands in, which funnels the extension into its existing fresh-instance recovery (D3).
- **Ordering:** per-IP limiter check → dedup lookup → PoP gate. Every outcome therefore consumes the per-IP bucket (`auth.py:127-139` already guarantees this; tests pin it). The per-instance daily budget stays fresh-registration-only.

### D3 — Extension client delta

`register()` (`server-client.ts:1055-1119`):

- When a key is already held (in-memory or `chrome.storage.session`), send it as `X-API-Key` proof — a registration _retry_ after a lost response (server committed, client never saw the 201) then re-unlocks the same identity instead of orphaning it.
- On 409 `reauth_required` (registered ID, client holds no key): rotate the instance ID via the existing `rotateInstanceId()` and complete registration as a fresh client — the same single-flight, persisted-rotation recovery already used post-401 (D14). The old identity is unrecoverable by design (that is the fix working); the extension loses nothing it could access before.
- On 401 `reauth_proof_invalid` (held key is revoked/wrong): the same fresh-instance path — identical to today's behavior where a revoked key forces a new identity.
- Any other caller of session-create sees the new 429/400 as ordinary thrown errors: `withRetry` retries only 5xx/network failures (`server-client.ts:1254-1258`), so `session_limit_exceeded` / `url_not_allowed` surface to the download pipeline as terminal errors with the server's message.

### D4 — URL validation: scheme allowlist + IP-literal blocklist, literal-only v1

Enforced in `create_session` before any DB write or directory creation. A new `app/services/url_validation.py` returns a structured verdict; the route maps rejections to 400 `url_not_allowed` with the repo's error-body style plus a machine-readable `reason` (`scheme_not_allowed` | `private_address_not_allowed` | `invalid_url`).

- **Scheme allowlist:** `http` / `https` only. `file:`, `ftp:`, `data:`, `blob:`, custom schemes → rejected. Missing host → rejected.
- **IP-literal blocklist:** after `urlsplit`, lowercase the hostname, strip IPv6 brackets, and try `ipaddress.ip_address` (with a pure-integer fallback so `2130706433` / `0x7f000001`-style encodings resolve before the host is judged). Reject: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0/8`, `100.64.0.0/10` (CGNAT), IPv6 `::1/128`, `fc00::/7`, `fe80::/10`, `::` unspecified, and `::ffff:0:0/96`-mapped v4 (evaluate the embedded v4 against the v4 rules).
- **Literal-only v1 — no hostname resolution:** the server performs zero outbound fetches, so rebinding buys an attacker nothing today; resolving hostnames would add blocking DNS I/O on the single event loop (or a resolver thread pool), TTL/caching semantics, and a _false-sense_ gap anyway (rebinding defeats resolve-then-connect by construction). The spec states the limitation explicitly; if server-side fetching ever ships, resolution-time validation becomes mandatory there — that is the right enforcement point, not session-create.
- **Alternative rejected — validating at every read path:** the URL is echoed in list/status responses and baked into archives; validating once at the write path is complete for stored data and needs no per-read cost.

### D5 — Session-creation quota: two config-backed per-key caps

Counted in SQL against the existing `sessions` table (`ix_sessions_client_id`), enforced in `create_session` before insert:

- **Active-session cap** — `max_active_sessions_per_client` (default 20): `COUNT(*) WHERE client_id = ? AND status IN ('scraping','uploading','assembling')`. Bounds concurrent pipeline work (each active session occupies assembler capacity and storage directories).
- **Rolling creation cap** — `max_sessions_per_client_per_day` (default 200): `COUNT(*) WHERE client_id = ? AND created_at > now() - 24h`. Bounds churn (junk rows, disk-loop attempts) independent of session completion.
- Exceeded → 429 `session_limit_exceeded` with `limit_type` (`active_sessions` | `daily_creations`), `limit`, and `retry_after` seconds in the body; the daily case also emits an accurate `Retry-After` header (computable: oldest in-window creation + 86400 s − now), while the active case omits it (completion time is unknowable).
- **Why two caps:** the active cap alone permits unbounded ready-session hoarding; the daily cap alone permits unbounded concurrency. Each is one indexed COUNT query.
- **Why 429 not 403:** the condition is transient (sessions finish, windows roll) — 429 semantics match; 403 stays reserved for identity/policy failures (`cloud_identity_mismatch`, `forbidden`).
- **Why plan-independent:** `pagepocket_plan` is null for the (default) unbound population — gating on it would exempt exactly the anonymous abuser from the report. Tiers remain a one-line future change at the cap lookup.

### D6 — No migration, no schema change

Quota counting aggregates existing columns; PoP verifies against existing `api_key_hash` / `api_key` columns. Both new settings land in `app/config.py` alongside `registration_per_instance_daily_limit` with the same env-var conventions.

## Risks / Trade-offs

- **[Old clients re-registering an existing ID get 409]** → Only reachable when a client holds an ID but not its key; the bundled extension is updated in the same change (D3) and its own recovery already rotates IDs. Third-party integrators get a body that names the requirement (`reauth_required`). Marked **BREAKING** in the proposal.
- **[Legitimate user bumps the active-session cap]** → Default 20 concurrent actives exceeds any realistic tab set (the extension scopes sessions per tab); the cap is env-tunable and the 429 body says which limit fired. Self-healing: actives drain as assemblies finish.
- **[Shared-NAT users share the per-IP registration bucket]** → Pre-existing condition, unchanged; PoP re-unlock (200) also consumes the bucket but a real re-register is rare (once per browser session at most).
- **[Literal-only URL validation misses rebinders]** → Honest v1 scope: no server-side fetch exists to attack; documented in the capability spec so the gap is visible, not silent.
- **[PoP header on register confuses load balancers/basic-auth middleware]** → `X-API-Key` is already used unauthenticated-adjacent on every other route; nginx does not inspect it. Register stays POST-with-body; no path changes.
- **[Count queries add latency to every session-create]** → Two indexed COUNTs on `client_id` at creation rates bounded by the caps themselves (≤200/day/key); negligible against the existing per-create `os.makedirs` + commit.

## Migration Plan

1. Land server gates + tests (URL validation and quota are additive; PoP changes register semantics).
2. Land the extension delta in the same release (proof-sending + 409 recovery) so bundled clients never observe 409 in normal operation.
3. Rollout order is deployment-internal (monolith + extension ship together); no DB migration, no backfill, no ops runbook changes.
4. Rollback: revert deploy; no data cleanup needed (no schema, no purge).

## Open Questions

- Exact default values (20 active / 200 daily) — chosen generously vs. the report's "4 sessions" abuse; tune from production observation after rollout. Config names may track `registration_per_instance_daily_limit` style during implementation.
