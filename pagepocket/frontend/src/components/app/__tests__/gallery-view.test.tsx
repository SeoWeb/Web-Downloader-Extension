import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GalleryView } from "../gallery-view";

const images = [
  { url: "/api/sc/tok/f/assets/alpha.jpg", alt: "alpha.jpg" },
  { url: "/api/sc/tok/f/assets/beta.png", alt: "beta.png" },
  { url: "/api/sc/tok/f/assets/gamma.webp", alt: "gamma.webp" },
];

function renderGallery() {
  const onLightboxOpenChange = vi.fn();
  render(
    <GalleryView images={images} onLightboxOpenChange={onLightboxOpenChange} />,
  );
  return onLightboxOpenChange;
}

describe("GalleryView", () => {
  it("renders one lazy thumbnail per image plus the count header", () => {
    renderGallery();

    const thumbs = screen.getAllByRole("img");
    expect(thumbs).toHaveLength(images.length);
    for (const [i, thumb] of thumbs.entries()) {
      expect(thumb).toHaveAttribute("src", images[i]!.url);
      expect(thumb).toHaveAttribute("loading", "lazy");
    }
    expect(screen.getByText("3 images")).toBeInTheDocument();
  });

  it("uses the singular count header for a single image", () => {
    render(<GalleryView images={[images[0]!]} />);
    expect(screen.getByText("1 image")).toBeInTheDocument();
  });

  it("opens the lightbox at the clicked thumbnail's index", async () => {
    const onLightboxOpenChange = renderGallery();

    await userEvent.click(
      screen.getByRole("button", { name: "Open beta.png (2 of 3)" }),
    );

    const lightbox = screen.getByRole("dialog");
    expect(lightbox).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "beta.png" })).toHaveAttribute(
      "src",
      images[1]!.url,
    );
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(onLightboxOpenChange).toHaveBeenCalledWith(true);
  });

  it("returns to the grid when the lightbox closes", async () => {
    const onLightboxOpenChange = renderGallery();

    await userEvent.click(
      screen.getByRole("button", { name: "Open alpha.jpg (1 of 3)" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(onLightboxOpenChange).toHaveBeenLastCalledWith(false);
    // All thumbnails remain interactive.
    expect(screen.getAllByRole("img")).toHaveLength(images.length);
  });

  it("degrades failed thumbnails to a placeholder tile", () => {
    renderGallery();

    fireEvent.error(screen.getByRole("img", { name: "beta.png" }));

    // The failed image is replaced by a placeholder (no <img>), the others
    // are untouched, and the grid still offers every tile as a button.
    expect(
      screen.queryByRole("img", { name: "beta.png" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("beta.png")).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(images.length - 1);
    expect(
      screen.getByRole("button", { name: "Open beta.png (2 of 3)" }),
    ).toBeInTheDocument();
  });
});
