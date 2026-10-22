## Why

Users must re-enter their email and password after every browser restart: the extension deliberately stores all PagePocket auth state in `chrome.storage.session` (design decision D11), so the server's 30-day refresh token never survives a restart. There is also no passwordless option — only email+password — making first login and re-login unnecessarily heavy.

## What Changes

**Phase 1 — "Keep me signed in" (extension only, no server changes):**

- Add a **"Keep me signed in on this device"** checkbox (pre-checked) to the login and register forms.
- When opted in, persist the **refresh token, user record, and cloud binding** to `chrome.storage.local`; the access token and expiry remain in `chrome.storage.session` (memory-only).
- Startup restore reads the persisted refresh token from `chrome.storage.local` and runs the existing proactive-refresh flow to obtain a fresh access token.
- Logout and refresh-failure clear both storage areas and revoke server-side (existing behavior).
- Rework the legacy `chrome.storage.local` scrub so it no longer conflicts with opt-in persistence.
- Users who untick the box keep today's exact behavior (full session-only storage).

**Phase 2 — Google sign-in (extension + backend):**

- New **"Continue with Google"** button on the extension auth form.
- Extension obtains a Google authorization code via `chrome.identity.launchWebAuthFlow` using PKCE (S256) and redirect URI `https://<extension-id>.chromiumapp.org/`, then exchanges `{code, code_verifier, redirect_uri}` at the backend. The Google client secret stays server-side only.
- New public endpoint `POST /api/v1/auth/google` on the API Gateway, routed to a new `AuthService.GoogleAuth` RPC that exchanges the code with Google, verifies the returned ID token (audience, expiry, `email_verified`), and issues the platform's normal JWT access + rotating refresh tokens.
- **Auto-linking:** when the verified Google email matches an existing password account, the accounts are linked by storing `google_sub` on the existing user (no duplicate account). New Google users are created with `plan='free'`, `is_verified=true`.
- Alembic migration adding a nullable unique `google_sub` column to `users`.
- Manifest gains the `identity` permission and a pinned `key` so the extension ID (and thus the Google redirect URI) is stable.

## Capabilities

### New Capabilities

(none — all requirements changes land in existing component-scoped capabilities)

### Modified Capabilities

- `extension-cloud-auth`: session-only storage requirement gains an opt-in "keep me signed in" persistence mode (refresh token + user + cloud binding in `chrome.storage.local`); login/register flows gain the checkbox and a Google sign-in flow; startup restore, logout, and refresh-failure behavior updated for both modes.
- `extension-security-hardening`: "auth tokens live in session storage" requirement is relaxed to permit the opt-in refresh-token/user/cloud-binding persistence; access tokens remain session-only, and opt-out keeps full session-only behavior.
- `pagepocket-auth-service`: new `GoogleAuth` RPC (code exchange, ID-token verification, find-or-create by `google_sub`, auto-link by verified email) plus the `google_sub` column migration.
- `pagepocket-api-gateway`: `/api/v1/auth/google` is added to the public (no-JWT) route exception list.

## Impact

- **Extension:** `public/manifest.json` (identity permission, pinned key), `src/background/pagepocket-client.ts` (storage layer, scrub, `googleLogin()`), `src/background/cloud-binding.ts`, `src/stores/pagepocketStore.ts`, `src/components/PagePocketAuth.tsx`, new `src/background/google-auth.ts` (PKCE + launchWebAuthFlow), `.env` (`VITE_GOOGLE_CLIENT_ID`).
- **Backend (`pagepocket/`):** `services/auth-service/servicer.py`, `models.py`, new alembic migration `002_*`, `services/api-gateway/routers/auth.py` and `middleware/__init__.py` (public paths), `config.py` + `docker-compose.yml` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), shared proto (`pagepocket-proto-contracts`).
- **Manual/ops:** Google Cloud Console OAuth client (Web application type) with redirect URI `https://<extension-id>.chromiumapp.org/`; production deploy includes an Alembic DB migration and new env secrets.
- **No breaking API changes** to existing endpoints; existing password-login users and stored sessions keep working.
