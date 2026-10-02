import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
  return render(
    <PageViewerShell pageId="test-page-id" pageMeta={null} />,
  );
}

describe("PageViewerShell", () => {
  it("renders iframe with correct sandbox attribute", () => {
    renderShell();
    const iframe = screen.getByTitle("Saved page content");
    expect(iframe).toHaveAttribute(
      "sandbox",
      "allow-same-origin allow-popups allow-forms",
    );
  });

  it("does not include forbidden sandbox tokens", () => {
    renderShell();
    const iframe = screen.getByTitle("Saved page content");
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-scripts-same-origin");
    expect(sandbox).not.toContain("allowfullscreen");
  });

  it("does not have allowfullscreen attribute", () => {
    renderShell();
    const iframe = screen.getByTitle("Saved page content");
    expect(iframe).not.toHaveAttribute("allowfullscreen");
  });
});
