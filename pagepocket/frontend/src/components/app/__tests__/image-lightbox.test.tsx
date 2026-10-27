import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ImageLightbox } from "../image-lightbox";

const images = [
  { url: "/api/pp/archive/pages/p1/f/assets/alpha.jpg", alt: "alpha.jpg" },
  { url: "/api/pp/archive/pages/p1/f/assets/beta.png", alt: "beta.png" },
  {
    url: "/api/pp/archive/pages/p1/f/assets/gamma.webp",
    alt: "gamma.webp",
  },
];

function renderLightbox(index: number | null = 0) {
  const onIndexChange = vi.fn();
  render(
    <ImageLightbox
      images={images}
      index={index}
      onIndexChange={onIndexChange}
    />,
  );
  return onIndexChange;
}

describe("ImageLightbox", () => {
  it("renders the image at the given index with basename alt and counter", () => {
    renderLightbox(1);

    const image = screen.getByRole("img", { name: "beta.png" });
    expect(image).toHaveAttribute(
      "src",
      "/api/pp/archive/pages/p1/f/assets/beta.png",
    );
    // Caption (basename) + counter "2 / 3".
    expect(screen.getByText("beta.png")).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("labels the close, next, and back controls for assistive tech", () => {
    renderLightbox(0);

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Next image" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Previous image" }),
    ).toBeInTheDocument();
  });

  it("navigates forward and backward via the buttons", async () => {
    const onIndexChange = renderLightbox(0);

    await userEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Previous image" }),
    );
    expect(onIndexChange).toHaveBeenLastCalledWith(-1 + images.length);
  });

  it("wraps around: next on the last image goes to the first", async () => {
    const onIndexChange = renderLightbox(images.length - 1);

    await userEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
  });

  it("wraps around: back on the first image goes to the last", async () => {
    const onIndexChange = renderLightbox(0);

    await userEvent.click(
      screen.getByRole("button", { name: "Previous image" }),
    );
    expect(onIndexChange).toHaveBeenLastCalledWith(images.length - 1);
  });

  it("navigates with the arrow keys (wrap-around)", () => {
    const onIndexChange = renderLightbox(0);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(onIndexChange).toHaveBeenLastCalledWith(images.length - 1);
  });

  it("closes via the close button", async () => {
    const onIndexChange = renderLightbox(0);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(null);
  });

  it("closes on Escape (Dialog behavior)", () => {
    const onIndexChange = renderLightbox(0);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onIndexChange).toHaveBeenCalledWith(null);
  });

  it("closes when the dark area around the image is clicked", () => {
    const onIndexChange = renderLightbox(0);

    // The full-viewport popup is the dark surface around the image — a
    // click that lands on it directly (not on the image/controls) closes.
    fireEvent.click(screen.getByRole("dialog"));
    expect(onIndexChange).toHaveBeenLastCalledWith(null);
  });

  it("shows a loading spinner until the image has loaded", () => {
    renderLightbox(0);
    expect(screen.getByRole("status", { name: "Loading image" })).toBeVisible();

    fireEvent.load(screen.getByRole("img", { name: "alpha.jpg" }));
    expect(
      screen.queryByRole("status", { name: "Loading image" }),
    ).not.toBeInTheDocument();
  });

  it("shows an alert when the image fails to load", () => {
    renderLightbox(0);

    fireEvent.error(screen.getByRole("img", { name: "alpha.jpg" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded/i);
  });

  it("renders nothing without images", () => {
    const onIndexChange = vi.fn();
    render(
      <ImageLightbox images={[]} index={0} onIndexChange={onIndexChange} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
