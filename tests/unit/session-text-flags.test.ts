/**
 * Tests for the text-native-downloads session-create contract
 * (design D1 / spec "Format options propagate in session options").
 *
 * The POST /sessions body options must carry the FULL format selection:
 * `downloadHtml` and `downloadContentAsText` alongside the existing
 * `singleFile` / `downloadContentAsMarkdown` — always sent explicitly,
 * never omitted.
 *
 * All HTTP calls are mocked via global fetch — same harness as
 * server-client.test.ts.
 */

import { ServerClient } from "../../src/background/server-client";

// ---------------------------------------------------------------------------
// chrome.storage.session mock (credentials persist there since D11) —
// each vitest test file gets a fresh environment, so this does not leak.
// ---------------------------------------------------------------------------

const sessionStore: Record<string, unknown> = {};

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).session = {
    _store: sessionStore, // Exposed for test cleanup
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(): ServerClient {
  return new ServerClient();
}

/** Build a mock Response object. */
function mockResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Standard 201 session-create response body. */
function sessionCreated(id: string) {
  return {
    id,
    url: "https://example.com",
    status: "scraping",
    html_chunks: 0,
    resources_discovered: null,
    resources_received: 0,
    created_at: "",
    expires_at: "",
    api_version: "v1",
  };
}

/** Route the register + session-create calls, capturing the create body. */
function mockFetchWithCapture(captured: { body: Record<string, any> | null }) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/auth/register")) {
          return mockResponse(200, { api_key: "key-1", client_id: "c1" });
        }
        if (urlStr.includes("/sessions") && init?.method === "POST") {
          captured.body = JSON.parse(init.body as string);
          return mockResponse(201, sessionCreated("sess-text-1"));
        }
        return mockResponse(404, {});
      },
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSession — text-native format flags (D1)", () => {
  let fetchSpy: vi.SpiedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("sends downloadHtml: false and downloadContentAsText: true for a text-only selection (spec scenario)", async () => {
    const captured: { body: Record<string, any> | null } = { body: null };
    fetchSpy = mockFetchWithCapture(captured);

    const client = createClient();
    await client.createSession("https://example.com", {
      downloadHtml: false,
      downloadContentAsText: true,
      downloadContentAsMarkdown: true,
    });

    expect(captured.body?.options).toBeDefined();
    // The exact spec scenario: HTML deselected, content-as-text selected
    expect(captured.body.options.downloadHtml).toBe(false);
    expect(captured.body.options.downloadContentAsText).toBe(true);
  });

  it("always sends both flags explicitly, even when the caller omits them", async () => {
    const captured: { body: Record<string, any> | null } = { body: null };
    fetchSpy = mockFetchWithCapture(captured);

    const client = createClient();
    await client.createSession("https://example.com", {
      singleFile: true,
      retentionDays: 14,
    });

    const options = captured.body?.options ?? {};
    // No omission: the keys exist on every session creation
    expect("downloadHtml" in options).toBe(true);
    expect("downloadContentAsText" in options).toBe(true);
    // downloadHtml defaults to the current behavior (HTML included)
    expect(options.downloadHtml).toBe(true);
    expect(options.downloadContentAsText).toBe(false);
    // Existing flags untouched
    expect(options.singleFile).toBe(true);
    expect(options.downloadContentAsMarkdown).toBe(false);
    expect(options.retentionDays).toBe(14);
  });

  it("defaults both flags for an empty options object", async () => {
    const captured: { body: Record<string, any> | null } = { body: null };
    fetchSpy = mockFetchWithCapture(captured);

    const client = createClient();
    await client.createSession("https://example.com", {});

    expect(captured.body?.options.downloadHtml).toBe(true);
    expect(captured.body?.options.downloadContentAsText).toBe(false);
  });

  it("still carries the markdown flag alongside the new ones", async () => {
    const captured: { body: Record<string, any> | null } = { body: null };
    fetchSpy = mockFetchWithCapture(captured);

    const client = createClient();
    await client.createSession("https://example.com", {
      downloadHtml: true,
      downloadContentAsMarkdown: true,
      downloadContentAsText: true,
    });

    expect(captured.body?.options.downloadHtml).toBe(true);
    expect(captured.body?.options.downloadContentAsMarkdown).toBe(true);
    expect(captured.body?.options.downloadContentAsText).toBe(true);
  });
});
