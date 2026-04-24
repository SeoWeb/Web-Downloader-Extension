/**
 * Integration tests for ServerClient (tasks 8.1–8.15).
 *
 * All HTTP calls are mocked via global fetch — no real server needed.
 * The tests validate that the correct endpoints, headers, and payloads
 * are used, and that error/retry logic behaves per spec.
 *
 * Browser/Vite globals (chrome.storage.local, import.meta.env) are
 * provided by tests/setup.ts (configured as jest setupFiles).
 */

// ---------------------------------------------------------------------------
// Import — browser/Vite globals are already set up via setup.ts
// ---------------------------------------------------------------------------

import {
  ServerClient,
  ServerUnavailableError,
  AuthenticationError,
  AssemblyTimeoutError,
} from "../../src/background/server-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh ServerClient for each test (bypass singleton). */
function createClient(): ServerClient {
  return new ServerClient();
}

/** Build a mock Response object. */
function mockResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ServerClient", () => {
  let fetchSpy: jest.SpiedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, "fetch");
    jest.clearAllMocks();
    // Clear chrome.storage mock state between tests to prevent key leakage
    const store = globalThis.chrome?.storage?.local?._store as Record<string, string> | undefined;
    if (store) {
      Object.keys(store).forEach((k) => delete store[k]);
    }
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // 8.1 — ServerClient class reads VITE_SERVER_URL
  // -----------------------------------------------------------------------
  it("reads server URL from VITE_SERVER_URL", () => {
    const client = createClient();
    // Indirectly verified: all subsequent calls use the correct base URL
    expect(client).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 8.2 — createSession
  // -----------------------------------------------------------------------
  describe("createSession", () => {
    it("POSTs to /api/v1/sessions and returns session ID", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/sessions") && init?.method === "POST") {
          expect(urlStr).toBe("https://test-server.example.com/api/v1/sessions");
          const body = JSON.parse(init.body as string);
          expect(body.url).toBe("https://example.com");
          // When no options provided, the body has no options field
          expect(body.options).toBeUndefined();
          return mockResponse(201, { id: "sess-123", url: "https://example.com", status: "scraping", html_chunks: 0, resources_discovered: null, resources_received: 0, created_at: "", expires_at: "", api_version: "v1" });
        }
        return mockResponse(404, { detail: "not found" });
      });

      const client = createClient();
      const sessionId = await client.createSession("https://example.com");
      expect(sessionId).toBe("sess-123");
    });

    it("sends singleFile and retentionDays options", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/sessions") && init?.method === "POST") {
          const body = JSON.parse(init.body as string);
          expect(body.options.singleFile).toBe(true);
          expect(body.options.retentionDays).toBe(14);
          return mockResponse(201, { id: "sess-456", url: "", status: "scraping", html_chunks: 0, resources_discovered: null, resources_received: 0, created_at: "", expires_at: "", api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const id = await client.createSession("https://example.com", {
        singleFile: true,
        retentionDays: 14,
      });
      expect(id).toBe("sess-456");
    });
  });

  // -----------------------------------------------------------------------
  // 8.3 — uploadHtmlChunk
  // -----------------------------------------------------------------------
  describe("uploadHtmlChunk", () => {
    it("POSTs HTML chunk with scrollIndex and linked page metadata", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/html") && init?.method === "POST") {
          const body = JSON.parse(init.body as string);
          expect(body.html).toBe("<p>chunk</p>");
          expect(body.scrollIndex).toBe(3);
          expect(body.pageType).toBe("linked");
          expect(body.pageUrl).toBe("https://example.com/page2");
          return mockResponse(200, { chunk_id: "ch-1", chunk_count: 4, total_size: 1024, deduplicated: false, api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.uploadHtmlChunk(
        "sess-1",
        "<p>chunk</p>",
        3,
        "linked",
        "https://example.com/page2",
      );
      expect(res.chunk_count).toBe(4);
      expect(res.deduplicated).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 8.4 — scrapeComplete
  // -----------------------------------------------------------------------
  describe("scrapeComplete", () => {
    it("POSTs scrape-complete with resourceCount", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/scrape-complete")) {
          const body = JSON.parse((init as RequestInit).body as string);
          expect(body.resourceCount).toBe(42);
          return mockResponse(200, { id: "sess-1", status: "uploading", message: "Transitioned to uploading", api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.scrapeComplete("sess-1", 42);
      expect(res.status).toBe("uploading");
    });
  });

  // -----------------------------------------------------------------------
  // 8.5 — uploadResource (gzip for text types only)
  // -----------------------------------------------------------------------
  describe("uploadResource", () => {
    it("uploads text resources with gzip compression", async () => {
      let capturedHeaders: Record<string, string> = {};
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/resources")) {
          // Extract custom headers
          const h = init?.headers as Headers;
          capturedHeaders = {};
          h?.forEach?.((v, k) => { capturedHeaders[k] = v; });
          return mockResponse(200, { resource_id: "res-1", local_path: "styles/main.css", size: 1234, deduplicated: false, api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const blob = new Blob(["body { color: red; }"], { type: "text/css" });
      await client.uploadResource("sess-1", "styles/main.css", blob, "https://example.com/style.css", "text/css");

      expect(capturedHeaders["x-content-gzipped"]).toBe("true");
    });

    it("uploads binary resources without gzip", async () => {
      let capturedHeaders: Record<string, string> = {};
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/resources")) {
          const h = init?.headers as Headers;
          capturedHeaders = {};
          h?.forEach?.((v, k) => { capturedHeaders[k] = v; });
          return mockResponse(200, { resource_id: "res-2", local_path: "images/photo.jpg", size: 5678, deduplicated: false, api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
      await client.uploadResource("sess-1", "images/photo.jpg", blob, "https://example.com/photo.jpg", "image/png");

      expect(capturedHeaders["x-content-gzipped"]).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 8.6 — uploadFilenameMap
  // -----------------------------------------------------------------------
  describe("uploadFilenameMap", () => {
    it("POSTs filename map JSON", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/filename-map")) {
          const body = JSON.parse((init as RequestInit).body as string);
          expect(body.map["https://example.com/img.jpg"]).toBe("images/img.jpg");
          return mockResponse(200, { mappings_count: 1, api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.uploadFilenameMap("sess-1", {
        "https://example.com/img.jpg": "images/img.jpg",
      });
      expect(res.mappings_count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 8.7 — uploadContent
  // -----------------------------------------------------------------------
  describe("uploadContent", () => {
    it("POSTs text content", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/content")) {
          const body = JSON.parse((init as RequestInit).body as string);
          expect(body.text).toBe("Page content here");
          return mockResponse(200, { message: "Content stored", size: 17, api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.uploadContent("sess-1", "Page content here");
      expect(res.size).toBe(17);
    });
  });

  // -----------------------------------------------------------------------
  // 8.8 — finalizeSession
  // -----------------------------------------------------------------------
  describe("finalizeSession", () => {
    it("POSTs finalize and returns 202 response", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/finalize")) {
          return mockResponse(202, { id: "sess-1", status: "assembling", message: "Assembly started", api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.finalizeSession("sess-1");
      expect(res.status).toBe("assembling");
    });
  });

  // -----------------------------------------------------------------------
  // 8.9 — getSessionStatus
  // -----------------------------------------------------------------------
  describe("getSessionStatus", () => {
    it("GETs session status with assembly phase", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/status")) {
          return mockResponse(200, {
            id: "sess-1",
            status: "assembling",
            url: "https://example.com",
            html_chunks: 5,
            resources_discovered: 10,
            resources_received: 8,
            total_size: 1024,
            assembly_phase: "converting_urls",
            assembly_progress_pct: 45,
            download_url: null,
            output_type: null,
            output_size: null,
            error_message: null,
            api_version: "v1",
          });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.getSessionStatus("sess-1");
      expect(res.status).toBe("assembling");
      expect(res.assembly_phase).toBe("converting_urls");
      expect(res.assembly_progress_pct).toBe(45);
    });
  });

  // -----------------------------------------------------------------------
  // 8.10 — checkHealth (no auth required)
  // -----------------------------------------------------------------------
  describe("checkHealth", () => {
    it("GETs /api/v1/health without API key", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/health")) {
          // Verify no X-API-Key header
          const h = init?.headers as Headers | undefined;
          const hasApiKey = h?.has?.("X-API-Key") ?? false;
          expect(hasApiKey).toBe(false);
          return mockResponse(200, {
            status: "ok",
            version: "1.0.0",
            mysql: "connected",
            storage_available_mb: 5000,
            storage_total_mb: 10000,
            description: null,
            api_version: "v1",
          });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.checkHealth();
      expect(res.status).toBe("ok");
    });

    it("throws ServerUnavailableError when server is unreachable", async () => {
      fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));

      const client = createClient();
      await expect(client.checkHealth()).rejects.toThrow(ServerUnavailableError);
    });
  });

  // -----------------------------------------------------------------------
  // 8.11 — Auto-registration
  // -----------------------------------------------------------------------
  describe("auto-registration", () => {
    it("auto-registers on first API call", async () => {
      let registered = false;
      let registeredKey = "";
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          registered = true;
          registeredKey = "auto-key-1";
          return mockResponse(200, { api_key: registeredKey, client_id: "c1" });
        }
        if (urlStr.includes("/sessions") && init?.method === "POST") {
          // Verify the API key from registration was used
          const h = init?.headers as Headers;
          expect(h?.get?.("X-API-Key")).toBe(registeredKey);
          return mockResponse(201, { id: "sess-auto", url: "", status: "scraping", html_chunks: 0, resources_discovered: null, resources_received: 0, created_at: "", expires_at: "", api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      await client.createSession("https://example.com");
      expect(registered).toBe(true);
    });

    it("re-registers on 401 and retries the original request", async () => {
      let callCount = 0;
      let reRegistered = false;
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          reRegistered = true;
          return mockResponse(200, { api_key: "new-key", client_id: "c1" });
        }
        if (urlStr.includes("/sessions")) {
          callCount++;
          const h = init?.headers as Headers;
          if (h?.get?.("X-API-Key") === "new-key") {
            return mockResponse(201, { id: "sess-retry", url: "", status: "scraping", html_chunks: 0, resources_discovered: null, resources_received: 0, created_at: "", expires_at: "", api_version: "v1" });
          }
          // First attempt with old key → 401
          return mockResponse(401, { detail: "Invalid API key" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const id = await client.createSession("https://example.com");
      expect(reRegistered).toBe(true);
      expect(id).toBe("sess-retry");
    });
  });

  // -----------------------------------------------------------------------
  // 8.12 — Error classes
  // -----------------------------------------------------------------------
  describe("error classes", () => {
    it("ServerUnavailableError has statusCode property", () => {
      const err = new ServerUnavailableError("test", undefined, 503);
      expect(err.statusCode).toBe(503);
      expect(err.name).toBe("ServerUnavailableError");
    });

    it("AuthenticationError has correct name", () => {
      const err = new AuthenticationError("auth failed");
      expect(err.name).toBe("AuthenticationError");
    });

    it("AssemblyTimeoutError has correct name", () => {
      const err = new AssemblyTimeoutError("timeout");
      expect(err.name).toBe("AssemblyTimeoutError");
    });
  });

  // -----------------------------------------------------------------------
  // 8.13 — 409 Conflict on finalizeSession treated as success
  // -----------------------------------------------------------------------
  describe("finalizeSession 409 handling", () => {
    it("treats 409 as success and returns synthetic response", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/finalize")) {
          return new Response(
            JSON.stringify({ current_status: "assembling", message: "Already finalizing" }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.finalizeSession("sess-1");
      expect(res.status).toBe("assembling");
      expect(res.id).toBe("sess-1");
    });
  });

  // -----------------------------------------------------------------------
  // 8.14 — Retry logic for control-plane calls
  // -----------------------------------------------------------------------
  describe("withRetry", () => {
    it("retries on 5xx server errors (using statusCode)", async () => {
      let attempts = 0;
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/scrape-complete")) {
          attempts++;
          if (attempts < 3) {
            return new Response(
              JSON.stringify({ detail: "Internal Server Error" }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
          return mockResponse(200, { id: "sess-1", status: "uploading", message: "ok", api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.scrapeComplete("sess-1", 10);
      expect(res.status).toBe("uploading");
      expect(attempts).toBe(3);
    });

    it("retries on network-level TypeError (fetch failure)", async () => {
      let attempts = 0;
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/scrape-complete")) {
          attempts++;
          if (attempts < 2) {
            throw new TypeError("Failed to fetch");
          }
          return mockResponse(200, { id: "sess-1", status: "uploading", message: "ok", api_version: "v1" });
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const res = await client.scrapeComplete("sess-1", 10);
      expect(res.status).toBe("uploading");
      expect(attempts).toBe(2);
    });

    it("does NOT retry on 4xx errors", async () => {
      let attempts = 0;
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/scrape-complete")) {
          attempts++;
          return new Response(
            JSON.stringify({ detail: "Session not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      await expect(client.scrapeComplete("sess-1", 10)).rejects.toThrow();
      expect(attempts).toBe(1);
    });

    it("does NOT retry on AuthenticationError", async () => {
      let scrapeAttempts = 0;
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/scrape-complete")) {
          scrapeAttempts++;
          return new Response(
            JSON.stringify({ detail: "Invalid API key" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      await expect(client.scrapeComplete("sess-1", 10)).rejects.toThrow(AuthenticationError);
      // 401 triggers re-registration; authenticatedFetch retries once with new key
      // then throws AuthenticationError if retry also returns 401.
      // So scrape-complete is called twice (original + retry-within-authenticatedFetch).
      expect(scrapeAttempts).toBe(2);
    });

    it("throws ServerUnavailableError after exhausting retries on 5xx", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/scrape-complete")) {
          return new Response(
            JSON.stringify({ detail: "Service Unavailable" }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      await expect(client.scrapeComplete("sess-1", 10)).rejects.toThrow(ServerUnavailableError);
    }, 15000);
  });
});
