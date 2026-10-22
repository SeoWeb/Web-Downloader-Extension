/**
 * Cloud binding orchestration (task 6.5 / design D4 —
 * harden-backend-security-and-ops).
 *
 * Links the PagePocket identity to the monolith's API-key client via
 * POST /api/v1/cloud/link and persists the binding state in
 * chrome.storage.session (same lifetime as the PagePocket auth state and
 * the server API key — all three are re-established together after a
 * browser restart or re-registration). With keep-signed-in active
 * (easier-auth D8) the record is additionally mirrored to
 * chrome.storage.local and follows the persisted refresh token's
 * lifecycle: written on link/refresh, restored on startup, cleared on
 * logout / refresh failure.
 *
 * Lifecycle:
 * - login/register  → fire-and-forget `linkCloudAccount()` (never fails login)
 * - logout          → `clearCloudBinding()` (store) + fire-and-forget
 *                     `clearServerBinding()` (DELETE /cloud/link, never
 *                     blocks logout — close-cloud-lifecycle-gaps D1)
 * - token refresh   → no re-bind needed: the binding lives server-side on the
 *                     client row and is tied to the user identity, not the
 *                     rotating access token
 * - cloud download  → `ensureCloudBinding()` lazily re-binds when the state
 *                     is missing (link still in flight, transient failure)
 * - 403 cloud_not_linked at session creation → `ensureCloudBinding({ force })`
 *                     re-binds (the server-side client row was replaced)
 * - browser restart → `restoreCloudBindingFromLocal()` copies the mirrored
 *                     record back into session storage when a keep-signed-in
 *                     session was restored (easier-auth D8)
 */

import { serverClient } from "./server-client";
import { pagepocketClient } from "./pagepocket-client";
import {
  PAGEPOCKET_AUTH_PERSISTED_KEY,
  PAGEPOCKET_AUTH_STORAGE_KEY,
  PAGEPOCKET_CLOUD_BINDING_KEY,
  type CloudBindingState,
  type PagePocketAuthState,
} from "../types/authTypes";

export type CloudLinkOutcome =
  | "bound"
  | "unsupported"
  | "invalid_token"
  | "failed";

export interface CloudLinkOutcomeResult {
  outcome: CloudLinkOutcome;
  /** The binding state AFTER the attempt (null when nothing was persisted). */
  binding: CloudBindingState | null;
}

async function loadStoredAuth(): Promise<PagePocketAuthState | null> {
  try {
    if (!chrome?.storage?.session) return null;
    const result = await chrome.storage.session.get(
      PAGEPOCKET_AUTH_STORAGE_KEY,
    );
    return (result[PAGEPOCKET_AUTH_STORAGE_KEY] as PagePocketAuthState) ?? null;
  } catch {
    return null;
  }
}

/** Read the persisted binding state (null when absent). */
export async function getCloudBinding(): Promise<CloudBindingState | null> {
  try {
    if (!chrome?.storage?.session) return null;
    const result = await chrome.storage.session.get(
      PAGEPOCKET_CLOUD_BINDING_KEY,
    );
    return (result[PAGEPOCKET_CLOUD_BINDING_KEY] as CloudBindingState) ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep-signed-in is active iff the opt-in auth slice exists on disk
 * (easier-auth D8: the binding is persisted/cleared together with the
 * refresh token, so its presence is the mirror trigger).
 */
async function hasPersistedAuth(): Promise<boolean> {
  try {
    if (!chrome?.storage?.local) return false;
    const result = await chrome.storage.local.get(
      PAGEPOCKET_AUTH_PERSISTED_KEY,
    );
    return result[PAGEPOCKET_AUTH_PERSISTED_KEY] !== undefined;
  } catch {
    return false;
  }
}

/** Persist the binding state. */
async function persistCloudBinding(state: CloudBindingState): Promise<void> {
  try {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.set({
      [PAGEPOCKET_CLOUD_BINDING_KEY]: state,
    });
    // easier-auth D8: mirror the binding to disk while keep-signed-in is
    // active so it survives a browser restart alongside the refresh token.
    if (await hasPersistedAuth()) {
      await chrome.storage.local.set({
        [PAGEPOCKET_CLOUD_BINDING_KEY]: state,
      });
    }
  } catch {
    // Non-critical — the lazy path re-binds on the next cloud download
  }
}

/** Clear the binding state (logout, rejected token, refresh failure). */
export async function clearCloudBinding(): Promise<void> {
  try {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.remove(PAGEPOCKET_CLOUD_BINDING_KEY);
    // easier-auth D8: the mirrored disk copy dies with the session copy.
    await chrome.storage.local.remove(PAGEPOCKET_CLOUD_BINDING_KEY);
  } catch {
    // Non-critical
  }
}

/**
 * easier-auth D8 (task 1.4): after a browser restart restored a
 * keep-signed-in session, copy the mirrored binding record from
 * chrome.storage.local back into chrome.storage.session so cloud mode
 * knows its credential again without a re-link round-trip.
 */
export async function restoreCloudBindingFromLocal(): Promise<void> {
  try {
    if (!chrome?.storage?.local || !chrome?.storage?.session) return;
    const result = await chrome.storage.local.get(PAGEPOCKET_CLOUD_BINDING_KEY);
    const binding = result[PAGEPOCKET_CLOUD_BINDING_KEY] as
      | CloudBindingState
      | undefined;
    if (binding) {
      await chrome.storage.session.set({
        [PAGEPOCKET_CLOUD_BINDING_KEY]: binding,
      });
    }
  } catch {
    // Non-critical — ensureCloudBinding() lazily re-binds on demand
  }
}

/**
 * Unbind the PagePocket identity on the server side (DELETE /api/v1/cloud/link,
 * close-cloud-lifecycle-gaps D1) and clear the stored binding state ONLY on
 * success. Called fire-and-forget from the PagePocket logout flow: a network
 * or server failure is logged and swallowed — logout must complete even if
 * the monolith is down, and the next successful linkCloudAccount() overwrites
 * a stale binding anyway (mirrors the login/register failure posture).
 */
export async function clearServerBinding(): Promise<void> {
  try {
    const unbound = await serverClient.unbindCloudAccount();
    if (!unbound) {
      console.warn(
        "[CloudBinding] server unbind failed — keeping local binding state",
      );
      return;
    }
    await clearCloudBinding();
  } catch (err) {
    // Never let unbind problems surface into the logout flow.
    console.warn("[CloudBinding] server unbind failed:", err);
  }
}

/**
 * Run the binding flow. Uses the supplied access token, or the stored PagePocket
 * auth state (refreshing an expired token first so a stale session doesn't fail
 * the link). Persists the result: `bound` / `unsupported` states are stored;
 * `invalid_token` clears any stale binding; `failed` leaves the state untouched.
 */
export async function linkCloudAccount(
  accessToken?: string,
): Promise<CloudLinkOutcomeResult> {
  const auth = await loadStoredAuth();
  let token = accessToken ?? auth?.accessToken ?? null;

  if (!token && !auth) {
    return { outcome: "failed", binding: await getCloudBinding() };
  }

  // Access tokens are short-lived (1 h since the TTL change) — refresh an
  // expired one so a valid refresh session isn't reported as a bad token.
  if (auth && token && Date.now() >= auth.expiresAt * 1000) {
    try {
      token = await pagepocketClient.refreshToken(auth.refreshToken);
    } catch {
      return { outcome: "invalid_token", binding: null };
    }
  }

  if (!token) {
    return { outcome: "failed", binding: await getCloudBinding() };
  }

  const result = await serverClient.linkCloudAccount(token);

  switch (result.outcome) {
    case "bound": {
      const binding: CloudBindingState = {
        status: "bound",
        pagepocketUserId: result.pagepocketUserId,
        plan: result.plan,
        linkedAt: Date.now(),
      };
      await persistCloudBinding(binding);
      return { outcome: "bound", binding };
    }
    case "unsupported": {
      const binding: CloudBindingState = { status: "unsupported" };
      await persistCloudBinding(binding);
      return { outcome: "unsupported", binding };
    }
    case "invalid_token":
      await clearCloudBinding();
      return { outcome: "invalid_token", binding: null };
    case "failed":
      return { outcome: "failed", binding: await getCloudBinding() };
  }
}

/**
 * Lazy ensure for cloud-mode session creation (download-core): returns the
 * current binding when bound, attempting the link flow when no binding state
 * exists yet. An `unsupported` state short-circuits to null (legacy
 * raw-pagepocketUserId fallback) unless `force` re-checks the server — used
 * by the 403 cloud_not_linked retry so a since-upgraded server is discovered.
 */
export async function ensureCloudBinding(
  options: { force?: boolean } = {},
): Promise<CloudBindingState | null> {
  const existing = await getCloudBinding();

  if (!options.force) {
    if (existing?.status === "bound") return existing;
    if (existing?.status === "unsupported") return null;
  }

  const { binding } = await linkCloudAccount();
  return binding?.status === "bound" ? binding : null;
}
