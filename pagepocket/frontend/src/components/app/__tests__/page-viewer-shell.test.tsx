import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Shared, observable next/navigation stubs (same shape as
// page-format-viewer.test.tsx): tests seed `nav.pathname`/`nav.params` (the
// URL the shell is mounted on) and assert `nav.push` (the back destination).
const nav = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/app/pages/test-page-id",
  params: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: nav.push,
    replace: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.params,
}));

// Mock share dialog to avoid pulling in React Query provider
vi.mock("../share-dialog", () => ({
  ShareDialog: () => null,
}));

const { PageViewerShell } = await import("../page-viewer-shell");

function renderShell() {
  return render(<PageViewerShell pageId="test-page-id" pageMeta={null} />);
}

// jsdom marks Location members ([LegacyUnforgeable]) non-configurable, so
// vi.spyOn(window.location, "assign") cannot wrap it. window.location itself
// IS a configurable own property of window — swap it for a stub exposing
// `assign` and restore the original descriptor afterwards.
const DOWNLOAD_LABEL =
  "Download as ZIP — static snapshot, scripts not included";
const ZIP_URL = "/api/pp/archive/pages/test-page-id/zip";
const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location")!;
let assign: ReturnType<typeof vi.fn>;

const CURRENT = "/app/pages/test-page-id";

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    value: { assign },
    writable: true,
    configurable: true,
  });
  sessionStorage.clear();
  vi.clearAllMocks();
  nav.push.mockReset();
  nav.pathname = CURRENT;
  nav.params = new URLSearchParams();
});

afterEach(() => {
  Object.defineProperty(window, "location", locationDescriptor);
});

function seedTrail(entries: string[]) {
  sessionStorage.setItem("pp_nav_history", JSON.stringify(entries));
}

// Mount the shell, run its effects (the trail recorder), and return the
// router mock's push for destination assertions.
async function renderAndClickBack() {
  renderShell();
  await userEvent.click(
    screen.getByRole("button", { name: "Back to library" }),
  );
  return nav.push;
}

describe("PageViewerShell", () => {
  it("renders iframe with correct sandbox attribute", () => {
    renderShell();
    const iframe = screen.getByTitle("Saved page content");
    expect(iframe).toHaveAttribute("sandbox", "allow-popups allow-forms");
  });

  it("does not include forbidden sandbox tokens", () => {
    renderShell();
    const iframe = screen.getByTitle("Saved page content");
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-scripts-same-origin");
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allowfullscreen");
  });

  it("does not have allowfullscreen attribute", () => {
    renderShell();
    const iframe = screen.getByTitle("Saved page content");
    expect(iframe).not.toHaveAttribute("allowfullscreen");
  });

  it("renders a Download button with honest static-snapshot labeling", () => {
    renderShell();
    const button = screen.getByRole("button", { name: DOWNLOAD_LABEL });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("title", DOWNLOAD_LABEL);
  });

  it("navigates to the archive ZIP endpoint when Download is clicked", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: DOWNLOAD_LABEL }));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(ZIP_URL);
  });

  it("navigates to the archive ZIP endpoint on the d hotkey", () => {
    renderShell();
    fireEvent.keyDown(document.body, { key: "d" });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(ZIP_URL);
  });

  it("ignores the d hotkey while typing in an input", () => {
    renderShell();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "d" });
    expect(assign).not.toHaveBeenCalled();
    input.remove();
  });

  describe("back navigation (sessionStorage trail)", () => {
    it("goes to the previous in-app path (library) when the trail has it", async () => {
      seedTrail(["/app", CURRENT]);
      const push = await renderAndClickBack();
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/app");
    });

    it("goes to the collection the page was opened from", async () => {
      seedTrail(["/app", "/app/collections/c1", CURRENT]);
      const push = await renderAndClickBack();
      expect(push).toHaveBeenCalledWith("/app/collections/c1");
    });

    it("falls back to /app on a deep link (empty trail)", async () => {
      const push = await renderAndClickBack();
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/app");
    });

    it("never pushes the current URL after a self-reload (deduped trail)", async () => {
      // Reload scenario: the trail ends with the current path because the
      // recorder dedupes the re-recorded entry; back must not no-op.
      seedTrail(["/app", CURRENT]);
      const push = await renderAndClickBack();
      expect(push).toHaveBeenCalledWith("/app");
      expect(push).not.toHaveBeenCalledWith(CURRENT);
    });

    it("walks back past the current path when only a ?format= variant was recorded", async () => {
      seedTrail([CURRENT, `${CURRENT}?format=md`]);
      nav.params = new URLSearchParams({ format: "md" });
      const push = await renderAndClickBack();
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith(CURRENT);
      expect(push).not.toHaveBeenCalledWith(`${CURRENT}?format=md`);
    });

    it("Escape uses the same back handler", async () => {
      seedTrail(["/app", CURRENT]);
      renderShell();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(nav.push).toHaveBeenCalledTimes(1);
      expect(nav.push).toHaveBeenCalledWith("/app");
    });
  });
});
