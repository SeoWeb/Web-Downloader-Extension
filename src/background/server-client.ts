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

  constructor(message: string, cause?: unknown, statusCode?: number) {
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
 * Thrown at client construction when the configured base URL is invalid or
 * would transmit auth tokens in cleartext (plain HTTP on a non-loopback host).
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

// ---------------------------------------------------------------------------
// Transport security helpers (D11 / task 7.4 — fail fast, not warn)
// ---------------------------------------------------------------------------

/** Hosts for which plain HTTP is permitted (local development). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Check whether a URL hostname is a loopback address (localhost, 127.0.0.1,
 * ::1). Accepts the bracketed form (`[::1]`) that `URL.hostname` returns for
 * IPv6 literals.
 */
export function isLoopbackHost(hostname: string): boolean {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return LOOPBACK_HOSTS.has(bare.toLowerCase());
}

/**
 * Enforce transport security for a base URL at configuration time.
 *
 * Plain `http://` is rejected for non-loopback hosts — tokens must never be
 * transmitted in cleartext. Loopback hosts (localhost / 127.0.0.1 / [::1])
 * stay allowed for local development.
 *
 * @throws ConfigurationError when the URL is unparseable or insecure.
 */
export function assertSecureBaseUrl(rawUrl: string, label: string): void {
  if (!rawUrl) return; // Unconfigured — callers guard that separately

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigurationError(
      `${label}: invalid URL "${rawUrl}" — expected an absolute http(s):// URL`,
    );
  }

  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new ConfigurationError(
      `${label}: plain HTTP is not allowed for non-loopback host ` +
        `(${url.hostname}) — auth tokens would be transmitted in cleartext. ` +
        "Use HTTPS, or point at http://localhost / 127.0.0.1 / [::1] for " +
        "local development.",
    );
  }
}

/**
 * Self-heal a server-returned URL that came back with a plain `http://`
 * scheme on the SAME host as the configured server.
 *
 * This repairs a server misconfigured behind a TLS-terminating proxy: the
 * monolith builds absolute URLs (e.g. `download_url`) from uvicorn's own
 * request scheme — `http://` — while nginx serves the public `https://`
 * origin. The strict guard would then reject a URL that is safe to fix.
 *
 * This deliberately does NOT weaken the guard: `serverUrl` was validated
 * HTTPS at client construction (`assertSecureBaseUrl`), so the host is
 * already trusted — we upgrade the scheme instead of accepting cleartext.
 * The upgrade only applies when `serverUrl` is itself `https://`: a
 * plain-http (loopback dev) server URL keeps plain-http download URLs so
 * local development is unaffected.
 *
 * Returned unchanged when:
 * - `rawUrl` doesn't parse — the caller's `assertSecureBaseUrl` then throws
 *   a clearer error than we could;
 * - it is already `https://` (passthrough);
 * - it is http on a loopback host (allowed for development);
 * - it is http on a DIFFERENT host — left as http so the validator still
 *   throws (never widen trust beyond the configured server host).
 */
export function upgradeInsecureServerUrl(
  rawUrl: string,
  serverUrl: string,
): string {
  let url: URL;
  let server: URL;
  try {
    url = new URL(rawUrl);
    server = new URL(serverUrl);
  } catch {
    return rawUrl;
  }

  if (
    url.protocol === "http:" &&
    server.protocol === "https:" &&
    url.hostname === server.hostname
  ) {
    url.protocol = "https:";
  }
  return url.toString();
}

/**
 * HTTP error with status code, thrown by ServerClient for 4xx responses.
 * Includes `retryAfter` (seconds) for 429 Rate Limit responses and the
 * machine-readable `detail.error` code (e.g. "cloud_not_linked") when the
 * server provides one.
 */
export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly retryAfter?: number;
  public readonly errorCode?: string;

  constructor(
    message: string,
    statusCode: number,
    retryAfter?: number,
    errorCode?: string,
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
    this.errorCode = errorCode;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionOptions {
  singleFile?: boolean;
  /**
   * Ask the server to also convert the merged HTML to Markdown
   * (content.md + per-linked-page pages/<hash>.md). Extension never
   * converts anything itself — D5/D7 (download-as-markdown). Ignored by
   * the cloud push branch in v1.
   */
  downloadContentAsMarkdown?: boolean;
  /**
   * Whether the assembled output should include the HTML page
   * (text-native-downloads D1). Unchecking HTML with a text format on
   * makes the download text-only — the assembler then omits index.html.
   */
  downloadHtml?: boolean;
  /**
   * Whether the uploaded page text (content.txt) is part of the output
   * (text-native-downloads D1).
   */
  downloadContentAsText?: boolean;
  retentionDays?: number;
  pagepocketUserId?: string;
}

/**
 * Options for deleteSession (close-cloud-lifecycle-gaps D2).
 */
export interface DeleteSessionOptions {
  /**
   * Opt in to removing the archived PagePocket page alongside the local
   * session (appends `?delete_cloud=true`). Default: local-only delete.
   */
  deleteCloud?: boolean;
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
  /**
   * Seconds elapsed since assembly started (additive field from the
   * assembly-timeout-envelope work). Undefined on older servers —
   * consumers must treat it as optional.
   */
  assembly_elapsed_seconds?: number | null;
  download_url: string | null;
  output_type: string | null;
  /**
   * Server-provided filename for `output_type: "file"` — raw single-file
   * artifacts such as content.md / content.txt (text-native-downloads D3).
   * Absent/null on older servers and on html/zip outputs — consumers must
   * treat it as optional.
   */
  output_filename?: string | null;
  /**
   * MIME type accompanying `output_filename` (e.g. "text/markdown").
   * Optional for the same reason as output_filename.
   */
  output_content_type?: string | null;
  output_size: number | null;
  error_message: string | null;
  cloud_status?: string | null;
  cloud_page_id?: string | null;
  cloud_error?: string | null;
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
// Cloud identity binding (task 6.5 / design D4 — harden-backend-security-and-ops)
// ---------------------------------------------------------------------------

/** Response of POST /api/v1/cloud/link on success. */
interface CloudLinkResponse {
  bound: boolean;
  pagepocket_user_id: string;
  plan?: string | null;
  api_version: string;
}

/**
 * Outcome of the binding call. `invalid_token` means the PAGEPOCKET access
 * token was rejected — never a server API-key problem, so it must not
 * trigger server re-registration.
 */
export type CloudLinkResult =
  | {
      outcome: "bound";
      pagepocketUserId: string;
      plan: string | null;
    }
  /** Older monolith without the endpoint (404/501) or binding service unconfigured (503). */
  | { outcome: "unsupported" }
  /** PagePocket token rejected (401 invalid_pagepocket_token). */
  | { outcome: "invalid_token" }
  /** Network failure or unexpected server error — transient, retried lazily. */
  | { outcome: "failed"; message?: string };

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
  return TEXT_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// ServerClient
// ---------------------------------------------------------------------------

const API_KEY_STORAGE_KEY = "server_api_key";
const EXTENSION_INSTANCE_ID_KEY = "server_extension_instance_id";
const MAX_REGISTRATION_ATTEMPTS = 3;

/**
 * Client-side cap on a server-provided `Retry-After` hint (D11) — bounds the
 * wait so a hostile/buggy header can't hang the worker, keeping registration
 * responsive inside a service-worker lifetime. (The server caps its own hint
 * at 300 s per D5; this is the client's independent bound.)
 */
const MAX_RETRY_AFTER_WAIT_SECONDS = 60;

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per resource upload
const CONTROL_CALL_TIMEOUT_MS = 60 * 1000; // 60 seconds for API calls

/**
 * Parse a `Retry-After` header value expressed in integer seconds (D11).
 * Returns `null` when the header is absent, negative, or non-numeric —
 * anything unusable — so the caller keeps its default exponential backoff.
 */
function parseRetryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const parsed = parseInt(header, 10);
  if (isNaN(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Extract the machine-readable `error` code from a register error body
 * (api-abuse-hardening D2). The repo's structured error style wraps the
 * code as `{ detail: { error: ... } }`, while the PoP gate bodies use the
 * flat `{ error: ... }` form (`reauth_required`, `reauth_proof_invalid`).
 * Returns null for anything unparsable or without a string code.
 */
function parseRegisterErrorCode(bodyText: string): string | null {
  try {
    const json = JSON.parse(bodyText) as {
      error?: unknown;
      detail?: { error?: unknown };
    };
    if (typeof json?.error === "string") return json.error;
    if (typeof json?.detail?.error === "string") return json.detail.error;
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether a register failure is a proof-of-possession gate rejection
 * (api-abuse-hardening D2/D3): 409 `reauth_required` (the instance id is
 * already registered and no proof was presented) or 401
 * `reauth_proof_invalid` (the presented key does not match). Both mean the
 * stored identity is unrecoverable as-is and call for the fresh-instance
 * rotation recovery instead of retrying the same identity.
 */
function isReauthRejection(status: number, errorCode: string | null): boolean {
  return (
    (status === 409 && errorCode === "reauth_required") ||
    (status === 401 && errorCode === "reauth_proof_invalid")
  );
}

/**
 * Combine an optional user-provided AbortSignal with a timeout.
 * Uses AbortSignal.any() when available (Chrome 116+), falls back to
 * manual AbortController + setTimeout for Chrome 110-115.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (signal) {
    if (typeof AbortSignal.any === "function") {
      return AbortSignal.any([signal, timeoutSignal]);
    }
    // Fallback for Chrome <116
    const controller = new AbortController();
    const onAbort = () => {
      // Preserve WHY the abort happened: a timeout must surface as
      // TimeoutError (retryable by the upload queue), a user cancellation
      // as AbortError (terminal). Dropping the reason would misclassify
      // timeouts as user cancels on Chrome <116.
      if (timeoutSignal.aborted) {
        controller.abort(timeoutSignal.reason);
      } else {
        controller.abort(signal?.reason);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timeoutSignal.addEventListener("abort", onAbort, { once: true });
    return controller.signal;
  }
  return timeoutSignal;
}

export class ServerClient {
  private readonly serverUrl: string;
  private apiKey: string | null = null;

  /** Promise-based mutex so concurrent 401s trigger at most one re-registration */
  private registrationLock: Promise<string> | null = null;

  constructor() {
    this.serverUrl =
      (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(
        /\/+$/,
        "",
      ) ?? "";

    if (this.serverUrl) {
      // D11 (S6): refuse insecure configuration instead of warning
      assertSecureBaseUrl(this.serverUrl, "Server URL");
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Check whether the server URL is configured. */
  get isConfigured(): boolean {
    return this.serverUrl.length > 0;
  }

  /**
   * The configured server base URL (empty string when unconfigured).
   * Validated HTTPS at construction for non-loopback hosts — callers use it
   * as the trust anchor for `upgradeInsecureServerUrl`.
   */
  get baseUrl(): string {
    return this.serverUrl;
  }

  private assertConfigured(): void {
    if (!this.serverUrl) {
      throw new ServerUnavailableError("Server URL not configured");
    }
  }

  /** (8.2) Create a new download session on the server. */
  async createSession(url: string, options?: SessionOptions): Promise<string> {
    this.assertConfigured();
    const body: Record<string, unknown> = { url };
    if (options) {
      body.options = {
        singleFile: options.singleFile ?? false,
        // Sent on every session creation (spec: default false when unset).
        downloadContentAsMarkdown: options.downloadContentAsMarkdown ?? false,
        // text-native-downloads D1: the full format selection rides every
        // session creation — both flags are always sent explicitly, never
        // omitted. downloadHtml defaults to true: including the HTML page
        // is today's behavior for callers that don't pass the flag yet.
        downloadHtml: options.downloadHtml ?? true,
        downloadContentAsText: options.downloadContentAsText ?? false,
        retentionDays: options.retentionDays,
        pagepocketUserId: options.pagepocketUserId,
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

  /** (8.3) Upload an HTML chunk to the server.
   *
   * Wrapped in withRetry (task 4.5 / D9): transient network/5xx failures are
   * retried with backoff like every other control-plane call, so a chunk is
   * never silently lost to a momentary blip. 4xx errors (e.g. 413
   * session-full) are not retried. A chunk that exhausts its retries throws
   * — callers surface the failure instead of skipping the chunk. */
  async uploadHtmlChunk(
    sessionId: string,
    html: string,
    scrollIndex: number,
    pageType?: "main" | "linked",
    pageUrl?: string,
  ): Promise<UploadHtmlChunkResponse> {
    this.assertConfigured();
    const body: Record<string, unknown> = {
      html,
      scrollIndex,
      pageType: pageType ?? "main",
    };
    if (pageUrl) {
      body.pageUrl = pageUrl;
    }

    return this.withRetry(async () => {
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
    });
  }

  /** (8.4) Signal that all HTML chunks have been uploaded. */
  async scrapeComplete(
    sessionId: string,
    resourceCount: number,
    resourcesFailed?: number,
  ): Promise<ScrapeCompleteResponse> {
    this.assertConfigured();
    return this.withRetry(async () => {
      const body: Record<string, unknown> = { resourceCount };
      // Optional: report handler-observed failed fetches so sessions with
      // missing assets are visible server-side. Only sent when > 0,
      // mirroring how uploadHtmlChunk omits pageUrl when absent.
      if (resourcesFailed && resourcesFailed > 0) {
        body.resourcesFailed = resourcesFailed;
      }
      const res = await this.authenticatedFetch(
        `/api/v1/sessions/${sessionId}/scrape-complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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
    this.assertConfigured();
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
        withTimeout(signal, UPLOAD_TIMEOUT_MS),
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
      signal: withTimeout(signal, UPLOAD_TIMEOUT_MS),
    };

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
    this.assertConfigured();
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
  async finalizeSession(sessionId: string): Promise<FinalizeResponse> {
    this.assertConfigured();
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
  async getSessionStatus(sessionId: string): Promise<SessionStatusResponse> {
    this.assertConfigured();
    const res = await this.authenticatedFetch(
      `/api/v1/sessions/${sessionId}/status`,
    );

    if (!res.ok) {
      await this.throwForStatus(res, "getSessionStatus");
    }

    return (await res.json()) as SessionStatusResponse;
  }

  /** (8.10) Check server health without authentication.
   *
   * (D6 / task 6.1) The fetch carries the shared control-call timeout: a
   * server that accepts the connection but never responds aborts at the 60s
   * bound (TimeoutError), which the catch below classifies as
   * ServerUnavailableError — visible failure instead of a hung caller. */
  async checkHealth(): Promise<HealthResponse> {
    this.assertConfigured();
    try {
      const res = await fetch(`${this.serverUrl}/api/v1/health`, {
        method: "GET",
        signal: AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS),
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

  /**
   * Delete a session on the server.
   *
   * The optional `deleteCloud` flag opts in to the federated delete
   * (close-cloud-lifecycle-gaps D2): the `delete_cloud=true` query parameter
   * asks the monolith to also remove the archived PagePocket page. It is
   * omitted by default so the delete stays local-only (opt-in, never
   * destructive beyond the server session without explicit consent).
   */
  async deleteSession(
    sessionId: string,
    options?: DeleteSessionOptions,
  ): Promise<void> {
    this.assertConfigured();
    const path =
      options?.deleteCloud === true
        ? `/api/v1/sessions/${sessionId}?delete_cloud=true`
        : `/api/v1/sessions/${sessionId}`;
    const res = await this.authenticatedFetch(path, {
      method: "DELETE",
    });

    if (!res.ok) {
      await this.throwForStatus(res, "deleteSession");
    }
  }

  /**
   * (6.5) Bind the PagePocket identity to this API-key client via
   * POST /api/v1/cloud/link. The monolith verifies the access token against
   * the PagePocket auth service and stores user id + plan on the client row.
   *
   * Deliberately does NOT use authenticatedFetch: its 401 path re-registers
   * the server client, but a 401 from /cloud/link means the PAGEPOCKET token
   * was rejected (detail.error "invalid_pagepocket_token") — re-registering
   * would destroy a healthy binding for nothing. Only a 401 that the server
   * reports as an API-key problem ("invalid_api_key" / unknown body) is
   * treated as a revoked key and retried once after a fresh re-registration
   * (6.3 semantics).
   */
  async linkCloudAccount(accessToken: string): Promise<CloudLinkResult> {
    this.assertConfigured();

    const attempt = async (
      apiKey: string,
    ): Promise<{ res: Response | null; networkError?: Error }> => {
      try {
        const res = await fetch(`${this.serverUrl}/api/v1/cloud/link`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          body: JSON.stringify({ access_token: accessToken }),
          signal: AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS),
        });
        return { res };
      } catch (err) {
        // Includes the 60s control-call timeout (TimeoutError DOMException) —
        // reported as a transient failure, never thrown into the login flow.
        return { res: null, networkError: err as Error };
      }
    };

    const readErrorCode = async (
      res: Response,
    ): Promise<string | undefined> => {
      try {
        const json = (await res.json()) as { detail?: { error?: unknown } };
        return typeof json?.detail?.error === "string"
          ? json.detail.error
          : undefined;
      } catch {
        return undefined;
      }
    };

    // Register if needed, but don't loop: a stored key that the server
    // rejects is handled by the single re-register + retry below.
    const apiKey = await this.ensureApiKey();
    let { res, networkError } = await attempt(apiKey);

    if (res && res.status === 401) {
      const errorCode = await readErrorCode(res);
      if (errorCode === "invalid_pagepocket_token") {
        // The PagePocket token is bad — the server API key is fine.
        return { outcome: "invalid_token" };
      }
      // API-key problem (revoked/unknown key): re-register with a FRESH
      // instance id (6.3) and retry the link exactly once.
      this.apiKey = null;
      let freshKey: string;
      try {
        freshKey = await this.registerWithMutex({ freshInstance: true });
      } catch {
        return { outcome: "failed", message: "re-registration failed" };
      }
      const retry = await attempt(freshKey);
      res = retry.res;
      networkError = retry.networkError;
      if (res && res.status === 401) {
        // Still 401 with a fresh key: distinguish a rejected PagePocket
        // token from any other lingering key problem.
        const retryCode = await readErrorCode(res);
        return retryCode === "invalid_pagepocket_token"
          ? { outcome: "invalid_token" }
          : {
              outcome: "failed",
              message: "link failed after re-registration",
            };
      }
    }

    if (!res) {
      return {
        outcome: "failed",
        message: networkError?.message ?? "network error",
      };
    }

    if (res.ok) {
      const data = (await res.json()) as CloudLinkResponse;
      return {
        outcome: "bound",
        pagepocketUserId: data.pagepocket_user_id,
        plan: data.plan ?? null,
      };
    }

    // Graceful degradation (task 6.5): older monoliths have no /cloud/link
    // (404/501) and an unconfigured auth service returns 503 — fall back to
    // the legacy raw-pagepocketUserId behavior instead of failing cloud mode.
    if (res.status === 404 || res.status === 501 || res.status === 503) {
      return { outcome: "unsupported" };
    }

    return { outcome: "failed", message: `cloud/link returned ${res.status}` };
  }

  /**
   * (close-cloud-lifecycle-gaps D1) Unbind the PagePocket identity from this
   * API-key client via DELETE /api/v1/cloud/link — the mirror of the binding
   * endpoint with identical auth semantics (X-API-Key client identity). The
   * endpoint is idempotent server-side (unbound client → still 2xx).
   *
   * Like linkCloudAccount, deliberately does NOT use authenticatedFetch:
   * its 401 path re-registers the server client, but re-registering here
   * would mint a fresh client row just to leave it unbound again. A revoked
   * key simply reports failure — the caller treats unbind as non-blocking
   * logout hygiene and the next linkCloudAccount() re-binds anyway.
   *
   * @returns true only when the server confirmed the unbind (2xx).
   */
  async unbindCloudAccount(): Promise<boolean> {
    this.assertConfigured();

    // Nothing to unbind without the client identity — don't register a
    // fresh client (and burn registration retries) just to unbind it.
    const apiKey = this.apiKey ?? (await this.loadApiKeyFromStorage());
    if (!apiKey) return false;

    try {
      const res = await fetch(`${this.serverUrl}/api/v1/cloud/link`, {
        method: "DELETE",
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      // Network failure / control-call timeout — reported as failure, the
      // caller decides what "best-effort" means here.
      return false;
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
   *
   * `freshInstance` (task 6.3 / D14): mint a NEW instance id instead of
   * reusing the stored one. Used after a 401 — when the stored instance id
   * resolves server-side to a revoked key, re-registering with the SAME id
   * returns the SAME doomed key and the request 401s forever.
   */
  private registerWithMutex(
    options: { freshInstance?: boolean } = {},
  ): Promise<string> {
    if (this.registrationLock) {
      return this.registrationLock;
    }

    this.registrationLock = (async () => {
      try {
        const key = await this.register(options);
        return key;
      } finally {
        this.registrationLock = null;
      }
    })();

    return this.registrationLock;
  }

  /**
   * Register with the server to obtain an API key.
   * Stores the key in chrome.storage.session for the current browser session.
   * Retries up to MAX_REGISTRATION_ATTEMPTS with exponential backoff.
   *
   * D11: a 429 carrying a usable `Retry-After` header replaces the default
   * backoff for that attempt — wait min(hint, 60) seconds before the next
   * try. The wait does NOT consume an attempt (the budget is spent by real
   * fetch attempts only), and total attempts stay bounded by
   * MAX_REGISTRATION_ATTEMPTS.
   *
   * With `freshInstance`, a new instance id is minted (and persisted) before
   * the attempt loop — a fresh id forces the server to create a new client
   * row + key instead of resolving the doomed identity again.
   *
   * api-abuse-hardening D3 (tasks 4.1–4.4): when a key is already held
   * (in-memory or chrome.storage.session) it is sent as the `X-API-Key`
   * proof, so re-registering an already-registered instance id re-unlocks
   * the same identity; with no key held no proof header is sent. A 409
   * `reauth_required` (registered id, no proof) or 401
   * `reauth_proof_invalid` (held proof wrong/revoked) rotates to a fresh
   * instance id — persisted, inside this single-flight registration — and
   * completes as a fresh client. The rotation consumes one attempt of the
   * bounded budget; persistent failure still surfaces as AuthenticationError.
   */
  private async register(
    options: { freshInstance?: boolean } = {},
  ): Promise<string> {
    let lastError: Error | null = null;
    let instanceId = options.freshInstance
      ? await this.rotateInstanceId()
      : await this.getOrCreateInstanceId();

    for (let attempt = 0; attempt < MAX_REGISTRATION_ATTEMPTS; attempt++) {
      // `Retry-After` hint from a 429 on THIS attempt — captured in the try
      // (headers are gone once the response is consumed) and consumed in the
      // catch below instead of the default exponential backoff.
      let retryAfterSeconds: number | null = null;
      try {
        // (api-abuse-hardening D3 / task 4.1) Proof of possession: present
        // the currently held key (memory first, then session storage) so a
        // re-registration of an already-registered id re-unlocks the same
        // identity. No key held → no proof header (first registration stays
        // unauthenticated).
        const proofKey = this.apiKey ?? (await this.loadApiKeyFromStorage());
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (proofKey) {
          headers["X-API-Key"] = proofKey;
        }

        // (D6 / task 6.1) Control-call timeout — a black-holed server must
        // not hang registration (and therefore START_DOWNLOAD) forever. The
        // TimeoutError abort lands in the catch below, consuming the retry
        // budget and ultimately surfacing as AuthenticationError.
        const res = await fetch(`${this.serverUrl}/api/v1/auth/register`, {
          method: "POST",
          headers,
          body: JSON.stringify({ client_id: instanceId }),
          signal: AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS),
        });

        if (!res.ok) {
          if (res.status === 429) {
            retryAfterSeconds = parseRetryAfterSeconds(
              res.headers.get("Retry-After"),
            );
          }
          const errorBody = await res.text().catch(() => "");

          // (api-abuse-hardening D3 / tasks 4.2–4.3) PoP gate rejection:
          // the stored identity cannot be registered as-is. Rotate to a
          // fresh instance id (persisted by rotateInstanceId) and retry as
          // a fresh client — the same recovery the post-401 path uses —
          // still inside this single-flight registration. The `continue`
          // burns one attempt of the bounded loop (no extra backoff: the
          // rejection is deterministic, not server load); persistent
          // failure still lands in the AuthenticationError below.
          if (
            isReauthRejection(res.status, parseRegisterErrorCode(errorBody))
          ) {
            instanceId = await this.rotateInstanceId();
            continue;
          }

          throw new Error(`Registration failed: ${res.status} ${errorBody}`);
        }

        const data = (await res.json()) as {
          api_key: string;
          client_id: string;
        };

        this.apiKey = data.api_key;
        await this.saveApiKeyToStorage(data.api_key);
        return this.apiKey;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < MAX_REGISTRATION_ATTEMPTS - 1) {
          // D11: honor the server's Retry-After hint on 429, capped
          // client-side at 60 s — the server told us when to come back, so
          // an immediate retry would only 429 again. The wait replaces the
          // default delay and does not consume an attempt. Without a usable
          // header, keep the 1s/2s exponential backoff.
          const delay =
            retryAfterSeconds !== null
              ? Math.min(retryAfterSeconds, MAX_RETRY_AFTER_WAIT_SECONDS) * 1000
              : Math.pow(2, attempt) * 1000; // 1s, 2s
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
    if (
      !headers.has("Content-Type") &&
      init.body &&
      typeof init.body === "string"
    ) {
      headers.set("Content-Type", "application/json");
    }

    const url = `${this.serverUrl}${path}`;
    // Apply control-plane timeout when caller hasn't provided a signal
    // (uploadResource already sets its own 5-minute timeout)
    const effectiveSignal =
      init.signal ?? AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, signal: effectiveSignal });
    } catch (err) {
      if (err instanceof DOMException) throw err;
      throw new ServerUnavailableError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    // On 401, attempt re-registration and retry once
    if (res.status === 401) {
      // Clear cached key
      this.apiKey = null;

      // Re-register via mutex — concurrent callers share the same registration.
      // Fresh instance id (6.3 / D14): the stored id may resolve server-side
      // to a revoked key, which would return the same dead key and 401
      // forever. A fresh id forces a new client row + working key. The mutex
      // keeps this single-flight; failure throws AuthenticationError
      // (definitive — no retry loop).
      const newKey = await this.registerWithMutex({ freshInstance: true });

      // Retry with the new key
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("X-API-Key", newKey);
      if (
        !retryHeaders.has("Content-Type") &&
        init.body &&
        typeof init.body === "string"
      ) {
        retryHeaders.set("Content-Type", "application/json");
      }

      // Use a fresh timeout signal for the retry so re-registration latency
      // doesn't eat into the retry's timeout budget. For upload calls (which
      // pass their own signal wrapped via withTimeout), create a new timeout
      // so the full budget is available for the retry.
      const retrySignal = init.signal
        ? withTimeout(undefined, UPLOAD_TIMEOUT_MS)
        : AbortSignal.timeout(CONTROL_CALL_TIMEOUT_MS);
      try {
        res = await fetch(url, {
          ...init,
          headers: retryHeaders,
          signal: retrySignal,
        });
      } catch (err) {
        if (err instanceof DOMException) throw err;
        throw new ServerUnavailableError(
          `Network error on retry: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

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
            lastError.statusCode >= 500); // 5xx server error

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
    let errorCode: string | undefined;
    try {
      const json = JSON.parse(bodyText);
      detail =
        json?.detail?.message ??
        json?.detail?.error ??
        json?.message ??
        // api-abuse-hardening: the new session-create error bodies use the
        // flat `{ error: ... }` style (url_not_allowed / session_limit_
        // exceeded) — surface the code as the message when nothing more
        // descriptive is present.
        json?.error ??
        JSON.stringify(json);
      if (typeof json?.detail?.error === "string") {
        errorCode = json.detail.error;
      } else if (typeof json?.error === "string") {
        errorCode = json.error;
      }
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
        errorCode,
      );
    }

    // 4xx errors (except 401 and 429 handled above)
    throw new HttpError(
      `${operation}: ${status} — ${detail}`,
      status,
      undefined,
      errorCode,
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
  ): Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }> {
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
                hdrs[line.substring(0, idx).toLowerCase()] = line.substring(
                  idx + 2,
                );
              }
            }
          }
          resolve({
            status: xhr.status,
            body: xhr.responseText,
            headers: hdrs,
          });
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

    // Handle 401 — re-register and retry once.
    // Fresh instance id (6.3 / D14) for the same reason as authenticatedFetch:
    // a revoked key resolved by the stored instance id never recovers.
    if (result.status === 401) {
      this.apiKey = null;
      const newKey = await this.registerWithMutex({ freshInstance: true });
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
  // chrome.storage.session helpers (D11 / task 7.2)
  //
  // The API key and instance ID persist in chrome.storage.session so they
  // never live on disk. On the first server call of a browser session the
  // key is absent and auto-registration runs again (automatic, uses the
  // instance ID for idempotency).
  // -----------------------------------------------------------------------

  private async loadApiKeyFromStorage(): Promise<string | null> {
    await this.scrubLegacyLocalKeys();
    try {
      if (!chrome?.storage?.session) return null;
      const result = await chrome.storage.session.get(API_KEY_STORAGE_KEY);
      return result[API_KEY_STORAGE_KEY] ?? null;
    } catch {
      return null;
    }
  }

  private async saveApiKeyToStorage(key: string): Promise<void> {
    try {
      if (!chrome?.storage?.session) return;
      await chrome.storage.session.set({ [API_KEY_STORAGE_KEY]: key });
    } catch {
      // Non-critical — the key is cached in memory
    }
  }

  private async saveInstanceIdToStorage(id: string): Promise<void> {
    try {
      if (!chrome?.storage?.session) return;
      await chrome.storage.session.set({ [EXTENSION_INSTANCE_ID_KEY]: id });
    } catch {
      // Non-critical — the id lives in the closure of the current registration
    }
  }

  /**
   * Discard the stored instance id and mint a fresh one, persisting it to
   * chrome.storage.session (task 6.3 / D14). Used when the stored identity
   * resolved to a revoked key — re-registering with the same id would return
   * the same revoked key forever (re-registration deadlock).
   */
  private async rotateInstanceId(): Promise<string> {
    try {
      if (chrome?.storage?.session) {
        await chrome.storage.session.remove(EXTENSION_INSTANCE_ID_KEY);
      }
    } catch {
      // Non-critical — we overwrite it below anyway
    }
    const id = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await this.saveInstanceIdToStorage(id);
    return id;
  }

  private async getOrCreateInstanceId(): Promise<string> {
    try {
      if (!chrome?.storage?.session) {
        return `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }

      const result = await chrome.storage.session.get(
        EXTENSION_INSTANCE_ID_KEY,
      );
      if (result[EXTENSION_INSTANCE_ID_KEY]) {
        return result[EXTENSION_INSTANCE_ID_KEY] as string;
      }

      const id = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await chrome.storage.session.set({ [EXTENSION_INSTANCE_ID_KEY]: id });
      return id;
    } catch {
      return `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  /**
   * Remove key material persisted by older versions in chrome.storage.local
   * (on disk). Credentials are session-only since D11 — leftovers from
   * previous versions must not outlive the browser session.
   */
  private async scrubLegacyLocalKeys(): Promise<void> {
    try {
      if (!chrome?.storage?.local) return;
      await chrome.storage.local.remove([
        API_KEY_STORAGE_KEY,
        EXTENSION_INSTANCE_ID_KEY,
      ]);
    } catch {
      // Non-critical
    }
  }
}

/** Singleton instance for use throughout the extension background context. */
export const serverClient = new ServerClient();
