import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
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

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    value: { assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", locationDescriptor);
});

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
});
