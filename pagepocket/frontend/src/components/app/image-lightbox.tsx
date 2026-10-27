"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** One renderable lightbox image (same shape as lib/gallery GalleryImage). */
export type LightboxImage = {
  url: string;
  alt: string;
};

type ImageLightboxProps = {
  images: LightboxImage[];
  /**
   * Controlled open state: the index of the shown image, or null when
   * closed. Navigating calls onIndexChange with the next index (wrap-around);
   * Esc, backdrop/empty-area clicks, and the Close button call it with null.
   */
  index: number | null;
  onIndexChange: (index: number | null) => void;
};

/**
 * One slide with its own load state, keyed by URL at the call site so it
 * remounts (spinner resets) when the index changes.
 */
function LightboxSlide({ image }: { image: LightboxImage }) {
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  return (
    <div className="relative flex items-center justify-center">
      {!loaded && !failed && (
        <div className="absolute" role="status" aria-label="Loading image">
          <Loader2
            className="size-8 animate-spin text-white/60"
            aria-hidden="true"
          />
        </div>
      )}
      {failed ? (
        <p role="alert" className="text-sm text-white/70">
          This image could not be loaded.
        </p>
      ) : (
        <img
          src={image.url}
          alt={image.alt}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            "max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl transition-opacity duration-200",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </div>
  );
}

/**
 * Fullscreen image viewer (image gallery feature). Built on the same Base UI
 * dialog primitives as components/ui/dialog.tsx, but full-viewport over a
 * dark backdrop. Esc closes (Dialog), ←/→ navigate (wrap-around, own
 * document listener while open), and clicking the dark area around the image
 * closes. Focus trapping/restore is the Dialog's.
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
}: ImageLightboxProps) {
  const open = index !== null;
  const count = images.length;

  const step = React.useCallback(
    (delta: number) => {
      if (index === null || count === 0) return;
      // Wrap around: next on the last image → first, back on the first → last.
      onIndexChange((index + delta + count) % count);
    },
    [index, count, onIndexChange],
  );

  // Arrow-key navigation while open (ref pattern of use-hotkeys keeps the
  // listener stable across index changes).
  const stepRef = React.useRef(step);
  stepRef.current = step;

  React.useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        stepRef.current(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepRef.current(-1);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (count === 0) return null;

  const image = index !== null ? images[index] : undefined;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onIndexChange(null);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-black/90 duration-200" />
        <DialogPrimitive.Popup
          className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 flex items-center justify-center duration-200 outline-none"
          onClick={(event) => {
            // The popup covers the viewport, so "backdrop click" lands here:
            // clicks on the dark area around the image close, clicks on the
            // image or the controls do not.
            if (event.target === event.currentTarget) onIndexChange(null);
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Image viewer
          </DialogPrimitive.Title>

          {image && <LightboxSlide key={image.url} image={image} />}

          {/* Top bar: caption + counter (left), close (right). */}
          <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3 sm:p-4">
            <p className="min-w-0 text-sm text-white/90">
              <span className="font-medium break-all">{image?.alt}</span>
              {index !== null && (
                <span className="ml-2 text-white/60 tabular-nums">
                  {index + 1} / {count}
                </span>
              )}
            </p>
            <DialogPrimitive.Close
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  aria-label="Close"
                  className="rounded-full bg-white/10 text-white/90 hover:bg-white/20 hover:text-white"
                />
              }
            >
              <X className="size-5" />
            </DialogPrimitive.Close>
          </div>

          {/* Mid-left / mid-right navigation, large touch targets. */}
          {count > 1 && (
            <>
              <Button
                variant="ghost"
                size="icon-lg"
                onClick={() => step(-1)}
                aria-label="Previous image"
                className="absolute top-1/2 left-2 size-11 -translate-y-1/2 rounded-full bg-white/10 text-white/90 hover:bg-white/20 hover:text-white sm:left-4 sm:size-12"
              >
                <ChevronLeft className="size-6 sm:size-7" />
              </Button>
              <Button
                variant="ghost"
                size="icon-lg"
                onClick={() => step(1)}
                aria-label="Next image"
                className="absolute top-1/2 right-2 size-11 -translate-y-1/2 rounded-full bg-white/10 text-white/90 hover:bg-white/20 hover:text-white sm:right-4 sm:size-12"
              >
                <ChevronRight className="size-6 sm:size-7" />
              </Button>
            </>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
