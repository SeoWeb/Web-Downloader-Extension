/// <reference types="vite/client" />

/**
 * Extend ImportMeta with Vite environment variables used by the extension.
 * VITE_SERVER_URL is set at build time when building for server mode.
 * VITE_PAGEPOCKET_URL is set at build time when building with PagePocket cloud.
 * When not set (undefined), the respective features are disabled.
 */
interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  readonly VITE_PAGEPOCKET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
