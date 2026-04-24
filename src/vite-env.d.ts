/// <reference types="vite/client" />

/**
 * Extend ImportMeta with Vite environment variables used by the extension.
 * VITE_SERVER_URL is set at build time when building for server mode.
 * When not set (undefined), the extension runs in local-only mode.
 */
interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
