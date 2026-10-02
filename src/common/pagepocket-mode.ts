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
