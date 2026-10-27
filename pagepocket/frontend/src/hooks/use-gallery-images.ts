"use client";

import { useEffect, useRef, useState } from "react";
import type { GalleryImage } from "@/lib/gallery";

/**
 * Lifecycle of the gallery probe in a viewer shell:
 * - idle: not a gallery candidate — never fetch (zero cost for normal pages)
 * - loading: candidate confirmed, listing in flight (brief neutral state)
 * - gallery: usable listing → the shell renders GalleryView
 * - fallback: fetch failed / not a gallery / empty → today's rendering
 */
export type GalleryContentState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "gallery"; images: GalleryImage[] }
  | { status: "fallback" };

/**
 * Probe the page-images listing at most once per `enabled` transition.
 * The fetcher returns the renderable images, or null for "no gallery here"
 * (it owns the is_image_gallery/empty gate and swallows its own errors).
 * The fetcher identity is read through a ref (same pattern as use-hotkeys),
 * so callers may pass an inline closure without refetch loops.
 */
export function useGalleryContent(
  enabled: boolean,
  fetchImages: () => Promise<GalleryImage[] | null>,
): GalleryContentState {
  const [state, setState] = useState<GalleryContentState>({ status: "idle" });
  const fetchRef = useRef(fetchImages);
  fetchRef.current = fetchImages;

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    fetchRef.current().then(
      (images) => {
        if (cancelled) return;
        setState(
          images && images.length > 0
            ? { status: "gallery", images }
            : { status: "fallback" },
        );
      },
      () => {
        // The fetchers resolve to null on failure; an unexpected rejection
        // must equally degrade to today's rendering, never break the viewer.
        if (!cancelled) setState({ status: "fallback" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
