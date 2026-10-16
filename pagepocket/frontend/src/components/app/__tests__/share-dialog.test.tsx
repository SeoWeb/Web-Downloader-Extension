import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/client-api", () => ({
  clientApi: {
    getLink: vi.fn(),
    createLink: vi.fn(),
    revokeLink: vi.fn(),
  },
}));

import { clientApi } from "@/lib/client-api";
import { ShareDialog } from "../share-dialog";

// ShareLinkResponse shape (lib/api/schemas). A metadata-only response
// (hash-at-rest: page-keyed lookup after a cache miss) carries an empty
// token AND empty short_url — the plaintext is unrecoverable by design.
const metadataOnlyLink = {
  token: "",
  short_url: "",
  is_public: true,
  expires_at: null,
  view_count: 3,
  created_at: "2026-01-01T00:00:00Z",
};

const revealedLink = {
  ...metadataOnlyLink,
  token: "tok123",
};

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ShareDialog pageId="p1" open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(clientApi.getLink).mockResolvedValue(metadataOnlyLink);
  vi.mocked(clientApi.createLink).mockResolvedValue(revealedLink);
  vi.mocked(clientApi.revokeLink).mockResolvedValue(revealedLink);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ShareDialog (hash-at-rest empty-token handling)", () => {
  it("shows the explanatory hint instead of a broken origin/s/ URL", async () => {
    renderDialog();
    const hint = await screen.findByRole("note");
    expect(hint).toHaveTextContent(
      /copy it from the creation screen or create a new link/i,
    );
    // Never render a tokenless /s/ URL.
    expect(screen.queryByText(/\/s\//)).not.toBeInTheDocument();
  });

  it("disables copy and open when no usable URL exists", async () => {
    renderDialog();
    await screen.findByRole("note");
    expect(screen.getByRole("button", { name: /copy link/i })).toBeDisabled();
    // Revoke needs the plaintext token too — it must not fire a doomed call.
    expect(screen.getByRole("button", { name: /revoke/i })).toBeDisabled();
  });

  it("still shows and copies a usable URL as today", async () => {
    vi.mocked(clientApi.getLink).mockResolvedValue(revealedLink);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderDialog();
    expect(await screen.findByText(/\/s\/tok123$/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /copy link/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/s/tok123`,
      );
    });
  });

  it("falls back to the create affordance when no link exists (404)", async () => {
    vi.mocked(clientApi.getLink).mockRejectedValue(new Error("not found"));
    renderDialog();
    expect(
      await screen.findByRole("button", { name: /create share link/i }),
    ).toBeInTheDocument();
  });
});
