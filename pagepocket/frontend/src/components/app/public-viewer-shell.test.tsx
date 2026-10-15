import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

const { PublicViewerShell } = await import("./public-viewer-shell");

describe("PublicViewerShell", () => {
  it("iframe sandbox excludes allow-same-origin (origin isolation)", () => {
    render(<PublicViewerShell token="tok" />);
    const iframe = screen.getByTitle("Shared page content");
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("iframe sandbox keeps popups and forms working, never grants scripts", () => {
    render(<PublicViewerShell token="tok" />);
    const iframe = screen.getByTitle("Shared page content");
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-popups");
    expect(sandbox).toContain("allow-forms");
    expect(sandbox).not.toContain("allow-scripts");
  });
});
