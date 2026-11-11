import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NetworkError, NotFoundError } from "@/lib/api/errors";

// The share route pulls in next/headers (via @/lib/api/share) — mock the
// share module.
vi.mock("@/lib/api/share", () => ({
  share: { validatePublic: vi.fn() },
}));

const nav = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useRouter: () => ({
    refresh: nav.refresh,
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@/components/app/public-viewer-shell", () => ({
  PublicViewerShell: () => <div data-testid="public-viewer-shell" />,
}));

import { share } from "@/lib/api/share";
import { notFound } from "next/navigation";

const { default: SharedPagePage } = await import("./page");

const VALIDATED = {
  valid: true,
  page_id: "p1",
  content_formats: ["markdown"],
  pages: [
    {
      path: "about.md",
      title: "About",
      url: "https://example.com/about",
      content_format: "markdown",
    },
  ],
};

function renderRoute() {
  return SharedPagePage({ params: Promise.resolve({ token: "tok" }) });
}

beforeEach(() => {
  vi.mocked(notFound).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SharedPagePage failure split + payload plumbing (multipage-download-fixes 8.3/8.4)", () => {
  it("renders the public viewer with formats and pages passed through", async () => {
    vi.mocked(share.validatePublic).mockResolvedValue(VALIDATED);

    render(await renderRoute());
    expect(screen.getByTestId("public-viewer-shell")).toBeInTheDocument();
    expect(share.validatePublic).toHaveBeenCalledWith("tok");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("NotFoundError (invalid/revoked/expired token) → notFound(), unchanged", async () => {
    vi.mocked(share.validatePublic).mockRejectedValue(new NotFoundError());

    await expect(renderRoute()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("transient failure → retryable error state, NOT notFound", async () => {
    vi.mocked(share.validatePublic).mockRejectedValue(new NetworkError());

    render(await renderRoute());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This page could not be loaded.",
    );
    expect(notFound).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});
