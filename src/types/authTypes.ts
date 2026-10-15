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
