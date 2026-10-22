## Context

The PagePocket stack authenticates with email + password: the FastAPI gateway fronts a gRPC auth-service (`pagepocket/services/auth-service`), issuing 1-hour HS256 access JWTs and 30-day opaque refresh tokens with rotation and reuse detection (`servicer.py:160-215`). The extension (MV3, no popup; side panel UI) deliberately stores **all** auth state in `chrome.storage.session` — memory-only, wiped on browser restart (design decision "D11", `src/background/pagepocket-client.ts:548-553`), and actively scrubs legacy copies from `chrome.storage.local` (`scrubLegacyLocalAuth()`). Consequence: the 30-day refresh token never survives a restart and users re-type their password every time. The `pagepocket_cloud_binding` record lives in session storage too, so it has the same problem. No OAuth, magic-link, or passkey infrastructure exists anywhere in the repo.

This change supersedes the D11 session-only decision with an opt-in persistence mode, and adds Google sign-in as a passwordless path.

## Goals / Non-Goals

**Goals:**

- Users stay logged in across browser restarts by default (Phase 1).
- One-click Google sign-in with the Google client secret never leaving the server (Phase 2).
- Preserve the existing security posture: short access tokens, refresh rotation, reuse-detection revocation, server-side logout revoke.
- Phase 1 requires **zero** server changes; Phase 2 backend work is additive and backwards-compatible.

**Non-Goals:**

- Password reset / "forgot password" flow, email-verification flow (the `is_verified` column remains as-is for password accounts).
- Passkeys/WebAuthn, magic links, or other OAuth providers (GitHub, Microsoft).
- A post-login settings toggle to change "keep me signed in" (choice is made at login; revisit later).
- Switching the gateway to cookie-based auth.

## Decisions

### D1 — Storage split for "keep me signed in" (Phase 1)

When the user opts in, persist **refresh token + user record + cloud binding** to `chrome.storage.local`; the **access token and expiry always stay in `chrome.storage.session`**. On startup with an empty session store, the client loads the refresh token from local storage and runs the existing proactive-refresh flow to mint a fresh access token.

- _Why:_ the access token is worthless after 1 hour and is the only token attached to every request — keeping it memory-only shrinks what disk theft yields to a single rotating refresh token.
- _Alternatives:_ persist everything in local (bigger blast radius, no benefit); httpOnly cookies (needs cookie permissions, CORS/credentials rework, and the gateway is Bearer-token based — rejected for scope).

### D2 — Opt-in checkbox, pre-checked

"Keep me signed in on this device" appears on both login and register forms, **pre-checked**. Unticking restores exactly today's behavior. The choice applies to the login/registration performed with it; there is no post-login toggle in v1.

- _Why:_ matches user expectations (Gmail/YouTube model); shared-computer users can untick. Server-side rotation + reuse-detection is what makes disk persistence acceptable, not the checkbox.

### D3 — Repurpose the legacy scrub

`scrubLegacyLocalAuth()` currently deletes any local auth keys on every load — it would fight the new persistence. It is reworked: local auth keys are removed **only** on logout, refresh-failure, or when the user logs in with keep-signed-in off.

### D4 — Google flow: PKCE authorization code, backend exchange

Extension uses `chrome.identity.launchWebAuthFlow` against Google's authorization endpoint with PKCE (S256), `state`, scope `openid email profile`, and redirect URI `https://<extension-id>.chromiumapp.org/`. The extension sends `{code, code_verifier, redirect_uri}` to the new `POST /api/v1/auth/google`; the **backend** exchanges the code using `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, verifies the ID token (signature via Google JWKS, `aud`, `exp`, `email_verified=true`), and issues the platform's normal access + refresh tokens.

- _Why over `chrome.identity.getAuthToken`:_ getAuthToken binds sign-in to the Chrome profile's Google account, behaves differently across Chromium forks, and pushes users through Chrome-web-store verification flows; launchWebAuthFlow lets the user pick any Google account.
- _Why over implicit `response_type=id_token`:_ the code flow with PKCE keeps the secret server-side and avoids bearer tokens passing through URL fragments.
- The pending `state`/PKCE verifier is kept in `chrome.storage.session` with a short TTL so a killed service worker mid-flow doesn't strand the user.

### D5 — Account linking: auto-link by verified email, `google_sub` column

Find user by `google_sub`; else match `email` on an existing account (Google emails are verified) and store `google_sub` on it; else create a new user (`plan='free'`, `is_verified=true`, name from Google). Migration `002` adds nullable unique `users.google_sub` **and makes `users.password_hash` nullable** — Google-created accounts have no password.

- _Alternatives:_ a multi-provider `user_identities` table (more general, unnecessary for one provider; a later migration can introduce it); keeping accounts separate (confusing duplicate-account UX).

### D6 — Stable extension ID and manifest changes

Add the `identity` permission and pin a public `key` in `manifest.json` so the extension ID — and therefore the Google redirect URI — is stable across unpacked dev loads and store releases. The OAuth client (Web application type) is registered in Google Cloud Console with exactly `https://<extension-id>.chromiumapp.org/` as authorized redirect URI. **Order matters:** pin the key and confirm the ID _before_ registering the client.

### D7 — Rollout gating

The Google button renders only when `VITE_GOOGLE_CLIENT_ID` is set at build time; if unset the extension behaves exactly as in Phase 1. Backend: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` added to config with production fail-fast validation (same pattern as `JWT_SECRET`). `/api/v1/auth/google` joins the existing public-path exception list and is rate-limited under the existing 20 req/min per-IP `/api/v1/auth/*` class. `CORS_ALLOW_ORIGINS` must include the production `chrome-extension://` origin.

### D8 — Cloud binding follows the auth decision

The `pagepocket_cloud_binding` record is persisted/cleared together with the refresh token. Persisting auth but not the binding would strand users signed-in-but-unlinked after a restart; the binding contains no credentials beyond the server API key reference already covered by the hardening spec.

## Risks / Trade-offs

- [Refresh token on disk is readable by local malware] → mitigated by rotation-on-every-use + reuse detection revoking all sessions (`servicer.py:174-181`); logout revokes server-side; the password is never persisted; users can opt out per device.
- [Extension ID changes and breaks the OAuth redirect] → pin the manifest `key` before release; document the ID in the deploy runbook; never regenerate the key.
- [Google outage or account issues block sign-in] → password login remains fully functional; Google errors surface as form messages; button hidden when client ID unset.
- [OAuth CSRF / code interception] → random `state` checked on redirect, PKCE S256 binds code to verifier, backend enforces exact `redirect_uri` match.
- [Google-only account cannot password-login] → accepted: `password_hash` is NULL and `Login` returns `UNAUTHENTICATED`; adding password setting is out of scope.
- [Session-first architecture confusion on refresh] → refresh path treats `chrome.storage.session` as source of truth for the access token and local as fallback for the refresh token only; single writer (the client storage layer) prevents drift.

## Migration Plan

1. **Phase 1 (extension only):** ship the checkbox + storage split; no server changes; rollback = previous extension build. Old extension + new extension interoperate with the unchanged server.
2. **Phase 2 (backend first):** deploy migration `002` (add `google_sub`, relax `password_hash`), env vars, gateway route — old extensions are unaffected by all of it.
3. **Phase 2 (extension last):** release with pinned `key`, `identity` permission, and Google button.
4. **Rollback:** hide the Google button via build var; the backend endpoint is inert without callers; the migration is additive (previous image runs fine with the extra nullable column).
5. Production deploy happens only on the user's explicit order, per `scripts/prod/README.md` and the deploy skill.

## Open Questions

- None blocking. Deferred by design: post-login toggle for keep-signed-in; password setting for Google-only accounts.
