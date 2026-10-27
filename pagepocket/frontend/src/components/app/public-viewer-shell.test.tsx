import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// PageFormatViewer (multi-format branch) reads the router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/s/tok123",
  useSearchParams: () => new URLSearchParams(),
}));

// Keep the real helpers (URL building, response mapping) — mock only the
// share-images fetch (image gallery feature).
vi.mock("@/lib/gallery", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchSharePageImages: vi.fn(),
}));

import { fetchSharePageImages } from "@/lib/gallery";

const { PublicViewerShell } = await import("./public-viewer-shell");

const galleryListing = {
  images: [
    { path: "assets/alpha.jpg", content_type: "image/jpeg", size_bytes: 11 },
    { path: "assets/beta.png", content_type: "image/png", size_bytes: 22 },
  ],
  is_image_gallery: true,
  total: 2,
};

function renderShell(formats?: string[]) {
  return render(
    <PublicViewerShell
      token="tok123"
      {...(formats === undefined ? {} : { formats })}
    />,
  );
}

beforeEach(() => {
  // Default probe outcome: no gallery → every pre-gallery test gets the
  // bare iframe back once the probe settles.
  vi.mocked(fetchSharePageImages).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PublicViewerShell", () => {
  it("iframe sandbox excludes allow-same-origin (origin isolation)", async () => {
    renderShell();

    const iframe = await screen.findByTitle("Shared page content");
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("iframe sandbox keeps popups and forms working, never grants scripts", async () => {
    renderShell();

    const iframe = await screen.findByTitle("Shared page content");
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-popups");
    expect(sandbox).toContain("allow-forms");
    expect(sandbox).not.toContain("allow-scripts");
  });

  describe("image gallery (share side)", () => {
    it("probes html-only shares once and renders the gallery when the listing answers", async () => {
      vi.mocked(fetchSharePageImages).mockResolvedValue(galleryListing);

      renderShell([]);

      const thumbs = await screen.findAllByRole("img");
      expect(thumbs).toHaveLength(2);
      expect(thumbs[0]).toHaveAttribute(
        "src",
        "/api/sc/tok123/f/assets/alpha.jpg",
      );
      expect(thumbs[0]).toHaveAttribute("loading", "lazy");
      expect(screen.getByText("2 images")).toBeInTheDocument();
      expect(fetchSharePageImages).toHaveBeenCalledTimes(1);
      expect(fetchSharePageImages).toHaveBeenCalledWith("tok123");
      // The gallery replaces the iframe entirely.
      expect(
        screen.queryByTitle("Shared page content"),
      ).not.toBeInTheDocument();
    });

    it("falls back to the sandboxed iframe when the probe fails", async () => {
      renderShell([]);

      const iframe = await screen.findByTitle("Shared page content");
      expect(iframe).toHaveAttribute("sandbox", "allow-popups allow-forms");
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("falls back to the iframe when the listing answers non-gallery", async () => {
      vi.mocked(fetchSharePageImages).mockResolvedValue({
        images: [{ path: "assets/x.jpg" }],
        is_image_gallery: false,
        total: 1,
      });

      renderShell([]);

      const iframe = await screen.findByTitle("Shared page content");
      expect(iframe).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("falls back when the listing is a gallery without images (total 0)", async () => {
      vi.mocked(fetchSharePageImages).mockResolvedValue({
        images: [],
        is_image_gallery: true,
        total: 0,
      });

      renderShell([]);

      expect(
        await screen.findByTitle("Shared page content"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("never probes format-switcher shares (markdown/text known)", async () => {
      renderShell(["html", "markdown"]);

      expect(await screen.findByText("Markdown")).toBeInTheDocument();
      expect(fetchSharePageImages).not.toHaveBeenCalled();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("probes unknown-format shares too — gallery archives from an older validation response still render", async () => {
      vi.mocked(fetchSharePageImages).mockResolvedValue(galleryListing);

      renderShell(undefined);

      const thumbs = await screen.findAllByRole("img");
      expect(thumbs).toHaveLength(2);
      expect(fetchSharePageImages).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByTitle("Shared page content"),
      ).not.toBeInTheDocument();
    });
  });
});
