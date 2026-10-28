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
  HttpError,
} from "../../src/background/server-client";

// ---------------------------------------------------------------------------
// chrome.storage.session mock (D11 / task 7.2)
//
// tests/setup.cjs only mocks chrome.storage.local. Credentials now persist in
// chrome.storage.session, so mock that area here too (each vitest test file
// gets a fresh environment, so this does not leak into other files).
// ---------------------------------------------------------------------------

const sessionStore: Record<string, unknown> = {};

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).session = {
    _store: sessionStore, // Exposed for test cleanup/assertions
    get: async (keys: string | string[]) => {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const k of keyArr) {
        if (sessionStore[k] !== undefined) {
          result[k] = sessionStore[k];
        }
      }
      return result;
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(sessionStore, items);
    },
    remove: async (keys: string | string[]) => {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      for (const k of keyArr) {
        delete sessionStore[k];
      }
    },
  };

  // The shared setup.cjs local mock has no remove(); the legacy-key scrub
  // (D11) relies on it. Back it with the mock's own _store.
  const localArea = globalThis.chrome.storage.local as Record<
    string,
    unknown
  > & { _store: Record<string, unknown> };
  if (typeof localArea.remove !== "function") {
    localArea.remove = async (keys: string | string[]) => {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      for (const k of keyArr) {
        delete localArea._store[k];
      }
    };
  }
}

/** Storage keys written by ServerClient (kept in sync with the module). */
const API_KEY_STORAGE_KEY = "server_api_key";
const EXTENSION_INSTANCE_ID_KEY = "server_extension_instance_id";

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
  let fetchSpy: vi.SpiedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.clearAllMocks();
    // Clear chrome.storage mock state between tests to prevent key leakage
    const store = globalThis.chrome?.storage?.local?._store as
      | Record<string, string>
      | undefined;
    if (store) {
      Object.keys(store).forEach((k) => delete store[k]);
    }
    Object.keys(sessionStore).forEach((k) => delete sessionStore[k]);
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
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            expect(urlStr).toBe(
              "https://test-server.example.com/api/v1/sessions",
            );
            const body = JSON.parse(init.body as string);
            expect(body.url).toBe("https://example.com");
            // When no options provided, the body has no options field
            expect(body.options).toBeUndefined();
            return mockResponse(201, {
              id: "sess-123",
              url: "https://example.com",
              status: "scraping",
              html_chunks: 0,
              resources_discovered: null,
              resources_received: 0,
              created_at: "",
              expires_at: "",
              api_version: "v1",
            });
          }
          return mockResponse(404, { detail: "not found" });
        },
      );

      const client = createClient();
      const sessionId = await client.createSession("https://example.com");
      expect(sessionId).toBe("sess-123");
    });

    it("sends singleFile and retentionDays options", async () => {
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            expect(body.options.singleFile).toBe(true);
            expect(body.options.retentionDays).toBe(14);
            return mockResponse(201, {
              id: "sess-456",
              url: "",
              status: "scraping",
              html_chunks: 0,
              resources_discovered: null,
              resources_received: 0,
              created_at: "",
              expires_at: "",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const id = await client.createSession("https://example.com", {
        singleFile: true,
        retentionDays: 14,
      });
      expect(id).toBe("sess-456");
    });

    // download-as-markdown task 3.8 / design D5: the option rides the
    // POST /api/v1/sessions body; the extension never converts itself.
    it("sends downloadContentAsMarkdown: true when enabled", async () => {
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            expect(body.options.downloadContentAsMarkdown).toBe(true);
            return mockResponse(201, {
              id: "sess-md-1",
              url: "",
              status: "scraping",
              html_chunks: 0,
              resources_discovered: null,
              resources_received: 0,
              created_at: "",
              expires_at: "",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const id = await client.createSession("https://example.com", {
        downloadContentAsMarkdown: true,
      });
      expect(id).toBe("sess-md-1");
    });

    it("sends downloadContentAsMarkdown: false when the option is unset", async () => {
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            // Spec: the field is sent on every session creation.
            expect(body.options.downloadContentAsMarkdown).toBe(false);
            return mockResponse(201, {
              id: "sess-md-0",
              url: "",
              status: "scraping",
              html_chunks: 0,
              resources_discovered: null,
              resources_received: 0,
              created_at: "",
              expires_at: "",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const id = await client.createSession("https://example.com", {
        retentionDays: 1,
      });
      expect(id).toBe("sess-md-0");
    });
  });

  // -----------------------------------------------------------------------
  // 8.3 — uploadHtmlChunk
  // -----------------------------------------------------------------------
  describe("uploadHtmlChunk", () => {
    it("POSTs HTML chunk with scrollIndex and linked page metadata", async () => {
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
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
            return mockResponse(200, {
              chunk_id: "ch-1",
              chunk_count: 4,
              total_size: 1024,
              deduplicated: false,
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

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
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/scrape-complete")) {
            const body = JSON.parse((init as RequestInit).body as string);
            expect(body.resourceCount).toBe(42);
            return mockResponse(200, {
              id: "sess-1",
              status: "uploading",
              message: "Transitioned to uploading",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const res = await client.scrapeComplete("sess-1", 42);
      expect(res.status).toBe("uploading");
    });

    // resourcesFailed: failed resource fetches reported end-to-end so
    // sessions with missing assets are visible server-side.
    it("includes resourcesFailed in the body when provided (> 0)", async () => {
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/scrape-complete")) {
            const body = JSON.parse((init as RequestInit).body as string);
            expect(body.resourceCount).toBe(10);
            expect(body.resourcesFailed).toBe(3);
            return mockResponse(200, {
              id: "sess-1",
              status: "uploading",
              message: "Transitioned to uploading",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const res = await client.scrapeComplete("sess-1", 10, 3);
      expect(res.status).toBe("uploading");
    });

    it("omits resourcesFailed when not provided", async () => {
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/scrape-complete")) {
            const body = JSON.parse((init as RequestInit).body as string);
            expect(body.resourcesFailed).toBeUndefined();
            return mockResponse(200, {
              id: "sess-1",
              status: "uploading",
              message: "Transitioned to uploading",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      await client.scrapeComplete("sess-1", 10);
    });
  });

  // -----------------------------------------------------------------------
  // 8.5 — uploadResource (gzip for text types only)
  // -----------------------------------------------------------------------
  describe("uploadResource", () => {
    it("uploads text resources with gzip compression", async () => {
      let capturedHeaders: Record<string, string> = {};
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/resources")) {
            // Extract custom headers
            const h = init?.headers as Headers;
            capturedHeaders = {};
            h?.forEach?.((v, k) => {
              capturedHeaders[k] = v;
            });
            return mockResponse(200, {
              resource_id: "res-1",
              local_path: "styles/main.css",
              size: 1234,
              deduplicated: false,
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const blob = new Blob(["body { color: red; }"], { type: "text/css" });
      await client.uploadResource(
        "sess-1",
        "styles/main.css",
        blob,
        "https://example.com/style.css",
        "text/css",
      );

      expect(capturedHeaders["x-content-gzipped"]).toBe("true");
    });

    it("uploads binary resources without gzip", async () => {
      let capturedHeaders: Record<string, string> = {};
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/resources")) {
            const h = init?.headers as Headers;
            capturedHeaders = {};
            h?.forEach?.((v, k) => {
              capturedHeaders[k] = v;
            });
            return mockResponse(200, {
              resource_id: "res-2",
              local_path: "images/photo.jpg",
              size: 5678,
              deduplicated: false,
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
        type: "image/png",
      });
      await client.uploadResource(
        "sess-1",
        "images/photo.jpg",
        blob,
        "https://example.com/photo.jpg",
        "image/png",
      );

      expect(capturedHeaders["x-content-gzipped"]).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 8.6 — uploadFilenameMap
  // -----------------------------------------------------------------------
  describe("uploadFilenameMap", () => {
    it("POSTs filename map JSON", async () => {
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/filename-map")) {
            const body = JSON.parse((init as RequestInit).body as string);
            expect(body.map["https://example.com/img.jpg"]).toBe(
              "images/img.jpg",
            );
            return mockResponse(200, { mappings_count: 1, api_version: "v1" });
          }
          return mockResponse(404, {});
        },
      );

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
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/content")) {
            const body = JSON.parse((init as RequestInit).body as string);
            expect(body.text).toBe("Page content here");
            return mockResponse(200, {
              message: "Content stored",
              size: 17,
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

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
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/finalize")) {
            return mockResponse(202, {
              id: "sess-1",
              status: "assembling",
              message: "Assembly started",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

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
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
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
        },
      );

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
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
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
        },
      );

      const client = createClient();
      const res = await client.checkHealth();
      expect(res.status).toBe("ok");
    });

    it("throws ServerUnavailableError when server is unreachable", async () => {
      fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));

      const client = createClient();
      await expect(client.checkHealth()).rejects.toThrow(
        ServerUnavailableError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 8.11 — Auto-registration
  // -----------------------------------------------------------------------
  describe("auto-registration", () => {
    it("auto-registers on first API call", async () => {
      let registered = false;
      let registeredKey = "";
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            registered = true;
            registeredKey = "auto-key-1";
            return mockResponse(200, {
              api_key: registeredKey,
              client_id: "c1",
            });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            // Verify the API key from registration was used
            const h = init?.headers as Headers;
            expect(h?.get?.("X-API-Key")).toBe(registeredKey);
            return mockResponse(201, {
              id: "sess-auto",
              url: "",
              status: "scraping",
              html_chunks: 0,
              resources_discovered: null,
              resources_received: 0,
              created_at: "",
              expires_at: "",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      await client.createSession("https://example.com");
      expect(registered).toBe(true);
    });

    it("re-registers on 401 and retries the original request", async () => {
      let callCount = 0;
      let reRegistered = false;
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            reRegistered = true;
            return mockResponse(200, { api_key: "new-key", client_id: "c1" });
          }
          if (urlStr.includes("/sessions")) {
            callCount++;
            const h = init?.headers as Headers;
            if (h?.get?.("X-API-Key") === "new-key") {
              return mockResponse(201, {
                id: "sess-retry",
                url: "",
                status: "scraping",
                html_chunks: 0,
                resources_discovered: null,
                resources_received: 0,
                created_at: "",
                expires_at: "",
                api_version: "v1",
              });
            }
            // First attempt with old key → 401
            return mockResponse(401, { detail: "Invalid API key" });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const id = await client.createSession("https://example.com");
      expect(reRegistered).toBe(true);
      expect(id).toBe("sess-retry");
    });

    // -------------------------------------------------------------------
    // D11 / task 7.2 — credentials persist in chrome.storage.session
    // -------------------------------------------------------------------
    it("persists the API key and instance ID to session storage, not local", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "session-key", client_id: "c1" });
        }
        return mockResponse(201, {
          id: "sess-1",
          url: "",
          status: "scraping",
          html_chunks: 0,
          resources_discovered: null,
          resources_received: 0,
          created_at: "",
          expires_at: "",
          api_version: "v1",
        });
      });

      const client = createClient();
      await client.createSession("https://example.com");

      expect(sessionStore[API_KEY_STORAGE_KEY]).toBe("session-key");
      expect(typeof sessionStore[EXTENSION_INSTANCE_ID_KEY]).toBe("string");
      // Nothing may land in the on-disk local area
      const localStore = globalThis.chrome?.storage?.local?._store as
        | Record<string, unknown>
        | undefined;
      expect(localStore?.[API_KEY_STORAGE_KEY]).toBeUndefined();
      expect(localStore?.[EXTENSION_INSTANCE_ID_KEY]).toBeUndefined();
    });

    it("reuses the API key from session storage without re-registering", async () => {
      sessionStore[API_KEY_STORAGE_KEY] = "stored-session-key";
      sessionStore[EXTENSION_INSTANCE_ID_KEY] = "ext-stored";

      let registerCalled = false;
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            registerCalled = true;
            return mockResponse(200, { api_key: "fresh-key", client_id: "c1" });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            const h = init?.headers as Headers;
            expect(h?.get?.("X-API-Key")).toBe("stored-session-key");
            return mockResponse(201, {
              id: "sess-2",
              url: "",
              status: "scraping",
              html_chunks: 0,
              resources_discovered: null,
              resources_received: 0,
              created_at: "",
              expires_at: "",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      await client.createSession("https://example.com");
      expect(registerCalled).toBe(false);
    });

    it("auto re-registers on first use when session storage is empty", async () => {
      // Session store left empty — simulates the first call of a browser session
      let registerCalled = false;
      fetchSpy.mockImplementation(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          registerCalled = true;
          return mockResponse(200, {
            api_key: "re-registered-key",
            client_id: "c1",
          });
        }
        return mockResponse(201, {
          id: "sess-3",
          url: "",
          status: "scraping",
          html_chunks: 0,
          resources_discovered: null,
          resources_received: 0,
          created_at: "",
          expires_at: "",
          api_version: "v1",
        });
      });

      const client = createClient();
      await client.createSession("https://example.com");
      expect(registerCalled).toBe(true);
      expect(sessionStore[API_KEY_STORAGE_KEY]).toBe("re-registered-key");
    });

    it("scrubs legacy key material from chrome.storage.local", async () => {
      const localStore = globalThis.chrome?.storage?.local?._store as Record<
        string,
        unknown
      >;
      localStore[API_KEY_STORAGE_KEY] = "legacy-local-key";
      localStore[EXTENSION_INSTANCE_ID_KEY] = "legacy-instance";

      fetchSpy.mockImplementation(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "new-key", client_id: "c1" });
        }
        return mockResponse(201, {
          id: "sess-4",
          url: "",
          status: "scraping",
          html_chunks: 0,
          resources_discovered: null,
          resources_received: 0,
          created_at: "",
          expires_at: "",
          api_version: "v1",
        });
      });

      const client = createClient();
      await client.createSession("https://example.com");

      expect(localStore[API_KEY_STORAGE_KEY]).toBeUndefined();
      expect(localStore[EXTENSION_INSTANCE_ID_KEY]).toBeUndefined();
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
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/finalize")) {
            return new Response(
              JSON.stringify({
                current_status: "assembling",
                message: "Already finalizing",
              }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
          return mockResponse(404, {});
        },
      );

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
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/scrape-complete")) {
            attempts++;
            if (attempts < 3) {
              return new Response(
                JSON.stringify({ detail: "Internal Server Error" }),
                {
                  status: 500,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
            return mockResponse(200, {
              id: "sess-1",
              status: "uploading",
              message: "ok",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const res = await client.scrapeComplete("sess-1", 10);
      expect(res.status).toBe("uploading");
      expect(attempts).toBe(3);
    });

    it("retries on network-level TypeError (fetch failure)", async () => {
      let attempts = 0;
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/scrape-complete")) {
            attempts++;
            if (attempts < 2) {
              throw new TypeError("Failed to fetch");
            }
            return mockResponse(200, {
              id: "sess-1",
              status: "uploading",
              message: "ok",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const res = await client.scrapeComplete("sess-1", 10);
      expect(res.status).toBe("uploading");
      expect(attempts).toBe(2);
    });

    it("does NOT retry on 4xx errors", async () => {
      let attempts = 0;
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
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
        },
      );

      const client = createClient();
      await expect(client.scrapeComplete("sess-1", 10)).rejects.toThrow();
      expect(attempts).toBe(1);
    });

    it("does NOT retry on AuthenticationError", async () => {
      let scrapeAttempts = 0;
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/scrape-complete")) {
            scrapeAttempts++;
            return new Response(JSON.stringify({ detail: "Invalid API key" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      await expect(client.scrapeComplete("sess-1", 10)).rejects.toThrow(
        AuthenticationError,
      );
      // 401 triggers re-registration; authenticatedFetch retries once with new key
      // then throws AuthenticationError if retry also returns 401.
      // So scrape-complete is called twice (original + retry-within-authenticatedFetch).
      expect(scrapeAttempts).toBe(2);
    });

    it("throws ServerUnavailableError after exhausting retries on 5xx", async () => {
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
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
        },
      );

      const client = createClient();
      await expect(client.scrapeComplete("sess-1", 10)).rejects.toThrow(
        ServerUnavailableError,
      );
    }, 15000);
  });

  // -----------------------------------------------------------------------
  // 6.3 / D14 — Re-registration deadlock fix
  //
  // When the stored instance id resolves server-side to a REVOKED key,
  // re-registering with the SAME id returns the SAME dead key and every
  // request 401s forever. The 401 path must mint a FRESH instance id
  // (single-flight via the mutex, definitive failure surfaced).
  // -----------------------------------------------------------------------
  describe("re-registration deadlock (6.3 / D14)", () => {
    /** Build a fetch mock emulating the monolith's register-by-instance-id semantics. */
    function mockRevokedKeyServer(
      opts: { registerAlwaysFails?: boolean } = {},
    ) {
      const registerIds: string[] = [];
      const keysByInstance = new Map<string, string>();
      const REVOKED_INSTANCE = "ext-A";
      const REVOKED_KEY = "revoked-key-A";
      keysByInstance.set(REVOKED_INSTANCE, REVOKED_KEY);
      const sessionCallKeys: string[] = [];

      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            const body = JSON.parse((init?.body as string) ?? "{}");
            registerIds.push(body.client_id);
            if (opts.registerAlwaysFails) {
              return mockResponse(500, { detail: "registration unavailable" });
            }
            // Same instance id → SAME key (the deadlock: the id still resolves
            // to the revoked credential server-side).
            let key = keysByInstance.get(body.client_id);
            if (!key) {
              key = `fresh-key-${body.client_id}`;
              keysByInstance.set(body.client_id, key);
            }
            return mockResponse(200, {
              api_key: key,
              client_id: body.client_id,
            });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            const key = (init?.headers as Headers)?.get?.("X-API-Key") ?? "";
            sessionCallKeys.push(key);
            if (key === REVOKED_KEY) {
              return mockResponse(401, {
                detail: {
                  error: "invalid_api_key",
                  message: "Invalid or unrecognized API key",
                },
              });
            }
            return mockResponse(201, {
              id: "sess-ok",
              url: "",
              status: "scraping",
              html_chunks: 0,
              resources_discovered: null,
              resources_received: 0,
              created_at: "",
              expires_at: "",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      return { registerIds, sessionCallKeys, REVOKED_INSTANCE, REVOKED_KEY };
    }

    beforeEach(() => {
      sessionStore[EXTENSION_INSTANCE_ID_KEY] = "ext-A";
      sessionStore[API_KEY_STORAGE_KEY] = "revoked-key-A";
    });

    it("re-registers with a FRESH instance id when the stored key is revoked, then succeeds", async () => {
      const server = mockRevokedKeyServer();

      const client = createClient();
      const sessionId = await client.createSession("https://example.com");

      expect(sessionId).toBe("sess-ok");

      // Exactly one re-registration, carrying a different instance id
      expect(server.registerIds).toHaveLength(1);
      expect(server.registerIds[0]).not.toBe(server.REVOKED_INSTANCE);

      // The retried request used a key that is NOT the revoked one
      const successKeys = server.sessionCallKeys.filter(
        (k) => k !== server.REVOKED_KEY,
      );
      expect(successKeys.length).toBeGreaterThanOrEqual(1);

      // The fresh instance id is persisted to chrome.storage.session
      expect(sessionStore[EXTENSION_INSTANCE_ID_KEY]).toBe(
        server.registerIds[0],
      );
      expect(sessionStore[API_KEY_STORAGE_KEY]).toBe(
        successKeys[successKeys.length - 1],
      );
    });

    it("shares ONE fresh re-registration across concurrent 401s (single-flight)", async () => {
      const server = mockRevokedKeyServer();

      const client = createClient();
      const results = await Promise.all([
        client.createSession("https://example.com/a"),
        client.createSession("https://example.com/b"),
        client.createSession("https://example.com/c"),
      ]);

      // All three downloads succeeded with the fresh identity
      results.forEach((id) => expect(id).toBe("sess-ok"));

      // Exactly one register call total (the fresh re-registration — the
      // revoked key came from storage, so no initial registration either)
      expect(server.registerIds).toHaveLength(1);
      expect(server.registerIds[0]).not.toBe(server.REVOKED_INSTANCE);
    });

    it("surfaces AuthenticationError definitively when fresh re-registration fails", async () => {
      mockRevokedKeyServer({ registerAlwaysFails: true });

      const client = createClient();
      // AuthenticationError after the bounded attempts — no infinite loop
      await expect(client.createSession("https://example.com")).rejects.toThrow(
        AuthenticationError,
      );
    }, 15000);
  });

  // -----------------------------------------------------------------------
  // 6.5 / D4 — Cloud identity binding (POST /api/v1/cloud/link)
  // -----------------------------------------------------------------------
  describe("linkCloudAccount (6.5 cloud binding)", () => {
    /** Extract X-API-Key from either a Headers instance or a plain object. */
    function readApiKey(init?: RequestInit): string {
      const h = init?.headers as Record<string, string> | Headers | undefined;
      if (!h) return "";
      if (typeof (h as Headers).get === "function") {
        return (h as Headers).get("X-API-Key") ?? "";
      }
      return (h as Record<string, string>)["X-API-Key"] ?? "";
    }

    /**
     * Mock server: register hands out keys (optionally a revoked one first);
     * /cloud/link authenticates by key — a revoked key gets 401
     * invalid_api_key, a valid key gets the configured link response.
     */
    function mockCloudLinkServer(
      linkResponse: { status: number; body: unknown },
      opts: { firstKeyRevoked?: boolean } = {},
    ) {
      let registerCount = 0;
      const registerIds: string[] = [];
      const linkCalls: Array<{ apiKey: string; body: unknown }> = [];

      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            const body = JSON.parse((init?.body as string) ?? "{}");
            registerCount++;
            registerIds.push(body.client_id);
            const key =
              registerCount === 1 && opts.firstKeyRevoked
                ? "revoked-key"
                : `key-${registerCount}`;
            return mockResponse(200, {
              api_key: key,
              client_id: body.client_id,
            });
          }
          if (urlStr.includes("/cloud/link")) {
            const apiKey = readApiKey(init);
            linkCalls.push({
              apiKey,
              body: JSON.parse((init?.body as string) ?? "{}"),
            });
            if (apiKey === "revoked-key") {
              return mockResponse(401, {
                detail: {
                  error: "invalid_api_key",
                  message: "Invalid or unrecognized API key",
                },
              });
            }
            return mockResponse(linkResponse.status, linkResponse.body);
          }
          return mockResponse(404, {});
        },
      );

      return { registerCount: () => registerCount, registerIds, linkCalls };
    }

    it("POSTs /api/v1/cloud/link with X-API-Key + access_token and returns the binding", async () => {
      const server = mockCloudLinkServer({
        status: 200,
        body: {
          bound: true,
          pagepocket_user_id: "pp-user-1",
          plan: "pro",
          api_version: "v1",
        },
      });

      const client = createClient();
      const result = await client.linkCloudAccount("pp-access-token");

      expect(result).toEqual({
        outcome: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
      });
      // ensureApiKey ran first (login before any server call → register, then bind)
      expect(server.registerCount()).toBe(1);
      expect(server.linkCalls).toHaveLength(1);
      expect(server.linkCalls[0].apiKey).toBe("key-1");
      expect(server.linkCalls[0].body).toEqual({
        access_token: "pp-access-token",
      });
    });

    it("does NOT re-register when the PagePocket token is rejected (invalid_pagepocket_token)", async () => {
      const server = mockCloudLinkServer({
        status: 401,
        body: {
          detail: {
            error: "invalid_pagepocket_token",
            message: "PagePocket access token could not be verified",
          },
        },
      });

      const client = createClient();
      const result = await client.linkCloudAccount("bad-token");

      // The 401 here means the PAGEPOCKET token is bad — the server API key
      // must survive (no re-registration, no retry loop).
      expect(result).toEqual({ outcome: "invalid_token" });
      expect(server.registerCount()).toBe(1);
      expect(server.linkCalls).toHaveLength(1);
    });

    it("re-registers once with a fresh instance when the API key is rejected, then links", async () => {
      const server = mockCloudLinkServer(
        {
          status: 200,
          body: {
            bound: true,
            pagepocket_user_id: "pp-user-1",
            plan: "pro",
            api_version: "v1",
          },
        },
        { firstKeyRevoked: true },
      );
      // Force the first registration to reuse a known instance id
      sessionStore[EXTENSION_INSTANCE_ID_KEY] = "ext-A";

      const client = createClient();
      const result = await client.linkCloudAccount("pp-access-token");

      expect(result).toEqual({
        outcome: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
      });
      // Initial register + exactly ONE fresh-instance re-register
      expect(server.registerCount()).toBe(2);
      expect(server.registerIds[0]).toBe("ext-A");
      expect(server.registerIds[1]).not.toBe("ext-A");
      // The revoked key was answered with invalid_api_key, the fresh one linked
      expect(server.linkCalls[0].apiKey).toBe("revoked-key");
      expect(server.linkCalls[1].apiKey).toBe("key-2");
    });

    it.each([404, 501, 503])(
      "marks HTTP %i as unsupported (older server / unconfigured binding service)",
      async (status) => {
        mockCloudLinkServer({ status, body: { detail: { message: "nope" } } });

        const client = createClient();
        const result = await client.linkCloudAccount("pp-access-token");
        expect(result).toEqual({ outcome: "unsupported" });
      },
    );

    it("returns failed when a lingering 401 persists after re-registration", async () => {
      // The link endpoint rejects EVERY key with invalid_api_key — a server
      // anomaly. One re-register is attempted, then the failure is definitive
      // (no loop) and NOT misreported as a bad PagePocket token.
      let registerCount = 0;
      const registerIds: string[] = [];
      const linkCalls: string[] = [];
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            const body = JSON.parse((init?.body as string) ?? "{}");
            registerCount++;
            registerIds.push(body.client_id);
            return mockResponse(200, {
              api_key: `key-${registerCount}`,
              client_id: body.client_id,
            });
          }
          if (urlStr.includes("/cloud/link")) {
            linkCalls.push(readApiKey(init));
            return mockResponse(401, {
              detail: {
                error: "invalid_api_key",
                message: "Invalid or unrecognized API key",
              },
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const result = await client.linkCloudAccount("pp-access-token");

      expect(result).toEqual({
        outcome: "failed",
        message: "link failed after re-registration",
      });
      expect(registerCount).toBe(2);
      expect(linkCalls).toHaveLength(2);
    });

    it("returns failed on network errors", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/cloud/link")) {
          throw new TypeError("Failed to fetch");
        }
        return mockResponse(404, {});
      });

      const client = createClient();
      const result = await client.linkCloudAccount("pp-access-token");
      expect(result.outcome).toBe("failed");
    });

    it("returns failed (not thrown) when the server errors with 5xx", async () => {
      mockCloudLinkServer({
        status: 500,
        body: { detail: { message: "boom" } },
      });

      const client = createClient();
      const result = await client.linkCloudAccount("pp-access-token");
      expect(result.outcome).toBe("failed");
    });
  });

  // -----------------------------------------------------------------------
  // HttpError carries the machine-readable error code (6.5 cloud 403 mapping)
  // -----------------------------------------------------------------------
  describe("HttpError errorCode extraction", () => {
    it("exposes detail.error as errorCode on 403 responses", async () => {
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            return mockResponse(403, {
              detail: {
                error: "cloud_not_linked",
                message: "This client has no PagePocket cloud binding.",
              },
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      const err = await client
        .createSession("https://example.com")
        .catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.statusCode).toBe(403);
      expect(err.errorCode).toBe("cloud_not_linked");
    });
  });

  // -----------------------------------------------------------------------
  // deleteSession with the opt-in federated delete
  // (close-cloud-lifecycle-gaps D2 / task 3.3)
  // -----------------------------------------------------------------------
  describe("deleteSession (delete_cloud option)", () => {
    /** Capture the DELETE requests aimed at /api/v1/sessions/{id}. */
    function mockDeleteServer(): { calls: Array<{ url: string }> } {
      const calls: Array<{ url: string }> = [];
      fetchSpy.mockImplementation(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (/\/api\/v1\/sessions\/[^/]+$/.test(urlStr)) {
          calls.push({ url: urlStr });
          return mockResponse(200, { deleted: true, api_version: "v1" });
        }
        return mockResponse(404, {});
      });
      return { calls };
    }

    it("omits the query parameter by default (local-only delete)", async () => {
      const { calls } = mockDeleteServer();
      sessionStore[API_KEY_STORAGE_KEY] = "stored-session-key";

      const client = createClient();
      await client.deleteSession("sess-123");

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        "https://test-server.example.com/api/v1/sessions/sess-123",
      );
    });

    it("appends delete_cloud=true when asked (federated delete)", async () => {
      const { calls } = mockDeleteServer();
      sessionStore[API_KEY_STORAGE_KEY] = "stored-session-key";

      const client = createClient();
      await client.deleteSession("sess-123", { deleteCloud: true });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        "https://test-server.example.com/api/v1/sessions/sess-123?delete_cloud=true",
      );
    });
  });

  // -----------------------------------------------------------------------
  // unbindCloudAccount — DELETE /api/v1/cloud/link
  // (close-cloud-lifecycle-gaps D1 / task 3.1)
  // -----------------------------------------------------------------------
  describe("unbindCloudAccount (cloud unbind)", () => {
    it("DELETEs /api/v1/cloud/link with the stored API key", async () => {
      const calls: Array<{
        url: string;
        method: string;
        apiKey: string | null;
      }> = [];
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/cloud/link")) {
            calls.push({
              url: urlStr,
              method: init?.method ?? "GET",
              apiKey: new Headers(init?.headers).get("X-API-Key"),
            });
            return mockResponse(200, { bound: false, api_version: "v1" });
          }
          return mockResponse(404, {});
        },
      );
      sessionStore[API_KEY_STORAGE_KEY] = "stored-session-key";

      const client = createClient();
      const result = await client.unbindCloudAccount();

      expect(result).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        "https://test-server.example.com/api/v1/cloud/link",
      );
      expect(calls[0].method).toBe("DELETE");
      expect(calls[0].apiKey).toBe("stored-session-key");
    });

    it("reports failure on a non-2xx response without throwing", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/cloud/link")) {
          return mockResponse(401, { detail: { error: "invalid_api_key" } });
        }
        return mockResponse(404, {});
      });
      sessionStore[API_KEY_STORAGE_KEY] = "stored-session-key";

      const client = createClient();
      await expect(client.unbindCloudAccount()).resolves.toBe(false);
    });

    it("reports failure on network errors without throwing", async () => {
      fetchSpy.mockImplementation(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/cloud/link")) {
          throw new TypeError("Failed to fetch");
        }
        return mockResponse(404, {});
      });
      sessionStore[API_KEY_STORAGE_KEY] = "stored-session-key";

      const client = createClient();
      await expect(client.unbindCloudAccount()).resolves.toBe(false);
    });

    it("does not call the server when no API key exists", async () => {
      const fetchCalls: unknown[] = [];
      fetchSpy.mockImplementation(async (...args: unknown[]) => {
        fetchCalls.push(args);
        return mockResponse(404, {});
      });

      const client = createClient();
      const result = await client.unbindCloudAccount();

      expect(result).toBe(false);
      expect(fetchCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 6.1 / D6 — register() and checkHealth() are timeout-bounded
  //
  // Both call sites must pass an abort signal to fetch (the shared
  // control-call discipline). A server that accepts the connection but
  // never responds must fail within the 60s bound: checkHealth surfaces
  // ServerUnavailableError; register consumes its retry budget and fails
  // ensureApiKey with AuthenticationError — START_DOWNLOAD errors visibly
  // instead of hanging.
  //
  // Node's AbortSignal.timeout captures its internal timer at module load
  // and never fires under vitest fake timers, so the test stubs it with an
  // AbortController armed through the (faked) global setTimeout — same
  // contract (TimeoutError reason after the configured delay), fully
  // fake-timer driven, and the configured duration stays assertable.
  // -----------------------------------------------------------------------
  describe("control-call timeout on register and checkHealth (6.1 / D6)", () => {
    let timeoutSpy: vi.SpiedFunction<typeof AbortSignal.timeout>;

    beforeEach(() => {
      timeoutSpy = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms: number): AbortSignal => {
          const controller = new AbortController();
          setTimeout(
            () =>
              controller.abort(
                new DOMException("The signal timed out.", "TimeoutError"),
              ),
            ms,
          );
          return controller.signal;
        });
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    });

    /** A fetch that accepts the connection but never responds (honors the abort signal). */
    function mockHangingFetch(): void {
      fetchSpy.mockImplementation(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject((init.signal as AbortSignal).reason),
            );
          }),
      );
    }

    it("passes an abort signal to the register and health-check fetches", async () => {
      const observed: Array<{ url: string; signal: unknown }> = [];
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          observed.push({ url: urlStr, signal: init?.signal });
          if (urlStr.includes("/health")) {
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
          if (urlStr.includes("/auth/register")) {
            return mockResponse(200, { api_key: "key-1", client_id: "c1" });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            return mockResponse(201, {
              id: "sess-signal",
              url: "",
              status: "scraping",
              html_chunks: 0,
              resources_discovered: null,
              resources_received: 0,
              created_at: "",
              expires_at: "",
              api_version: "v1",
            });
          }
          return mockResponse(404, {});
        },
      );

      const client = createClient();
      await client.checkHealth();
      // createSession with no stored key → ensureApiKey → register
      await client.createSession("https://example.com");

      const health = observed.find((c) => c.url.includes("/health"));
      const register = observed.find((c) => c.url.includes("/auth/register"));
      expect(health).toBeDefined();
      expect(register).toBeDefined();
      expect(health?.signal).toBeInstanceOf(AbortSignal);
      expect(register?.signal).toBeInstanceOf(AbortSignal);
      // Both bounds come from the shared 60s control-call timeout (the
      // follow-up authenticated sessions POST gets one too).
      expect(timeoutSpy).toHaveBeenCalledWith(60 * 1000);
      expect(timeoutSpy).toHaveBeenCalledTimes(3);
    });

    it("throws ServerUnavailableError within the control-call bound when the server never responds", async () => {
      mockHangingFetch();
      vi.useFakeTimers();

      const client = createClient();
      const done = expect(client.checkHealth()).rejects.toThrow(
        ServerUnavailableError,
      );

      // Advances past exactly one control-call bound — the abort must
      // release the call here, not hang the caller.
      await vi.advanceTimersByTimeAsync(60_000);
      await done;
      expect(timeoutSpy).toHaveBeenCalledWith(60 * 1000);
    });

    it("exhausts the registration retry budget into an ensureApiKey failure within the bound", async () => {
      mockHangingFetch(); // every /auth/register fetch hangs forever
      vi.useFakeTimers();

      const client = createClient();
      // Public entry into register(): createSession → ensureApiKey → register
      const done = expect(
        client.createSession("https://example.com"),
      ).rejects.toThrow(AuthenticationError);

      // 3 attempts × 60s timeout, 1s + 2s backoff in between
      await vi.advanceTimersByTimeAsync(0); // let the storage dance complete
      await vi.advanceTimersByTimeAsync(60_000 + 1_000);
      await vi.advanceTimersByTimeAsync(60_000 + 2_000);
      await vi.advanceTimersByTimeAsync(60_000 + 1_000);
      await done;

      // Every attempt was bounded (one timeout signal per attempt)
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(timeoutSpy).toHaveBeenCalledTimes(3);
      expect(timeoutSpy).toHaveBeenCalledWith(60 * 1000);
    });
  });

  // -----------------------------------------------------------------------
  // server-assembly-honesty D11 / tasks 10.1–10.2 — register() honors
  // Retry-After on 429
  //
  // The server caps its own Retry-After hint (D5); the client honors it
  // bounded to 60 s so a hostile/buggy header can't hang the worker. The
  // wait REPLACES (never adds to) the exponential backoff and must not
  // consume an attempt — only real fetch attempts advance the bounded
  // attempt loop. A 429 without a usable header keeps the 1 s/2 s backoff.
  // -----------------------------------------------------------------------
  describe("register retry honors Retry-After (D11)", () => {
    /** Session-creation response body shared by the success paths below. */
    const SESSION_CREATED = {
      id: "sess-ra",
      url: "",
      status: "scraping",
      html_chunks: 0,
      resources_discovered: null,
      resources_received: 0,
      created_at: "",
      expires_at: "",
      api_version: "v1",
    };

    /**
     * Mock server: the first `rateLimitedAttempts.length` registration calls
     * return 429 with the given headers record; every later call succeeds.
     * Records Date.now() at each registration attempt (fake-timer clock) so
     * the tests can assert where the retry actually landed.
     */
    function mockRegisterServer(
      rateLimitedAttempts: Array<Record<string, string>>,
    ): { registerCallTimes: number[] } {
      const registerCallTimes: number[] = [];
      fetchSpy.mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (urlStr.includes("/auth/register")) {
            registerCallTimes.push(Date.now());
            const index = registerCallTimes.length - 1;
            if (index < rateLimitedAttempts.length) {
              return mockResponse(
                429,
                { detail: "rate limited" },
                rateLimitedAttempts[index],
              );
            }
            return mockResponse(200, {
              api_key: "retry-after-key",
              client_id: "c1",
            });
          }
          if (urlStr.includes("/sessions") && init?.method === "POST") {
            return mockResponse(201, SESSION_CREATED);
          }
          return mockResponse(404, {});
        },
      );
      return { registerCallTimes };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits Retry-After seconds after a 429, then succeeds on attempt 2", async () => {
      const { registerCallTimes } = mockRegisterServer([
        { "Retry-After": "5" },
      ]);
      vi.useFakeTimers();

      const client = createClient();
      const done = client.createSession("https://example.com");

      // Let the storage dance settle and the first attempt fire
      await vi.advanceTimersByTimeAsync(0);
      expect(registerCallTimes).toHaveLength(1);

      // Just under the hint: no second attempt yet — the old 1 s backoff
      // would already have fired here
      await vi.advanceTimersByTimeAsync(4_999);
      expect(registerCallTimes).toHaveLength(1);

      // Crossing the 5 s boundary releases the retry
      await vi.advanceTimersByTimeAsync(1);
      expect(registerCallTimes).toHaveLength(2);

      const sessionId = await done;
      expect(sessionId).toBe("sess-ra");
      // The retry landed at the hinted 5 s mark — not the default 1 s
      expect(registerCallTimes[1] - registerCallTimes[0]).toBe(5_000);
    });

    it("clamps Retry-After to 60 seconds", async () => {
      const { registerCallTimes } = mockRegisterServer([
        { "Retry-After": "9999" },
      ]);
      vi.useFakeTimers();

      const client = createClient();
      const done = client.createSession("https://example.com");

      await vi.advanceTimersByTimeAsync(0);
      expect(registerCallTimes).toHaveLength(1);

      // Still waiting just under the 60 s client cap — a full minute, far
      // beyond the 1 s default backoff, proving the hint was clamped
      await vi.advanceTimersByTimeAsync(59_999);
      expect(registerCallTimes).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(registerCallTimes).toHaveLength(2);

      const sessionId = await done;
      expect(sessionId).toBe("sess-ra");
      expect(registerCallTimes[1] - registerCallTimes[0]).toBe(60_000);
    });

    it("falls back to the 1s/2s exponential backoff when Retry-After is absent or unusable", async () => {
      const { registerCallTimes } = mockRegisterServer([
        {}, // no header at all
        { "Retry-After": "soon" }, // non-numeric — unusable
        { "Retry-After": "-30" }, // negative — unusable
      ]);
      vi.useFakeTimers();

      const client = createClient();
      const done = expect(
        client.createSession("https://example.com"),
      ).rejects.toThrow(AuthenticationError);

      await vi.advanceTimersByTimeAsync(0);
      expect(registerCallTimes).toHaveLength(1);

      // Attempt 2 arrives after the 1 s backoff
      await vi.advanceTimersByTimeAsync(999);
      expect(registerCallTimes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(registerCallTimes).toHaveLength(2);
      expect(registerCallTimes[1] - registerCallTimes[0]).toBe(1_000);

      // Attempt 3 arrives after the 2 s backoff (exponential growth)
      await vi.advanceTimersByTimeAsync(1_999);
      expect(registerCallTimes).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(registerCallTimes).toHaveLength(3);
      expect(registerCallTimes[2] - registerCallTimes[1]).toBe(2_000);

      // MAX_REGISTRATION_ATTEMPTS is spent — the server kept rejecting
      await done;
    });

    it("keeps attempts bounded at MAX_REGISTRATION_ATTEMPTS even when Retry-After is supplied", async () => {
      // MAX_REGISTRATION_ATTEMPTS is 3 — every attempt is rate limited,
      // each time with a usable Retry-After hint
      const { registerCallTimes } = mockRegisterServer([
        { "Retry-After": "1" },
        { "Retry-After": "1" },
        { "Retry-After": "1" },
      ]);
      vi.useFakeTimers();

      const client = createClient();
      const done = expect(
        client.createSession("https://example.com"),
      ).rejects.toThrow(AuthenticationError);

      await vi.advanceTimersByTimeAsync(0);
      expect(registerCallTimes).toHaveLength(1);

      // Retry at the hinted 1 s mark
      await vi.advanceTimersByTimeAsync(1_000);
      expect(registerCallTimes).toHaveLength(2);

      // Second retry at the hinted 1 s mark — attempt 3 of 3
      await vi.advanceTimersByTimeAsync(1_000);
      expect(registerCallTimes).toHaveLength(3);

      // A long wait never produces a 4th attempt: the budget is spent
      // (the Retry-After waits themselves consumed none of it)
      await vi.advanceTimersByTimeAsync(60_000);
      expect(registerCallTimes).toHaveLength(3);

      await done;
    });
  });
});
