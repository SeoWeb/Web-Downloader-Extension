"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";

import {
  ImageLightbox,
  type LightboxImage,
} from "@/components/app/image-lightbox";

type GalleryViewProps = {
  /** The page's images, in API (path-sorted) order. */
  images: LightboxImage[];
  /**
   * Notifies the host shell when the lightbox opens/closes, so page-level
   * hotkeys (Escape = back, d/s/Delete) are suppressed while the modal is
   * up and the Dialog's own Esc handling wins.
   */
  onLightboxOpenChange?: (open: boolean) => void;
};

/**
 * Native gallery for images-only archived pages (image gallery feature):
 * responsive thumbnail grid over the same-origin BFF file URLs (plain <img>,
 * no next/image remote config), opening the fullscreen lightbox on click
 * (or focus + Enter — the tiles are real buttons). Thumbnails lazy-load and
 * degrade to a placeholder tile when their bytes fail.
 */
export function GalleryView({
  images,
  onLightboxOpenChange,
}: GalleryViewProps) {
  const [index, setIndex] = useState<number | null>(null);
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  function openLightbox(i: number) {
    setIndex(i);
    onLightboxOpenChange?.(true);
  }

  function handleIndexChange(next: number | null) {
    setIndex(next);
    onLightboxOpenChange?.(next !== null);
  }

  function handleThumbnailError(url: string) {
    setFailedUrls((current) => {
      if (current.has(url)) return current;
      const next = new Set(current);
      next.add(url);
      return next;
    });
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
        <p className="text-muted-foreground mb-3 text-sm">
          {images.length} {images.length === 1 ? "image" : "images"}
        </p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {images.map((image, i) => (
            <button
              key={image.url}
              type="button"
              onClick={() => openLightbox(i)}
              aria-label={`Open ${image.alt} (${i + 1} of ${images.length})`}
              className="group bg-muted focus-visible:ring-ring/50 relative block h-[200px] w-full overflow-hidden rounded-lg outline-none focus-visible:ring-3"
            >
              {failedUrls.has(image.url) ? (
                <span className="text-muted-foreground flex size-full flex-col items-center justify-center gap-2 px-3 text-center text-xs break-all">
                  <ImageOff className="size-5 shrink-0" aria-hidden="true" />
                  {image.alt}
                </span>
              ) : (
                <img
                  src={image.url}
                  alt={image.alt}
                  loading="lazy"
                  onError={() => handleThumbnailError(image.url)}
                  className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
                />
              )}
            </button>
          ))}
        </div>
      </div>

      <ImageLightbox
        images={images}
        index={index}
        onIndexChange={handleIndexChange}
      />
    </div>
  );
}
