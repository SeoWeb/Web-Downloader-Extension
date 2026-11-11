import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NetworkError, NotFoundError } from "@/lib/api/errors";

// next/headers is request-scoped and unavailable under vitest — stand-ins
// with no access token keep the REAL archive.getPage running below.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

// Mock the transport, not the archive client: the real getPage 404→null /
// transient→throw mapping (multipage 8.4) is exactly what is under test.
vi.mock("@/lib/api/http", () => ({
  serverFetch: vi.fn(),
}));

// Observable router stub: tests assert refresh (the Retry mechanism) and
// push (a back navigation that must NOT happen from the error state).
const nav = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
}));

// Real notFound() throws a Next-internal sentinel — replace it with a plain
// throw the tests can await/reject on.
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useRouter: () => ({
    refresh: nav.refresh,
    push: nav.push,
    replace: vi.fn(),
    back: vi.fn(),
  }),
}));

// The shell pulls in the whole viewer tree — a stub isolates the route's
// failure split.
vi.mock("@/components/app/page-viewer-shell", () => ({
  PageViewerShell: () => <div data-testid="viewer-shell" />,
}));

import { serverFetch } from "@/lib/api/http";
import { notFound } from "next/navigation";

const { default: ViewPagePage } = await import("./page");

function renderRoute() {
  return ViewPagePage({ params: Promise.resolve({ pageId: "p1" }) });
}

const PAGE_JSON = {
  id: "p1",
  user_id: "u1",
  url: "https://example.com",
  title: "Example",
  archived_at: "2026-01-01T00:00:00",
  content_formats: ["html"],
};

beforeEach(() => {
  vi.mocked(notFound).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ViewPagePage failure split (multipage-download-fixes 8.4)", () => {
  it("renders the viewer shell on success", async () => {
    vi.mocked(serverFetch).mockResolvedValue(PAGE_JSON);

    const tree = await renderRoute();
    render(tree);
    expect(screen.getByTestId("viewer-shell")).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("gateway 404 (absent or not owned page) → notFound(), unchanged", async () => {
    // The gateway surfaces NOT_FOUND upstream as HTTP 404; serverFetch
    // throws NotFoundError and the real getPage maps it to null.
    vi.mocked(serverFetch).mockRejectedValue(new NotFoundError());

    await expect(renderRoute()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("network failure → retryable error state, NOT notFound", async () => {
    vi.mocked(serverFetch).mockRejectedValue(new NetworkError());

    render(await renderRoute());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This page could not be loaded.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("gateway 5xx failure → retryable error state, NOT notFound", async () => {
    vi.mocked(serverFetch).mockRejectedValue(
      new Error("API error 503: Service Unavailable"),
    );

    render(await renderRoute());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("Retry re-runs the server component (router.refresh)", async () => {
    vi.mocked(serverFetch).mockRejectedValue(new NetworkError());

    render(await renderRoute());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});
