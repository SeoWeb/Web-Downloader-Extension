import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuthenticationError } from "@/lib/api/errors";

// The page module pulls in next/headers (via @/lib/api/archive) which is
// request-scoped and unavailable under vitest — mock the archive module.
vi.mock("@/lib/api/archive", () => ({
  archive: { listPages: vi.fn() },
}));

import { archive } from "@/lib/api/archive";

const { loadInitialPages } = await import("./page");

const initialData = {
  pages: [
    {
      id: "test-page-id",
      user_id: "user-1",
      url: "https://example.com/article",
      title: "Example Page",
      archived_at: "2026-01-01T00:00:00",
      collection_id: null,
      content_formats: ["html"],
    },
  ],
  total: 1,
  page: 1,
  page_size: 20,
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("loadInitialPages (dashboard SSR hydration)", () => {
  it("returns the fetched first page so Dashboard renders hydrated", async () => {
    vi.mocked(archive.listPages).mockResolvedValue(initialData);

    await expect(loadInitialPages()).resolves.toEqual(initialData);
    expect(archive.listPages).toHaveBeenCalledWith({
      page: 1,
      page_size: 20,
      sort_by: "archived_at",
    });
  });

  it("falls back to undefined (client refetch) when the stale-token fetch 401s", async () => {
    vi.mocked(archive.listPages).mockRejectedValue(new AuthenticationError());

    await expect(loadInitialPages()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "[app] initial page list fetch failed, falling back to client fetch",
      expect.any(AuthenticationError),
    );
  });

  it("falls back to undefined on network errors too", async () => {
    vi.mocked(archive.listPages).mockRejectedValue(
      new TypeError("fetch failed"),
    );

    await expect(loadInitialPages()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "[app] initial page list fetch failed, falling back to client fetch",
      expect.any(TypeError),
    );
  });
});
