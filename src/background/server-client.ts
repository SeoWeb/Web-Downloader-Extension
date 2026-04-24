/**
 * ServerClient — extension-side API client for the Python microservice.
 *
 * Reads `VITE_SERVER_URL` at build time and encapsulates all HTTP
 * communication: session CRUD, HTML/resource upload, finalization,
 * status polling, health checks, and auto-registration with a
 * promise-based mutex for concurrent 401 handling.
 *
 * Tasks 8.1–8.14 of the server-side-microservice migration.
 */

// ---------------------------------------------------------------------------
// Error classes (task 8.12)
// ---------------------------------------------------------------------------

export class ServerUnavailableError extends Error {
  public readonly statusCode?: number;
  public readonly originalCause?: unknown;

  constructor(
    message: string,
    cause?: unknown,
    statusCode?: number,
  ) {
    super(message);
    this.name = "ServerUnavailableError";
    this.originalCause = cause ?? undefined;
    this.statusCode = statusCode;
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AssemblyTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyTimeoutError";
  }
}

/**
 * HTTP error with status code, thrown by ServerClient for 4xx responses.
 * Includes `retryAfter` (seconds) for 429 Rate Limit responses.
 */
export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly retryAfter?: number;

  constructor(message: string, statusCode: number, retryAfter?: number) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionOptions {
  singleFile?: boolean;
  retentionDays?: number;
}

export interface CreateSessionResponse {
  id: string;
  url: string;
  status: string;
  options?: Record<string, unknown>;
  html_chunks: number;
  resources_discovered: number | null;
  resources_received: number;
  created_at: string;
  expires_at: string;
  api_version: string;
}

export interface UploadHtmlChunkResponse {
  chunk_id: string;
  chunk_count: number;
  total_size: number;
  deduplicated: boolean;
  api_version: string;
}

export interface ScrapeCompleteResponse {
  id: string;
  status: string;
  message: string;
  api_version: string;
}

export interface UploadResourceResponse {
  resource_id: string;
  local_path: string | null;
  size: number;
  deduplicated: boolean;
  api_version: string;
}

export interface FilenameMapResponse {
  mappings_count: number;
  api_version: string;
}

export interface UploadContentResponse {
  message: string;
  size: number;
  api_version: string;
}

export interface FinalizeResponse {
  id: string;
  status: string;
  message: string;
  api_version: string;
}

export interface SessionStatusResponse {
  id: string;
  status: string;
  url: string;
  html_chunks: number;
  resources_discovered: number | null;
  resources_received: number;
  total_size: number;
  assembly_phase: string | null;
  assembly_progress_pct: number | null;
  download_url: string | null;
  output_type: string | null;
  output_size: number | null;
  error_message: string | null;
  api_version: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  mysql: string;
  storage_available_mb: number;
  storage_total_mb: number;
  description: string | null;
  api_version: string;
}

// ---------------------------------------------------------------------------
// Text-based MIME types that should be gzip-compressed before upload
// ---------------------------------------------------------------------------

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/javascript",
  "application/json",
  "application/xml",
];

function isTextMimeType(contentType: string): boolean {
  return TEXT_MIME_PREFIXES.some(
    (prefix) => contentType.startsWith(prefix),
  );
}

// ---------------------------------------------------------------------------
// ServerClient
// ---------------------------------------------------------------------------

const API_KEY_STORAGE_KEY = "server_api_key";
const EXTENSION_INSTANCE_ID_KEY = "server_extension_instance_id";
const MAX_REGISTRATION_ATTEMPTS = 3;

export class ServerClient {
  private readonly serverUrl: string;
  private apiKey: string | null = null;

  /** Promise-based mutex so concurrent 401s trigger at most one re-registration */
  private registrationLock: Promise<string> | null = null;

  constructor() {
    this.serverUrl = (
      import.meta.env.VITE_SERVER_URL as string | undefined
    )?.replace(/\/+$/, "") ?? "";

    if (this.serverUrl) {
      // S6 note: warn if using http:// with a non-loopback host
      this.warnIfHttp();
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** (8.2) Create a new download session on the server. */
  async createSession(
    url: string,
    options?: SessionOptions,
  ): Promise<string> {
    const body: Record<string, unknown> = { url };
    if (options) {
      body.options = {
        singleFile: options.singleFile ?? false,
        retentionDays: options.retentionDays,
      };
    }

    const res = await this.authenticatedFetch("/api/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await this.throwForStatus(res, "createSession");
    }

    const data = (await res.json()) as CreateSessionResponse;
    return data.id;
  }

  /** (8.3) Upload an HTML chunk to the server. */
  async uploadHtmlChunk(
    sessionId: string,
    html: string,
    scrollIndex: number,
    pageType?: "main" | "linked",
    pageUrl?: string,
  ): Promise<UploadHtmlChunkResponse> {
    const body: Record<string, unknown> = {
      html,
      scrollIndex,
      pageType: pageType ?? "main",
    };
    if (pageUrl) {
      body.pageUrl = pageUrl;
    }

    const res = await this.authenticatedFetch(
      `/api/v1/sessions/${sessionId}/html`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      await this.throwForStatus(res, "uploadHtmlChunk");
    }

    return (await res.json()) as UploadHtmlChunkResponse;
  }

  /** (8.4) Signal that all HTML chunks have been uploaded. */
  async scrapeComplete(
    sessionId: string,
    resourceCount: number,
  ): Promise<ScrapeCompleteResponse> {
    return this.withRetry(async () => {
      const res = await this.authenticatedFetch(
        `/api/v1/sessions/${sessionId}/scrape-complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resourceCount }),
        },
      );

      if (!res.ok) {
        await this.throwForStatus(res, "scrapeComplete");
      }

      return (await res.json()) as ScrapeCompleteResponse;
    });
  }

  /** (8.5) Upload a resource file to the server via multipart form-data. */
  async uploadResource(
    sessionId: string,
    path: string,
    blob: Blob,
    originalUrl: string,
    contentType: string,
    signal?: AbortSignal,
    onUploadProgress?: (loaded: number, total: number) => void,
  ): Promise<UploadResourceResponse> {
    let uploadBlob: Blob;
    let gzipped = false;

    // Gzip compress text-based MIME types
    if (isTextMimeType(contentType)) {
      try {
        const buffer = await blob.arrayBuffer();
        const cs = new CompressionStream("gzip");
        const writer = cs.writable.getWriter();
        const reader = cs.readable.getReader();

        // Write and close in the background
        const writePromise = writer.write(buffer).then(() => writer.close());

        // Collect compressed output
        const chunks: Uint8Array[] = [];
        let totalLength = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalLength += value.length;
        }
        await writePromise;

        const compressed = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          compressed.set(chunk, offset);
          offset += chunk.length;
        }
        uploadBlob = new Blob([compressed]);
        gzipped = true;
      } catch {
        // Fall back to uncompressed if gzip fails
        uploadBlob = blob;
      }
    } else {
      uploadBlob = blob;
    }

    const formData = new FormData();
    formData.append("file", uploadBlob, path.split("/").pop() ?? "file");
    formData.append("path", path);
    formData.append("originalUrl", originalUrl);
    formData.append("contentType", contentType);

    const extraHeaders: Record<string, string> = {};
    if (gzipped) {
      extraHeaders["X-Content-Gzipped"] = "true";
    }

    // Use XHR when progress tracking is requested AND XHR is available
    // (Chrome MV3 service workers don't have XMLHttpRequest)
    if (onUploadProgress && typeof XMLHttpRequest !== "undefined") {
      const result = await this.xhrUpload(
        `/api/v1/sessions/${sessionId}/resources`,
        formData,
        extraHeaders,
        signal,
        onUploadProgress,
      );

      if (result.status >= 400) {
        this.throwForErrorStatus(
          result.status,
          result.body,
          result.headers,
          "uploadResource",
        );
      }

      return JSON.parse(result.body) as UploadResourceResponse;
    }

    // Fallback to fetch when no progress callback is needed
    const init: RequestInit = {
      method: "POST",
      headers: extraHeaders,
      body: formData,
    };
    if (signal) {
      init.signal = signal;
    }

    const res = await this.authenticatedFetch(
      `/api/v1/sessions/${sessionId}/resources`,
      init,
    );

    if (!res.ok) {
      await this.throwForStatus(res, "uploadResource");
    }

    return (await res.json()) as UploadResourceResponse;
  }

  /** (8.6) Upload or merge a filename map on the server. */
  async uploadFilenameMap(
    sessionId: string,
    map: Record<string, string>,
  ): Promise<FilenameMapResponse> {
    return this.withRetry(async () => {
      const res = await this.authenticatedFetch(
        `/api/v1/sessions/${sessionId}/filename-map`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ map }),
        },
      );

      if (!res.ok) {
        await this.throwForStatus(res, "uploadFilenameMap");
      }

      return (await res.json()) as FilenameMapResponse;
    });
  }

  /** (8.7) Upload text content for `content.txt` inclusion in ZIP. */
  async uploadContent(
    sessionId: string,
    text: string,
  ): Promise<UploadContentResponse> {
    return this.withRetry(async () => {
      const res = await this.authenticatedFetch(
        `/api/v1/sessions/${sessionId}/content`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );

      if (!res.ok) {
        await this.throwForStatus(res, "uploadContent");
      }

      return (await res.json()) as UploadContentResponse;
    });
  }

  /** (8.8) Finalize a session — trigger assembly pipeline. */
  async finalizeSession(
    sessionId: string,
  ): Promise<FinalizeResponse> {
    return this.withRetry(async () => {
      const res = await this.authenticatedFetch(
        `/api/v1/sessions/${sessionId}/finalize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );

      // (8.13) Handle 409 Conflict: treat as success.
      // The server returns 409 if the session is already assembling or ready,
      // which means finalization has already happened — proceed to status polling.
      if (res.status === 409) {
        const data = await res.json().catch(() => null);
        return {
          id: sessionId,
          status: data?.current_status ?? "assembling",
          message: data?.message ?? "Session already finalizing",
          api_version: "v1",
        } satisfies FinalizeResponse;
      }

      if (!res.ok) {
        await this.throwForStatus(res, "finalizeSession");
      }

      return (await res.json()) as FinalizeResponse;
    });
  }

  /** (8.9) Get the current status of a session. */
  async getSessionStatus(
    sessionId: string,
  ): Promise<SessionStatusResponse> {
    const res = await this.authenticatedFetch(
      `/api/v1/sessions/${sessionId}/status`,
    );

    if (!res.ok) {
      await this.throwForStatus(res, "getSessionStatus");
    }

    return (await res.json()) as SessionStatusResponse;
  }

  /** (8.10) Check server health without authentication. */
  async checkHealth(): Promise<HealthResponse> {
    try {
      const res = await fetch(`${this.serverUrl}/api/v1/health`, {
        method: "GET",
      });

      if (!res.ok) {
        throw new ServerUnavailableError(
          `Health check returned ${res.status}`,
          undefined,
          res.status,
        );
      }

      return (await res.json()) as HealthResponse;
    } catch (err) {
      if (err instanceof ServerUnavailableError) throw err;
      throw new ServerUnavailableError(
        "Server is unavailable. Please try again later.",
        err,
      );
    }
  }

  /** Delete a session on the server. */
  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.authenticatedFetch(
      `/api/v1/sessions/${sessionId}`,
      { method: "DELETE" },
    );

    if (!res.ok) {
      await this.throwForStatus(res, "deleteSession");
    }
  }

  // -----------------------------------------------------------------------
  // Auto-registration (task 8.11)
  // -----------------------------------------------------------------------

  /**
   * Ensure we have an API key, loading from chrome.storage or registering
   * with the server as needed. Uses a promise-based mutex so concurrent
   * 401 responses trigger at most one re-registration call.
   */
  private async ensureApiKey(): Promise<string> {
    // Return cached key if available
    if (this.apiKey) return this.apiKey;

    // Try loading from chrome.storage
    const stored = await this.loadApiKeyFromStorage();
    if (stored) {
      this.apiKey = stored;
      return this.apiKey;
    }

    // Register — use mutex to prevent concurrent registrations
    return this.registerWithMutex();
  }

  /**
   * Promise-based mutex registration: if a registration is already
   * in progress, all callers await the same promise. At most one
   * POST /auth/register call is made regardless of concurrency.
   */
  private registerWithMutex(): Promise<string> {
    if (this.registrationLock) {
      return this.registrationLock;
    }

    this.registrationLock = (async () => {
      try {
        const key = await this.register();
        return key;
      } finally {
        this.registrationLock = null;
      }
    })();

    return this.registrationLock;
  }

  /**
   * Register with the server to obtain an API key.
   * Stores the key in chrome.storage.local for future use.
   * Retries up to MAX_REGISTRATION_ATTEMPTS with exponential backoff.
   */
  private async register(): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_REGISTRATION_ATTEMPTS; attempt++) {
      try {
        // Generate or retrieve extension instance ID for idempotent registration
        const instanceId = await this.getOrCreateInstanceId();

        const res = await fetch(
          `${this.serverUrl}/api/v1/auth/register`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: instanceId }),
          },
        );

        if (!res.ok) {
          const errorBody = await res.text().catch(() => "");
          throw new Error(
            `Registration failed: ${res.status} ${errorBody}`,
          );
        }

        const data = (await res.json()) as {
          api_key: string;
          client_id: string;
        };

        this.apiKey = data.api_key;
        await this.saveApiKeyToStorage(data.api_key);
        return this.apiKey;
      } catch (err) {
        lastError =
          err instanceof Error ? err : new Error(String(err));

        if (attempt < MAX_REGISTRATION_ATTEMPTS - 1) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new AuthenticationError(
      `Auto-registration failed after ${MAX_REGISTRATION_ATTEMPTS} attempts: ${lastError?.message}`,
    );
  }

  // -----------------------------------------------------------------------
  // Authenticated fetch with auto re-registration on 401
  // -----------------------------------------------------------------------

  /**
   * Perform an authenticated fetch. On 401, attempts re-registration
   * once and retries. Concurrent 401s share the same re-registration
   * call via the promise-based mutex.
   */
  private async authenticatedFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const apiKey = await this.ensureApiKey();

    const headers = new Headers(init.headers);
    headers.set("X-API-Key", apiKey);

    // Don't override Content-Type if already set (e.g. for FormData)
    if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    const url = `${this.serverUrl}${path}`;
    let res = await fetch(url, { ...init, headers });

    // On 401, attempt re-registration and retry once
    if (res.status === 401) {
      // Clear cached key
      this.apiKey = null;

      // Re-register via mutex — concurrent callers share the same registration
      const newKey = await this.registerWithMutex();

      // Retry with the new key
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("X-API-Key", newKey);
      if (!retryHeaders.has("Content-Type") && init.body && typeof init.body === "string") {
        retryHeaders.set("Content-Type", "application/json");
      }

      res = await fetch(url, { ...init, headers: retryHeaders });

      // If the retry also returns 401, it's a permanent auth failure
      if (res.status === 401) {
        throw new AuthenticationError(
          "Authentication failed after re-registration",
        );
      }
    }

    return res;
  }

  // -----------------------------------------------------------------------
  // Retry logic for control-plane calls (task 8.14)
  // -----------------------------------------------------------------------

  /**
   * Retry a control-plane call up to 3 times with exponential backoff
   * (1s, 2s, 4s) on 5xx errors or network timeouts.
   * No retry on 4xx errors (which indicate client-side logic errors).
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        // Convert network-level TypeErrors (fetch failures) to ServerUnavailableError
        // so they are eligible for retry. Task 8.14 requires retry on "network timeouts".
        if (err instanceof TypeError) {
          lastError = new ServerUnavailableError(
            `Network error: ${err.message}`,
            err,
          );
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }

        // Never retry AuthenticationError — these are permanent
        if (lastError instanceof AuthenticationError) {
          throw lastError;
        }

        // Determine if the error is retryable (5xx server error or network failure)
        const isRetryable =
          lastError instanceof ServerUnavailableError &&
          (lastError.statusCode === undefined || // network-level (no HTTP status)
            lastError.statusCode >= 500);         // 5xx server error

        // Non-retryable: 4xx client errors and other non-server errors
        if (!isRetryable) {
          throw lastError;
        }

        if (attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new ServerUnavailableError(
      `Request failed after ${MAX_RETRIES} retries: ${lastError?.message}`,
      lastError ?? undefined,
    );
  }

  // -----------------------------------------------------------------------
  // Error handling helpers
  // -----------------------------------------------------------------------

  /**
   * Throw an appropriate error for an HTTP error status.
   * Works with both fetch Response and XHR result data.
   */
  private throwForErrorStatus(
    status: number,
    bodyText: string,
    headers: Record<string, string>,
    operation: string,
  ): never {
    let detail: string;
    try {
      const json = JSON.parse(bodyText);
      detail =
        json?.detail?.message ??
        json?.detail?.error ??
        json?.message ??
        JSON.stringify(json);
    } catch {
      detail = bodyText || `HTTP ${status}`;
    }

    if (status === 401) {
      throw new AuthenticationError(
        `${operation}: Authentication failed — ${detail}`,
      );
    }

    if (status >= 500) {
      throw new ServerUnavailableError(
        `${operation}: Server error (${status}) — ${detail}`,
        undefined,
        status,
      );
    }

    // 429 Rate Limit — include Retry-After header if present
    if (status === 429) {
      const retryAfterHeader = headers["retry-after"];
      let retryAfter: number | undefined;
      if (retryAfterHeader) {
        const parsed = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsed) && parsed > 0) {
          retryAfter = parsed;
        }
      }
      throw new HttpError(
        `${operation}: 429 — ${detail}`,
        429,
        retryAfter,
      );
    }

    // 4xx errors (except 401 and 429 handled above)
    throw new HttpError(
      `${operation}: ${status} — ${detail}`,
      status,
    );
  }

  /**
   * Throw an appropriate error from a fetch Response.
   * Delegates to throwForErrorStatus after extracting body and headers.
   */
  private async throwForStatus(
    res: Response,
    operation: string,
  ): Promise<never> {
    const bodyText = await res.text().catch(() => "");
    const hdrs: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      hdrs[key.toLowerCase()] = value;
    });
    this.throwForErrorStatus(res.status, bodyText, hdrs, operation);
  }

  // -----------------------------------------------------------------------
  // XHR upload with progress tracking (W1 fix)
  // -----------------------------------------------------------------------

  /**
   * Upload via XMLHttpRequest for real-time progress tracking.
   * fetch() does not support upload progress events; XHR's
   * `upload.onprogress` provides loaded/total bytes in real time.
   *
   * Handles auth (X-API-Key), 401 re-registration, AbortSignal,
   * and progress reporting.
   */
  private async xhrUpload(
    path: string,
    formData: FormData,
    extraHeaders: Record<string, string>,
    signal?: AbortSignal,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    const apiKey = await this.ensureApiKey();
    const url = `${this.serverUrl}${path}`;

    const attempt = async (
      key: string,
    ): Promise<{
      status: number;
      body: string;
      headers: Record<string, string>;
    }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);

        // Set auth + extra headers
        xhr.setRequestHeader("X-API-Key", key);
        for (const [hKey, hValue] of Object.entries(extraHeaders)) {
          xhr.setRequestHeader(hKey, hValue);
        }

        // Real-time upload progress (W1 fix)
        if (onProgress) {
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              onProgress(event.loaded, event.total);
            }
          };
        }

        // Abort signal support
        const onAbort = () => xhr.abort();
        if (signal) {
          if (signal.aborted) {
            xhr.abort();
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        xhr.onload = () => {
          if (signal) signal.removeEventListener("abort", onAbort);

          const hdrs: Record<string, string> = {};
          const headerStr = xhr.getAllResponseHeaders().trim();
          if (headerStr) {
            for (const line of headerStr.split("\r\n")) {
              const idx = line.indexOf(": ");
              if (idx > 0) {
                hdrs[line.substring(0, idx).toLowerCase()] =
                  line.substring(idx + 2);
              }
            }
          }
          resolve({ status: xhr.status, body: xhr.responseText, headers: hdrs });
        };

        xhr.onerror = () => {
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(
            new ServerUnavailableError(
              "Network error during upload",
              undefined,
              undefined,
            ),
          );
        };

        xhr.onabort = () => {
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(new DOMException("The user aborted a request.", "AbortError"));
        };

        xhr.ontimeout = () => {
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(
            new ServerUnavailableError(
              "Upload timed out",
              undefined,
              undefined,
            ),
          );
        };

        xhr.send(formData);
      });

    // First attempt with current API key
    let result = await attempt(apiKey);

    // Handle 401 — re-register and retry once
    if (result.status === 401) {
      this.apiKey = null;
      const newKey = await this.registerWithMutex();
      result = await attempt(newKey);

      if (result.status === 401) {
        throw new AuthenticationError(
          "Authentication failed after re-registration",
        );
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // chrome.storage helpers
  // -----------------------------------------------------------------------

  private async loadApiKeyFromStorage(): Promise<string | null> {
    try {
      if (!chrome?.storage?.local) return null;
      const result = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
      return result[API_KEY_STORAGE_KEY] ?? null;
    } catch {
      return null;
    }
  }

  private async saveApiKeyToStorage(key: string): Promise<void> {
    try {
      if (!chrome?.storage?.local) return;
      await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: key });
    } catch {
      // Non-critical — the key is cached in memory
    }
  }

  private async getOrCreateInstanceId(): Promise<string> {
    try {
      if (!chrome?.storage?.local) {
        return `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }

      const result = await chrome.storage.local.get(
        EXTENSION_INSTANCE_ID_KEY,
      );
      if (result[EXTENSION_INSTANCE_ID_KEY]) {
        return result[EXTENSION_INSTANCE_ID_KEY] as string;
      }

      const id = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await chrome.storage.local.set({ [EXTENSION_INSTANCE_ID_KEY]: id });
      return id;
    } catch {
      return `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  // -----------------------------------------------------------------------
  // HTTPS warning (S6 note from task 8.10)
  // -----------------------------------------------------------------------

  private warnIfHttp(): void {
    try {
      const url = new URL(this.serverUrl);
      if (url.protocol === "http:") {
        const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(
          url.hostname,
        );
        if (!isLoopback) {
          console.warn(
            `[ServerClient] WARNING: Server URL uses http:// with a non-loopback host (${url.hostname}). ` +
            "Chrome blocks mixed-content downloads from HTTP remote origins. " +
            "HTTPS is mandatory for non-localhost deployments.",
          );
        }
      }
    } catch {
      // Invalid URL — ignore
    }
  }
}

/** Singleton instance for use throughout the extension background context. */
export const serverClient = new ServerClient();
