import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/client-api", () => ({
  clientApi: {
    listPages: vi.fn(),
    listCollections: vi.fn(),
    deletePage: vi.fn(),
  },
}));

import { clientApi } from "@/lib/client-api";

// jsdom Location members are non-configurable ([LegacyUnforgeable]) — swap
// the whole window.location own property to observe navigations.
const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location")!;
let assign: ReturnType<typeof vi.fn>;

// The dashboard wires an IntersectionObserver for infinite scroll on mount.
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);

const { Dashboard } = await import("../dashboard");

const page = {
  id: "test-page-id",
  user_id: "user-1",
  url: "https://example.com/article",
  title: "Example Page",
  archived_at: "2026-01-01T00:00:00",
  collection_id: null,
};

const initialData = {
  pages: [page],
  total: 1,
  page: 1,
  page_size: 20,
};

function renderDashboard({
  initialData: initial,
}: { initialData?: typeof initialData } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard initialData={initial} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    value: { assign },
    writable: true,
    configurable: true,
  });
  // initialData is stale at mount (staleTime 0) — the refetch must resolve
  // to a well-formed ListPagesResponse or the infinite-query shape breaks.
  vi.mocked(clientApi.listPages).mockResolvedValue(initialData);
});

afterEach(() => {
  Object.defineProperty(window, "location", locationDescriptor);
  cleanup();
  vi.clearAllMocks();
});

describe("Dashboard card Download wiring", () => {
  it("offers Download in the card menu above Share", async () => {
    renderDashboard({ initialData });
    await userEvent.click(screen.getByRole("button", { name: "Page actions" }));
    const download = await screen.findByRole("menuitem", { name: "Download" });
    const names = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim());
    expect(names[0]).toBe("Download");
    expect(names).toContain("Share");
    expect(download).toBeInTheDocument();
  });

  it("navigates to the archive ZIP endpoint for that page from the card menu", async () => {
    renderDashboard({ initialData });
    await userEvent.click(screen.getByRole("button", { name: "Page actions" }));
    const download = await screen.findByRole("menuitem", { name: "Download" });
    await userEvent.click(download);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      "/api/pp/archive/pages/test-page-id/zip",
    );
  });
});

// SSR fallback contract (app/page.tsx loadInitialPages): when the initial
// server fetch fails, Dashboard mounts with no initialData and must show its
// loading state, then hydrate from the client-side query — never crash.
describe("Dashboard without SSR initialData (SSR fetch fallback)", () => {
  it("renders the loading skeleton, then hydrates from the client fetch", async () => {
    let resolveList: (value: typeof initialData) => void = () => {};
    vi.mocked(clientApi.listPages).mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );

    const { container } = renderDashboard();

    // Query still in flight — skeleton, not the card list or empty state.
    expect(screen.queryByText("Example Page")).not.toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();

    resolveList(initialData);
    expect(await screen.findByText("Example Page")).toBeInTheDocument();
  });

  it("renders the empty state without crashing when the client fetch returns no pages", async () => {
    vi.mocked(clientApi.listPages).mockResolvedValue({
      pages: [],
      total: 0,
      page: 1,
      page_size: 20,
    });

    renderDashboard();

    expect(await screen.findByText("No saved pages yet")).toBeInTheDocument();
  });
});
