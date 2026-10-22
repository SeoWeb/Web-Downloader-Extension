## 1. Phase 1 — Keep me signed in (extension, no server changes)

- [x] 1.1 Add `KeepSignedIn` opt-in plumbing: extend auth-state persistence layer in `src/background/pagepocket-client.ts` so the refresh token, user record, and cloud binding are mirrored to `chrome.storage.local` when opted in, while the access token and expiry always stay in `chrome.storage.session`
- [x] 1.2 Rework `scrubLegacyLocalAuth()` so local auth keys are removed only on logout, refresh failure, or keep-signed-in-off logins (no longer unconditionally on load)
- [x] 1.3 Add "Keep me signed in on this device" checkbox (pre-checked) to login and register forms in `src/components/PagePocketAuth.tsx` and wire the choice through `src/stores/pagepocketStore.ts` into login/registration calls
- [x] 1.4 Extend startup restore in `src/stores/pagepocketStore.ts` (`initializeFromStorage`) to load the refresh token/user from `chrome.storage.local` when the session store is empty and run the existing proactive refresh
- [x] 1.5 Update logout and refresh-failure paths to clear both `chrome.storage.session` and `chrome.storage.local` auth keys (client + `src/background/cloud-binding.ts`)
- [x] 1.6 Update refresh rotation to replace the persisted copy in both storage areas when keep-signed-in is active
- [ ] 1.7 Manual verification pass: restart browser with opt-in (stays logged in, access token never on disk), restart with opt-out (login form shown, local empty), logout (both areas wiped)

## 2. Phase 2 — Backend: Google sign-in

- [x] 2.1 Create Alembic migration `002_google_signin`: add nullable unique `google_sub` to `users` and make `password_hash` nullable; update `services/auth-service/models.py`
- [x] 2.2 Add `GoogleAuth` RPC to the proto (`pagepocket-proto-contracts`): request `{code, code_verifier, redirect_uri}`, response = existing `AuthResponse`; regenerate stubs
- [x] 2.3 Implement `GoogleAuth` in `services/auth-service/servicer.py`: server-side code exchange with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, ID-token verification (Google JWKS signature, `aud`, `exp`, `email_verified=true`), account resolution (match `google_sub` → link by verified email → create free user with `is_verified=true`, NULL `password_hash`), issue tokens via the existing issuance/refresh-token path
- [x] 2.4 Handle failure modes: invalid code/token → `UNAUTHENTICATED`, Google outage → safe non-enumerating `UNAUTHENTICATED`, never mutate users on failure; password login with NULL `password_hash` returns the generic `UNAUTHENTICATED`
- [x] 2.5 Add gateway route `POST /api/v1/auth/google` in `services/api-gateway/routers/auth.py` and add it to the public-path exception list in `middleware/__init__.py`
- [x] 2.6 Add `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to `services/api-gateway/config.py` + `services/auth-service` config with production fail-fast validation, and to `docker-compose.yml` (dev defaults commented/marked)
- [x] 2.7 Backend tests: token verification edge cases, auto-link vs duplicate prevention, Google-only account login rejection, exchange-failure handling

## 3. Phase 2 — Extension: Google button + PKCE flow

- [x] 3.1 Pin the extension ID: generate/add public `key` to `public/manifest.json` and confirm the resulting stable ID; document it in the deploy runbook
- [x] 3.2 Add `identity` permission to `public/manifest.json`
- [x] 3.3 Create `src/background/google-auth.ts`: PKCE (S256) verifier/challenge + `state` generation, pending-flow state in `chrome.storage.session` with short TTL, `chrome.identity.launchWebAuthFlow` with scope `openid email profile` and redirect `https://<extension-id>.chromiumapp.org/`, redirect validation (state match, exact redirect origin)
- [x] 3.4 Add `googleLogin({code, code_verifier, redirect_uri})` to `src/background/pagepocket-client.ts` calling `POST /api/v1/auth/google` and storing returned tokens through the shared storage layer (respecting keep-signed-in)
- [x] 3.5 Add "Continue with Google" button + divider to `src/components/PagePocketAuth.tsx` (shown only when `VITE_GOOGLE_CLIENT_ID` is set); handle popup-closed and access-denied as form messages; add `VITE_GOOGLE_CLIENT_ID` to `.env`/`.env.example`
- [ ] 3.6 Manual verification: new Google user creation, linking with an existing password account, returning Google user, password-login rejection for Google-only account, button hidden when client ID unset

## 4. Release prep

- [x] 4.1 Register Google OAuth client (Web application type) in Google Cloud Console with redirect URI `https://<extension-id>.chromiumapp.org/`; record client ID/secret for env config
- [x] 4.2 Confirm `CORS_ALLOW_ORIGINS` in production includes the production `chrome-extension://` origin
- [x] 4.3 Update production env/secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) — deployment itself only on explicit user order per `scripts/prod/README.md` (deploy order: backend + migration 002 first, extension last)
- [x] 4.4 Update user-facing docs/release notes: keep-signed-in behavior, Google sign-in, shared-computer opt-out

## 5. Follow-ups (discovered during implementation)

- [x] 5.1 Frontend auth proxy: add `google` to `ALLOWED_PATHS` in `pagepocket/frontend/src/app/api/v1/auth/[...path]/route.ts` so `POST /api/v1/auth/google` forwards through app.pagepocket.app (was 404 "Unknown auth endpoint" — root cause of first user test failure). Commit `410242c`, deployed + E2E-verified through the public URL.
- [x] 5.2 auth-service: log Google token-endpoint `error`/`error_description` on exchange failure (was status-only, made diagnosis blind). Commit `0d3b498`, deployed.
- [ ] 5.3 Add `VITE_GOOGLE_CLIENT_ID` as a CI build secret so Web Store artifacts include the Google button (operator's local builds unaffected; button hidden in store builds until then).

## 6. Follow-up — Google sign-in in the web app + Google-first UI order

- [x] 6.1 `GET /api/auth/google/start` route handler: PKCE S256 + `state`, short-lived httpOnly cookie scoped to `/api/auth/google`, 302 to Google authorize endpoint; 404/hidden when `GOOGLE_CLIENT_ID` unset
- [x] 6.2 `GET /api/auth/google/callback` route handler: state validation, gateway `POST /auth/google` exchange, `setAuthCookies` session, redirect to validated target; error/cancel → `/login?error=google|google_cancelled`
- [x] 6.3 Web UI: login + register pages — "Continue with Google" button first, "or" divider, then email/password; server-component gating on `GOOGLE_CLIENT_ID`; error banner for `?error=`; login threads `?redirect=`, register targets `/app/onboarding`
- [x] 6.4 Extension UI: move the Google button + divider above the email/password fields (both tabs)
- [x] 6.5 Env plumbing: `GOOGLE_CLIENT_ID` (+ `GOOGLE_OAUTH_REDIRECT_URI`) in frontend `env.ts` (optional) + `.env.example` + local `.env.local` + host `.env.production.local`
- [x] 6.6 Tests: start/callback route handlers (cookie, state mismatch, exchange success/failure), existing suites stay green (frontend + extension)
- [ ] 6.7 Operator: add `https://app.pagepocket.app/api/auth/google/callback` as authorized redirect URI on the existing Google Cloud Console OAuth client
- [ ] 6.8 Deploy frontend + verify through public URL (start → 302 to accounts.google.com with expected params; callback without cookie → `/login?error=google`); manual web Google sign-in verification
