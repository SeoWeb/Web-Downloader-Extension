/**
 * PagePocketClient — extension-side API client for the PagePocket cloud backend.
 *
 * Encapsulates JWT auth (register, login, refresh, logout), authenticated
 * fetch with automatic token refresh on 401, page ingestion via multipart
 * upload, and health checks.
 */

import type {
  PagePocketAuthState,
  PagePocketPersistedAuth,
  PagePocketUser,
} from "../types/authTypes";
import {
  PAGEPOCKET_AUTH_PERSISTED_KEY,
  PAGEPOCKET_AUTH_STORAGE_KEY,
  PAGEPOCKET_CLOUD_BINDING_KEY,
} from "../types/authTypes";
import { PAGEPOCKET_URL } from "../common/pagepocket-mode";
import { assertSecureBaseUrl } from "./server-client";

// ---------------------------------------------------------------------------
// Error classes (3.1)
// ---------------------------------------------------------------------------

export class PagePocketAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PagePocketAuthError";
  }
}

export class PagePocketUploadError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "PagePocketUploadError";
    this.statusCode = statusCode;
  }
}

export class PagePocketQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PagePocketQuotaError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: PagePocketUser;
}

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface IngestResponse {
  success: boolean;
  page_id: string;
  message: string;
  api_version: string;
}

export interface IngestPageParams {
  url: string;
  title?: string;
  htmlContent: Blob;
  extensionJobId?: string;
  plan?: string;
  assets?: Array<{
    filename: string;
    contentType: string;
    data: Blob;
  }>;
  onUploadProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

interface HealthResponse {
  status: string;
  version?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTROL_CALL_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (signal) {
    if (typeof AbortSignal.any === "function") {
      return AbortSignal.any([signal, timeoutSignal]);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    timeoutSignal.addEventListener("abort", onAbort, { once: true });
    return controller.signal;
  }
  return timeoutSignal;
}

// ---------------------------------------------------------------------------
// PagePocketClient
// ---------------------------------------------------------------------------

export class PagePocketClient {
  private readonly baseUrl: string;
  private authState: PagePocketAuthState | null = null;

  /** Promise-based mutex so concurrent 401s trigger at most one refresh */
  private refreshLock: Promise<string> | null = null;

  constructor() {
    this.baseUrl = PAGEPOCKET_URL?.replace(/\/+$/, "") ?? "";

    if (this.baseUrl) {
      // D11 (task 7.4): refuse insecure configuration instead of warning
      assertSecureBaseUrl(this.baseUrl, "PagePocket URL");
    }
  }

  // -----------------------------------------------------------------------
  // Auth methods (3.2)
  // -----------------------------------------------------------------------

  async register(
    email: string,
    password: string,
    name: string,
    keepSignedIn = false,
  ): Promise<PagePocketAuthState> {
    const res = await this.unauthenticatedFetch("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });

    if (!res.ok) {
      await this.throwForStatus(res, "register");
    }

    const data = (await res.json()) as AuthResponse;
    return this.saveAuth(data, keepSignedIn);
  }

  async login(
    email: string,
    password: string,
    keepSignedIn = false,
  ): Promise<PagePocketAuthState> {
    const res = await this.unauthenticatedFetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      await this.throwForStatus(res, "login");
    }

    const data = (await res.json()) as AuthResponse;
    return this.saveAuth(data, keepSignedIn);
  }

  /**
   * easier-auth D4 (task 3.4): exchange a Google authorization code for the
   * platform's normal token pair. The extension sends the PKCE-bound
   * `{code, code_verifier, redirect_uri}`; the backend holds the client
   * secret and verifies the Google identity. Error handling and the
   * post-auth persistence path (saveAuth → session storage + opt-in local
   * mirror; the access token never touches disk) are identical to login().
   */
  async googleLogin(
    params: { code: string; code_verifier: string; redirect_uri: string },
    keepSignedIn = false,
  ): Promise<PagePocketAuthState> {
    const res = await this.unauthenticatedFetch("/api/v1/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: params.code,
        code_verifier: params.code_verifier,
        redirect_uri: params.redirect_uri,
      }),
    });

    if (!res.ok) {
      await this.throwForStatus(res, "googleLogin");
    }

    const data = (await res.json()) as AuthResponse;
    return this.saveAuth(data, keepSignedIn);
  }

  async refreshToken(token?: string): Promise<string> {
    // MV3 restart: in the service-worker context authState is null even
    // though a valid session/keep-signed-in copy lives in storage. Hydrate
    // it so (1) the refresh token is actually found and (2) the rotation
    // below is persisted — dropping the rotated refresh token kept the
    // now-revoked pre-rotation token on disk, and the next restart's
    // refresh tripped reuse detection → wiped session (keep-signed-in
    // logout-on-restart, part b). Only hydrate when a refresh token is
    // actually found — never fabricate state.
    if (!this.authState) {
      const stored = await this.loadAuthFromStorage();
      if (stored?.refreshToken) {
        this.authState = stored;
      } else {
        const persisted = await this.loadPersistedAuthLocal();
        if (persisted?.refreshToken) {
          this.authState = {
            accessToken: "",
            refreshToken: persisted.refreshToken,
            expiresAt: 0,
            user: persisted.user,
          };
        }
      }
    }

    const refreshToken = token ?? this.authState?.refreshToken;
    if (!refreshToken) {
      throw new PagePocketAuthError("No refresh token available");
    }

    const res = await this.unauthenticatedFetch("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      await this.clearAuth();
      throw new PagePocketAuthError("Token refresh failed");
    }

    const data = (await res.json()) as RefreshResponse;
    const access_token = data.access_token;

    if (this.authState) {
      this.authState = {
        ...this.authState,
        accessToken: access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_at,
      };
      await this.persistAuth();
      // easier-auth D1/D8 (task 1.6): when keep-signed-in is active (a
      // persisted copy exists on disk), the rotated refresh token replaces
      // the old copy in chrome.storage.local too. The access token still
      // never leaves session storage.
      if (await this.hasPersistedAuthLocal()) {
        await this.persistAuthLocal();
      }
    }

    return access_token;
  }

  async logout(): Promise<void> {
    try {
      if (this.authState) {
        await this.unauthenticatedFetch("/api/v1/auth/logout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.authState.accessToken}`,
          },
        });
      }
    } finally {
      await this.clearAuth();
    }
  }

  // -----------------------------------------------------------------------
  // Authenticated fetch (3.3)
  // -----------------------------------------------------------------------

  private async authenticatedFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const token = await this.ensureAccessToken();

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);

    const url = `${this.baseUrl}${path}`;
    const effectiveSignal =
      init.signal ?? AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS);
    let res = await fetch(url, { ...init, headers, signal: effectiveSignal });

    if (res.status === 401) {
      const newToken = await this.refreshWithMutex();
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("Authorization", `Bearer ${newToken}`);

      const retrySignal = init.signal
        ? withTimeout(undefined, UPLOAD_TIMEOUT_MS)
        : AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS);
      res = await fetch(url, {
        ...init,
        headers: retryHeaders,
        signal: retrySignal,
      });

      if (res.status === 401) {
        await this.clearAuth();
        throw new PagePocketAuthError(
          "Authentication failed after token refresh",
        );
      }
    }

    return res;
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.authState) {
      if (Date.now() < this.authState.expiresAt * 1000) {
        return this.authState.accessToken;
      }
      return this.refreshWithMutex();
    }

    const stored = await this.loadAuthFromStorage();
    if (stored) {
      this.authState = stored;
      if (Date.now() < stored.expiresAt * 1000) {
        return stored.accessToken;
      }
      return this.refreshWithMutex();
    }

    throw new PagePocketAuthError("Not authenticated");
  }

  private refreshWithMutex(): Promise<string> {
    if (this.refreshLock) {
      return this.refreshLock;
    }

    this.refreshLock = (async () => {
      try {
        return await this.refreshToken();
      } finally {
        this.refreshLock = null;
      }
    })();

    return this.refreshLock;
  }

  // -----------------------------------------------------------------------
  // Ingest page (3.4)
  // -----------------------------------------------------------------------

  async ingestPage(params: IngestPageParams): Promise<IngestResponse> {
    const formData = new FormData();
    formData.append("url", params.url);
    if (params.title) {
      formData.append("title", params.title);
    }
    formData.append("html_content", params.htmlContent, "page.html");
    if (params.extensionJobId) {
      formData.append("extension_job_id", params.extensionJobId);
    }
    if (params.plan) {
      formData.append("plan", params.plan);
    }

    if (params.assets) {
      for (const asset of params.assets) {
        formData.append("assets", asset.data, asset.filename);
      }
    }

    if (params.onUploadProgress && typeof XMLHttpRequest !== "undefined") {
      const result = await this.xhrUpload(
        "/api/v1/archive/pages/ingest",
        formData,
        withTimeout(params.signal, UPLOAD_TIMEOUT_MS),
        params.onUploadProgress,
      );

      if (result.status === 402) {
        throw new PagePocketQuotaError("Storage quota exceeded");
      }
      if (result.status >= 400) {
        this.throwForErrorStatus(result.status, result.body, "ingestPage");
      }

      return JSON.parse(result.body) as IngestResponse;
    }

    // Service worker path: fetch + ReadableStream for progress (no XHR).
    // The duplex:"half" ReadableStream approach requires HTTP/2 which
    // uvicorn doesn't serve, so we report a one-shot 100% after completion
    // and fall through to the regular authenticatedFetch.
    if (params.onUploadProgress) {
      const res = await this.authenticatedFetch(
        "/api/v1/archive/pages/ingest",
        {
          method: "POST",
          body: formData,
          signal: withTimeout(params.signal, UPLOAD_TIMEOUT_MS),
        },
      );

      if (res.status === 402) {
        throw new PagePocketQuotaError("Storage quota exceeded");
      }
      if (!res.ok) {
        await this.throwForStatus(res, "ingestPage");
      }

      params.onUploadProgress(1, 1);
      return (await res.json()) as IngestResponse;
    }

    const res = await this.authenticatedFetch("/api/v1/archive/pages/ingest", {
      method: "POST",
      body: formData,
      signal: withTimeout(params.signal, UPLOAD_TIMEOUT_MS),
    });

    if (res.status === 402) {
      throw new PagePocketQuotaError("Storage quota exceeded");
    }
    if (!res.ok) {
      await this.throwForStatus(res, "ingestPage");
    }

    return (await res.json()) as IngestResponse;
  }

  // -----------------------------------------------------------------------
  // Health check (3.5)
  // -----------------------------------------------------------------------

  async checkHealth(): Promise<HealthResponse> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/health`, {
        method: "GET",
      });

      if (!res.ok) {
        throw new PagePocketUploadError(
          `Health check returned ${res.status}`,
          res.status,
        );
      }

      return (await res.json()) as HealthResponse;
    } catch (err) {
      if (err instanceof PagePocketUploadError) throw err;
      throw new PagePocketUploadError(
        `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Unauthenticated fetch helper
  // -----------------------------------------------------------------------

  private async unauthenticatedFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException) throw err;
      throw new PagePocketUploadError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // XHR upload with progress tracking
  // -----------------------------------------------------------------------

  private async xhrUpload(
    path: string,
    formData: FormData,
    signal: AbortSignal | undefined,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<{ status: number; body: string }> {
    const token = await this.ensureAccessToken();
    const url = `${this.baseUrl}${path}`;

    const attempt = async (
      accessToken: string,
    ): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            onProgress(event.loaded, event.total);
          }
        };

        const onAbort = () => xhr.abort();
        if (signal) {
          if (signal.aborted) xhr.abort();
          signal.addEventListener("abort", onAbort, { once: true });
        }

        xhr.onload = () => {
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve({ status: xhr.status, body: xhr.responseText });
        };

        xhr.onerror = () => {
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(new PagePocketUploadError("Network error during upload"));
        };

        xhr.onabort = () => {
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(new DOMException("The user aborted a request.", "AbortError"));
        };

        xhr.ontimeout = () => {
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(new PagePocketUploadError("Upload timed out"));
        };

        xhr.send(formData);
      });

    let result = await attempt(token);

    if (result.status === 401) {
      const newToken = await this.refreshWithMutex();
      result = await attempt(newToken);

      if (result.status === 401) {
        await this.clearAuth();
        throw new PagePocketAuthError(
          "Authentication failed after token refresh",
        );
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Error helpers
  // -----------------------------------------------------------------------

  private throwForErrorStatus(
    status: number,
    bodyText: string,
    operation: string,
  ): never {
    let detail: string;
    try {
      const json = JSON.parse(bodyText);
      const d = json?.detail;
      detail =
        (typeof d === "string" ? d : (d?.message ?? d?.error ?? d?.detail)) ??
        json?.message ??
        JSON.stringify(json);
    } catch {
      detail = bodyText || `HTTP ${status}`;
    }

    if (status === 401) {
      throw new PagePocketAuthError(`${operation}: ${detail}`);
    }
    if (status === 402) {
      throw new PagePocketQuotaError(`${operation}: ${detail}`);
    }

    throw new PagePocketUploadError(
      `${operation}: ${status} — ${detail}`,
      status,
    );
  }

  private async throwForStatus(
    res: Response,
    operation: string,
  ): Promise<never> {
    const bodyText = await res.text().catch(() => "");
    this.throwForErrorStatus(res.status, bodyText, operation);
  }

  // -----------------------------------------------------------------------
  // Token persistence (chrome.storage.session + opt-in local mirror —
  // easier-auth D1, supersedes the D11 session-only decision)
  //
  // The access token and its expiry ALWAYS stay in chrome.storage.session
  // (memory-only, cleared when the browser closes). When the user opts in
  // via "Keep me signed in on this device", the refresh token + user record
  // are additionally mirrored to chrome.storage.local so the session
  // survives browser restarts. This layer is the single writer for auth
  // state; the password is never persisted anywhere.
  // -----------------------------------------------------------------------

  private async saveAuth(
    data: AuthResponse,
    keepSignedIn: boolean,
  ): Promise<PagePocketAuthState> {
    const state: PagePocketAuthState = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      user: data.user,
    };
    this.authState = state;
    await this.persistAuth();
    if (keepSignedIn) {
      await this.persistAuthLocal();
    } else {
      // easier-auth D3: a keep-signed-in-OFF login must not leave a
      // persisted session behind — drop any stale on-disk copies.
      await this.clearPersistedAuthLocal();
    }
    return state;
  }

  private async persistAuth(): Promise<void> {
    try {
      if (!chrome?.storage?.session) return;
      await chrome.storage.session.set({
        [PAGEPOCKET_AUTH_STORAGE_KEY]: this.authState,
      });
    } catch {
      // Non-critical — cached in memory
    }
  }

  /** Mirror the keep-signed-in slice (refresh token + user) to disk. */
  private async persistAuthLocal(): Promise<void> {
    if (!this.authState) return;
    try {
      if (!chrome?.storage?.local) return;
      const persisted: PagePocketPersistedAuth = {
        refreshToken: this.authState.refreshToken,
        user: this.authState.user,
      };
      await chrome.storage.local.set({
        [PAGEPOCKET_AUTH_PERSISTED_KEY]: persisted,
      });
    } catch {
      // Non-critical — the session copy is unaffected
    }
  }

  /** Read the keep-signed-in slice from disk (null when absent). */
  private async loadPersistedAuthLocal(): Promise<PagePocketPersistedAuth | null> {
    try {
      if (!chrome?.storage?.local) return null;
      const result = await chrome.storage.local.get(
        PAGEPOCKET_AUTH_PERSISTED_KEY,
      );
      return (
        (result[PAGEPOCKET_AUTH_PERSISTED_KEY] as PagePocketPersistedAuth) ??
        null
      );
    } catch {
      return null;
    }
  }

  /** Keep-signed-in is active iff a persisted slice exists on disk. */
  private async hasPersistedAuthLocal(): Promise<boolean> {
    return (await this.loadPersistedAuthLocal()) !== null;
  }

  /**
   * Remove the keep-signed-in slice and the mirrored cloud binding from
   * disk. Called on logout, refresh failure, and keep-signed-in-OFF logins
   * (easier-auth D3/D8) — never on a mere storage read.
   */
  private async clearPersistedAuthLocal(): Promise<void> {
    try {
      if (!chrome?.storage?.local) return;
      await chrome.storage.local.remove([
        PAGEPOCKET_AUTH_PERSISTED_KEY,
        PAGEPOCKET_CLOUD_BINDING_KEY,
      ]);
    } catch {
      // Non-critical
    }
  }

  private async clearAuth(): Promise<void> {
    this.authState = null;
    try {
      if (!chrome?.storage?.session) return;
      await chrome.storage.session.remove(PAGEPOCKET_AUTH_STORAGE_KEY);
      // easier-auth D8: the cloud binding follows the refresh token
      // lifecycle — drop it from session storage together with the auth.
      await chrome.storage.session.remove(PAGEPOCKET_CLOUD_BINDING_KEY);
    } catch {
      // Non-critical
    }
    // Logout / refresh failure must also wipe the persisted keep-signed-in
    // session and the mirrored binding from disk (task 1.5).
    await this.clearPersistedAuthLocal();
  }

  private async loadAuthFromStorage(): Promise<PagePocketAuthState | null> {
    await this.scrubLegacyLocalAuth();
    try {
      if (!chrome?.storage?.session) return null;
      const result = await chrome.storage.session.get(
        PAGEPOCKET_AUTH_STORAGE_KEY,
      );
      return (
        (result[PAGEPOCKET_AUTH_STORAGE_KEY] as PagePocketAuthState) ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * easier-auth D1/D3 (tasks 1.2/1.4): restore a keep-signed-in session
   * after a browser restart. Reads the persisted refresh token + user from
   * chrome.storage.local and mints a fresh access token via the normal
   * refresh flow (which also rotates and re-persists the refresh token —
   * task 1.6). Returns the restored auth state, or null when nothing is
   * persisted or the refresh fails (a failed refresh clears BOTH storage
   * areas via clearAuth, so a revoked token can't linger on disk).
   */
  async restorePersistedSession(): Promise<PagePocketAuthState | null> {
    const persisted = await this.loadPersistedAuthLocal();
    if (!persisted) return null;

    // Hydrate the in-memory state from the persisted slice. The access
    // token is intentionally empty: refreshWithMutex sees the expired
    // session and mints a real one before any authenticated call.
    this.authState = {
      accessToken: "",
      refreshToken: persisted.refreshToken,
      expiresAt: 0,
      user: persisted.user,
    };

    try {
      // Serialize through the refresh mutex (never refreshToken directly):
      // two mounted components can both call initializeFromStorage →
      // restorePersistedSession. Two concurrent refreshes with the SAME
      // refresh token trip the backend's reuse detection, which revokes the
      // whole token family → the second refresh fails → clearAuth() wipes
      // the session → logged out on every restart. The mutex makes the
      // second caller join the in-flight refresh (or, if it lands after the
      // first completed, re-read the already-rotated
      // this.authState.refreshToken at execution time).
      await this.refreshWithMutex();
    } catch {
      return null;
    }
    return this.authState;
  }

  /**
   * Remove the auth state persisted by pre-D11 versions in
   * chrome.storage.local (on disk). That legacy `pagepocket_auth` record
   * contains an ACCESS TOKEN, which must never live on disk — the migration
   * wipe stays. It targets only the legacy key: the opt-in keep-signed-in
   * slice uses a dedicated key (pagepocket_auth_persisted) that holds no
   * access token and is cleared solely on logout / refresh failure /
   * keep-signed-in-OFF login (D3), never here.
   */
  private async scrubLegacyLocalAuth(): Promise<void> {
    try {
      if (!chrome?.storage?.local) return;
      await chrome.storage.local.remove(PAGEPOCKET_AUTH_STORAGE_KEY);
    } catch {
      // Non-critical
    }
  }
}

/** Singleton instance for use throughout the extension background context. */
export const pagepocketClient = new PagePocketClient();
