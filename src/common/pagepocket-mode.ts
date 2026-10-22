/**
 * PagePocket cloud mode feature flag.
 *
 * `VITE_PAGEPOCKET_URL` is set at build time. When present, PagePocket
 * cloud features are enabled in the extension UI.
 */

export const PAGEPOCKET_URL: string | undefined = import.meta.env
  .VITE_PAGEPOCKET_URL;

export const IS_PAGEPOCKET_AVAILABLE =
  typeof PAGEPOCKET_URL === "string" && PAGEPOCKET_URL.length > 0;

/**
 * easier-auth D7 (task 3.5): `VITE_GOOGLE_CLIENT_ID` is set at build time
 * from the Google Cloud Console OAuth client (task 4.1). When unset, the
 * "Continue with Google" button is hidden and the extension behaves
 * exactly as in Phase 1 (password only).
 */
export const GOOGLE_CLIENT_ID: string | undefined = import.meta.env
  .VITE_GOOGLE_CLIENT_ID;

export const IS_GOOGLE_SIGN_IN_AVAILABLE =
  typeof GOOGLE_CLIENT_ID === "string" && GOOGLE_CLIENT_ID.length > 0;
