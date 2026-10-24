import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/client-api", () => ({
  clientApi: {
    getStorageUsage: vi.fn(),
  },
}));

// The meter reads the session from the query provider. A module-level ref
// lets each test pick the userId (or none) without remounting the real
// provider — same shape as useQK()'s ["user", userId, ...keys] keys.
const session: { userId: string | null } = { userId: "user-1" };
vi.mock("@/components/providers/query-provider", () => ({
  useUserId: () => session.userId,
  useQK:
    () =>
    (...keys: unknown[]) =>
      session.userId ? ["user", session.userId, ...keys] : keys,
}));

import { clientApi } from "@/lib/client-api";

const { StorageMeter } = await import("../storage-meter");

const MIB = 1024 * 1024;

// Free plan: 500 MB limit (spec scenario values).
const freeUsage = {
  used_bytes: 50 * MIB,
  storage_limit_bytes: 500 * MIB,
  plan: "free",
  pages_this_month: 12,
  page_limit_monthly: 50,
  quota_reset_at: "2026-11-01T00:00:00Z",
};

function usage(partial: Partial<typeof freeUsage>) {
  return { ...freeUsage, ...partial };
}

function renderMeter() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <StorageMeter />
    </QueryClientProvider>,
  );
}

function fillOf(container: HTMLElement): HTMLElement {
  const bar = container.querySelector('[role="progressbar"]');
  return bar?.firstElementChild as HTMLElement;
}

beforeEach(() => {
  session.userId = "user-1";
  vi.mocked(clientApi.getStorageUsage).mockResolvedValue(freeUsage);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StorageMeter (storage-usage-display, design D6)", () => {
  it("renders used-of-limit text, the plan badge, and a proportional fill", async () => {
    const { container } = renderMeter();

    expect(await screen.findByText("50 MB of 500 MB used")).toBeInTheDocument();
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(fillOf(container).style.width).toBe("10%");
    expect(fillOf(container).className).toContain("bg-emerald-500");
  });

  it("shows the Pro badge and the 10 GB limit for a pro plan", async () => {
    vi.mocked(clientApi.getStorageUsage).mockResolvedValue(
      usage({
        plan: "pro",
        used_bytes: 700 * MIB,
        storage_limit_bytes: 10 * 1024 * MIB,
      }),
    );
    renderMeter();

    expect(await screen.findByText("700 MB of 10 GB used")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
  });

  it("capitalizes unknown plan names as-is", async () => {
    vi.mocked(clientApi.getStorageUsage).mockResolvedValue(
      usage({ plan: "enterprise" }),
    );
    renderMeter();

    expect(await screen.findByText("Enterprise")).toBeInTheDocument();
  });

  it("renders amber at exactly 75% usage", async () => {
    vi.mocked(clientApi.getStorageUsage).mockResolvedValue(
      usage({ used_bytes: 375 * MIB }),
    );
    const { container } = renderMeter();

    await screen.findByText("375 MB of 500 MB used");
    expect(fillOf(container).style.width).toBe("75%");
    expect(fillOf(container).className).toContain("bg-amber-500");
  });

  it("renders red at exactly 90% usage", async () => {
    vi.mocked(clientApi.getStorageUsage).mockResolvedValue(
      usage({ used_bytes: 450 * MIB }),
    );
    const { container } = renderMeter();

    await screen.findByText("450 MB of 500 MB used");
    expect(fillOf(container).style.width).toBe("90%");
    expect(fillOf(container).className).toContain("bg-red-500");
  });

  it("clamps the fill to 100% red when over the limit", async () => {
    vi.mocked(clientApi.getStorageUsage).mockResolvedValue(
      usage({ used_bytes: 550 * MIB }),
    );
    const { container } = renderMeter();

    await screen.findByText("550 MB of 500 MB used");
    expect(fillOf(container).style.width).toBe("100%");
    expect(fillOf(container).className).toContain("bg-red-500");
  });

  it("renders a quiet skeleton while the query is loading", async () => {
    vi.mocked(clientApi.getStorageUsage).mockReturnValue(
      new Promise(() => {}), // never resolves
    );
    const { container } = renderMeter();

    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText(/of.*used/)).not.toBeInTheDocument();
    expect(clientApi.getStorageUsage).toHaveBeenCalledTimes(1);
  });

  it("renders nothing on query error instead of breaking the sidebar", async () => {
    vi.mocked(clientApi.getStorageUsage).mockRejectedValue(new Error("boom"));
    const { container } = renderMeter();

    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("never fetches (and stays hidden) without a userId", async () => {
    session.userId = null;
    const { container } = renderMeter();

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(clientApi.getStorageUsage).not.toHaveBeenCalled();
  });
});
