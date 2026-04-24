/**
 * Shared server-mode detection.
 *
 * Server mode is determined at build time by the `VITE_SERVER_URL`
 * environment variable. When set, the extension uses server mode
 * (uploads to the Python microservice). When not set, it uses
 * local mode (IndexedDB / JSZip).
 *
 * Previously each file independently read `VITE_SERVER_URL` and
 * computed `IS_SERVER_MODE`. This module centralises that logic
 * so the detection rule is defined once and imported everywhere.
 */

/** Raw server URL from the build environment (undefined in local-only builds). */
export const SERVER_URL = import.meta.env.VITE_SERVER_URL as string | undefined;

/** `true` when `VITE_SERVER_URL` is a non-empty string (server mode active). */
export const IS_SERVER_MODE = typeof SERVER_URL === "string" && SERVER_URL.length > 0;
