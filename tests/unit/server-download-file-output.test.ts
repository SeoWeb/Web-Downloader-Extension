/**
 * Tests for the generalized server output payload
 * (text-native-downloads D3 / task 6.2).
 *
 * `output_type` may now be "file" — a raw single-file artifact (raw
 * .md/.txt) accompanied by `output_filename` / `output_content_type`. The
 * download saver must save under output_filename's extension (never
 * forcing .zip/.html), while html/zip outputs keep byte-identical
 * behavior to before.
 *
 * Same harness as server-download.test.ts: chrome.downloads is mocked,
 * HTTP via a spied ServerClient.
 */

import { ServerDownloadHandler } from "../../src/background/server-download";
import {
  ServerClient,
  SessionStatusResponse,
} from "../../src/background/server-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock SessionStatusResponse. */
function mockStatus(
  overrides: Partial<SessionStatusResponse> = {},
): SessionStatusResponse {
  return {
    id: "test-session-id",
    status: "ready",
    url: "https://example.com/page",
    html_chunks: 5,
    resources_discovered: 10,
    resources_received: 10,
    total_size: 1024,
    assembly_phase: null,
    assembly_progress_pct: 100,
    assembly_elapsed_seconds: null,
    download_url: "http://localhost:8000/api/v1/sessions/test/download",
    output_type: null,
    output_size: null,
    error_message: null,
    api_version: "v1",
    ...overrides,
  };
}

function createHandler(): {
  handler: ServerDownloadHandler;
  mockGetSessionStatus: vi.SpiedFunction<ServerClient["getSessionStatus"]>;
} {
  const client = new ServerClient();
  const mockGetSessionStatus = vi.spyOn(client, "getSessionStatus");
  const handler = new ServerDownloadHandler(client);
  return { handler, mockGetSessionStatus };
}

// ---------------------------------------------------------------------------
// chrome.downloads mock (same shape as server-download.test.ts)
// ---------------------------------------------------------------------------

let mockChromeDownloadsDownload: vi.Mock;
let mockChromeRuntimeLastError: { message: string } | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2025, 0, 1, 0, 0, 0));

  mockChromeDownloadsDownload = vi.fn();
  mockChromeRuntimeLastError = undefined;

  (globalThis.chrome as any).downloads = {
    download: mockChromeDownloadsDownload,
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    get lastError() {
      return mockChromeRuntimeLastError;
    },
    connect: vi.fn().mockReturnValue({
      name: "keepalive",
      onDisconnect: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    }),
  };

  mockChromeDownloadsDownload.mockImplementation(
    (options: any, callback: (id: number) => void) => {
      callback(42);
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("waitForDownload — raw single-file output (output_type: file)", () => {
  it("saves a file output under output_filename's .md extension, not .zip", async () => {
    const { handler, mockGetSessionStatus } = createHandler();

    mockGetSessionStatus.mockResolvedValue(
      mockStatus({
        status: "ready",
        output_type: "file",
        output_filename: "content.md",
        output_content_type: "text/markdown; charset=utf-8",
      }),
    );

    const result = await handler.waitForDownload(
      "test-session-id",
      "https://example.com/page",
      false, // isSingleFile — irrelevant for a "file" output
    );

    // .md, NOT .zip
    expect(result.filename).toMatch(/\.md$/);
    expect(result.filename).not.toMatch(/\.zip$/);
    expect(mockChromeDownloadsDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: expect.stringMatching(/\.md$/),
      }),
      expect.any(Function),
    );
  });

  it("saves a .txt file output under the .txt extension", async () => {
    const { handler, mockGetSessionStatus } = createHandler();

    mockGetSessionStatus.mockResolvedValue(
      mockStatus({
        status: "ready",
        output_type: "file",
        output_filename: "content.txt",
        output_content_type: "text/plain; charset=utf-8",
      }),
    );

    const result = await handler.waitForDownload(
      "test-session-id",
      "https://example.com/page",
      false,
    );

    expect(result.filename).toMatch(/\.txt$/);
  });

  it("falls back to the content-type map when output_filename has no usable extension", async () => {
    const { handler, mockGetSessionStatus } = createHandler();

    mockGetSessionStatus.mockResolvedValue(
      mockStatus({
        status: "ready",
        output_type: "file",
        output_filename: null,
        output_content_type: "text/markdown",
      }),
    );

    const result = await handler.waitForDownload(
      "test-session-id",
      "https://example.com/page",
      false,
    );

    expect(result.filename).toMatch(/\.md$/);
  });

  it("falls back to .txt for a text/plain file output without a filename", async () => {
    const { handler, mockGetSessionStatus } = createHandler();

    mockGetSessionStatus.mockResolvedValue(
      mockStatus({
        status: "ready",
        output_type: "file",
        output_filename: null,
        output_content_type: "text/plain",
      }),
    );

    const result = await handler.waitForDownload(
      "test-session-id",
      "https://example.com/page",
      false,
    );

    expect(result.filename).toMatch(/\.txt$/);
  });

  it("keeps the hostname-path-timestamp base name for file outputs", async () => {
    const { handler, mockGetSessionStatus } = createHandler();

    mockGetSessionStatus.mockResolvedValue(
      mockStatus({
        status: "ready",
        output_type: "file",
        output_filename: "content.md",
        output_content_type: "text/markdown",
      }),
    );

    const result = await handler.waitForDownload(
      "test-session-id",
      "https://example.com/some/page",
      false,
    );

    expect(result.filename).toMatch(/^example\.com-some-page-\d+\.md$/);
  });

  it("uses .bin for a file output with no filename and an unknown content type", async () => {
    const { handler, mockGetSessionStatus } = createHandler();

    mockGetSessionStatus.mockResolvedValue(
      mockStatus({
        status: "ready",
        output_type: "file",
        output_filename: "artifact",
        output_content_type: "application/octet-stream",
      }),
    );

    const result = await handler.waitForDownload(
      "test-session-id",
      "https://example.com/page",
      false,
    );

    expect(result.filename).toMatch(/\.bin$/);
  });
});

describe("waitForDownload — html/zip outputs unchanged", () => {
  it("keeps .zip for zip outputs", async () => {
    const { handler, mockGetSessionStatus } = createHandler();

    mockGetSessionStatus.mockResolvedValue(
      mockStatus({
        status: "ready",
        output_type: "zip",
        output_filename: null,
        output_content_type: null,
      }),
    );

    const result = await handler.waitForDownload(
      "test-session-id",
      "https://example.com/page",
      false, // not single-file
    );

    expect(result.filename).toMatch(/\.zip$/);
  });

  it("keeps .html for single-file (html) outputs", async () => {
    const { handler, mockGetSessionStatus } = createHandler();

    mockGetSessionStatus.mockResolvedValue(
      mockStatus({
        status: "ready",
        output_type: "html",
        output_filename: null,
        output_content_type: null,
      }),
    );

    const result = await handler.waitForDownload(
      "test-session-id",
      "https://example.com/page",
      true, // single-file
    );

    expect(result.filename).toMatch(/\.html$/);
  });
});
