/**
 * Auth types for PagePocket cloud storage integration.
 */

export interface PagePocketUser {
  id: string;
  email: string;
  name: string;
}

export interface PagePocketAuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: PagePocketUser;
}

export const PAGEPOCKET_AUTH_STORAGE_KEY = "pagepocket_auth";
export const PAGEPOCKET_CLOUD_ENABLED_KEY = "pagepocket_cloud_enabled";

/**
 * Keep-me-signed-in persistence slice (easier-auth D1).
 *
 * When the user opts in on the login/register form, exactly this data is
 * mirrored to chrome.storage.local so the session survives a browser
 * restart. The access token and its expiry MUST stay in
 * chrome.storage.session — only the rotating refresh token and the user
 * record ever touch disk, and the password is never persisted anywhere.
 */
export interface PagePocketPersistedAuth {
  refreshToken: string;
  user: PagePocketUser;
}

/** chrome.storage.local key for the keep-signed-in slice (never the access token). */
export const PAGEPOCKET_AUTH_PERSISTED_KEY = "pagepocket_auth_persisted";

/**
 * Cloud binding state (task 6.5 / design D4 — harden-backend-security-and-ops).
 *
 * The monolith binds a PagePocket user to the API-key client via
 * POST /api/v1/cloud/link; the extension persists the *result* here so
 * cloud-mode session creation knows which credential to send. Stored in
 * chrome.storage.session: the binding lives on the server's client row,
 * which is re-created on every browser restart / re-registration — exactly
 * the lifetime of the API key and auth state in the same storage area.
 */
export type CloudBindingState =
  | {
      /** Server accepted the binding. */
      status: "bound";
      /** Verified user id stamped on the server-side client row. */
      pagepocketUserId: string;
      /** Plan recorded at binding time (refreshed on re-link). */
      plan: string | null;
      /** Epoch ms of the last successful link. */
      linkedAt: number;
    }
  | {
      /**
       * The monolith has no /cloud/link endpoint (older server, 404/501) or
       * its binding service is unconfigured (503): fall back to the legacy
       * raw-pagepocketUserId behavior so cloud mode keeps working.
       */
      status: "unsupported";
    };

export const PAGEPOCKET_CLOUD_BINDING_KEY = "pagepocket_cloud_binding";
