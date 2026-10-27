import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Shared, observable next/navigation stub (same shape as
// page-format-viewer.test.tsx): tests assert `nav.push` (the back
// destination).
const nav = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: nav.push,
    replace: vi.fn(),
    back: vi.fn(),
  }),
}));

// Mock share dialog to avoid pulling in React Query provider
vi.mock("../share-dialog", () => ({
  ShareDialog: () => null,
}));

vi.mock("@/lib/client-api", () => ({
  clientApi: {
    listPageImages: vi.fn(),
  },
}));

import { clientApi } from "@/lib/client-api";
import type { PageImagesResponse, PageResponse } from "@/lib/api/schemas";

const { PageViewerShell } = await import("../page-viewer-shell");

function renderShell() {
  return render(<PageViewerShell pageId="test-page-id" pageMeta={null} />);
}

const galleryPageMeta: PageResponse = {
  id: "test-page-id",
  user_id: "user-1",
  url: "https://example.com/trip",
  title: "Trip — Image Gallery",
  // No trailing Z — the shell appends one (formatDistanceToNow input).
  archived_at: "2026-01-01T00:00:00",
  content_formats: ["html"],
};

function renderGalleryShell(pageMeta: PageResponse = galleryPageMeta) {
  return render(<PageViewerShell pageId="test-page-id" pageMeta={pageMeta} />);
}

function galleryListing(
  partial: Partial<PageImagesResponse> = {},
): PageImagesResponse {
  return {
    images: [
      { path: "assets/alpha.jpg", content_type: "image/jpeg", size_bytes: 11 },
      { path: "assets/beta.png", content_type: "image/png", size_bytes: 22 },
    ],
    is_image_gallery: true,
    total: 2,
    ...partial,
  };
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
  vi.mocked(clientApi.listPageImages).mockResolvedValue(galleryListing());
  vi.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(window, "location", locationDescriptor);
});

// Mount the shell, click back, and return the router mock's push for
// destination assertions.
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

  // Back is intentionally unconditional (pagepocket-frontend-viewer-back-trail
  // was reverted): the button is labeled "Back to library", so it always
  // navigates to /app — no navigation-trail machinery.
  describe("back navigation", () => {
    it("navigates to /app when the back button is clicked", async () => {
      const push = await renderAndClickBack();
      expect(push).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/app");
    });

    it("navigates to /app on Escape (same back handler)", () => {
      renderShell();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(nav.push).toHaveBeenCalledTimes(1);
      expect(nav.push).toHaveBeenCalledWith("/app");
    });
  });

  describe("image gallery (authed side)", () => {
    it("renders GalleryView instead of the iframe for a gallery-titled page with images", async () => {
      renderGalleryShell();

      const thumbs = await screen.findAllByRole("img");
      expect(thumbs).toHaveLength(2);
      expect(thumbs[0]).toHaveAttribute(
        "src",
        "/api/pp/archive/pages/test-page-id/f/assets/alpha.jpg",
      );
      expect(screen.getByText("2 images")).toBeInTheDocument();
      // The gallery branch takes precedence over the legacy iframe.
      expect(screen.queryByTitle("Saved page content")).not.toBeInTheDocument();
      expect(clientApi.listPageImages).toHaveBeenCalledTimes(1);
      expect(clientApi.listPageImages).toHaveBeenCalledWith("test-page-id");
    });

    it("falls back to the iframe when the images fetch fails", async () => {
      vi.mocked(clientApi.listPageImages).mockRejectedValue(new Error("boom"));

      renderGalleryShell();

      const iframe = await screen.findByTitle("Saved page content");
      expect(iframe).toHaveAttribute("sandbox", "allow-popups allow-forms");
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("falls back to the iframe when the response is not a gallery", async () => {
      vi.mocked(clientApi.listPageImages).mockResolvedValue(
        galleryListing({ is_image_gallery: false }),
      );

      renderGalleryShell();

      expect(
        await screen.findByTitle("Saved page content"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("falls back to the iframe when the gallery has no images", async () => {
      vi.mocked(clientApi.listPageImages).mockResolvedValue(
        galleryListing({ images: [], total: 0 }),
      );

      renderGalleryShell();

      expect(
        await screen.findByTitle("Saved page content"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("never fetches images for a non-gallery title (zero cost for normal pages)", async () => {
      renderShell();

      expect(screen.getByTitle("Saved page content")).toBeInTheDocument();
      expect(clientApi.listPageImages).not.toHaveBeenCalled();
    });

    it("suppressed shell hotkeys while the lightbox is open: Escape closes the modal instead of navigating back", async () => {
      renderGalleryShell();

      const thumbnail = await screen.findByRole("button", {
        name: "Open alpha.jpg (1 of 2)",
      });
      await userEvent.click(thumbnail);
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(nav.push).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // With the lightbox closed the shell's Escape = back is active again.
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(nav.push).toHaveBeenCalledTimes(1);
      expect(nav.push).toHaveBeenCalledWith("/app");
    });
  });
});
