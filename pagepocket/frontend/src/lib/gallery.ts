/**
 * Image-gallery support shared by the authed viewer (PageViewerShell) and the
 * public share viewer (PublicViewerShell).
 *
 * An "images-only" archived page is detected on the authed side by its page
 * title (the downloader titles these pages "… — Image Gallery"); the share
 * side has no title in its validation payload, so it probes the images route
 * once for html-only share pages instead (see PublicViewerShell). A page is
 * only ever rendered as a gallery when the listing answers
 * `is_image_gallery: true` with at least one image — anything else (fetch
 * failure, older backend, plain page) falls back to today's rendering.
 */

import {
  PageImagesResponseSchema,
  type PageImagesResponse,
} from "./api/schemas";

/** Title suffix the downloader gives images-only archives (U+2014 em dash). */
export const IMAGE_GALLERY_TITLE_SUFFIX = " — Image Gallery";

/** Bare title of an images-only archive, without a subject prefix. */
export const IMAGE_GALLERY_TITLE = "Image Gallery";

/**
 * True when the page title marks an images-only archive: either the exact
 * bare title or a suffixed one ("Trip — Image Gallery").
 */
export function isImageGalleryTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  return (
    trimmed === IMAGE_GALLERY_TITLE ||
    trimmed.endsWith(IMAGE_GALLERY_TITLE_SUFFIX)
  );
}

/** One renderable gallery image: the fetchable URL plus its alt text. */
export type GalleryImage = {
  url: string;
  alt: string;
};

/** Alt text of a stored image path — its basename. */
export function imageBasename(path: string): string {
  const base = path.split("/").pop();
  return base && base.length > 0 ? base : path;
}

/** Full-size URL of a stored image path, authed BFF archive route. */
export function archiveImageUrl(pageId: string, path: string): string {
  return `/api/pp/archive/pages/${pageId}/f/${path}`;
}

/** Full-size URL of a stored image path, public share route. */
export function shareImageUrl(token: string, path: string): string {
  return `/api/sc/${token}/f/${path}`;
}

/**
 * Map an images listing to renderable gallery images, or null when the
 * response does not describe a usable gallery (flag off, or no images —
 * e.g. a plain page probed by mistake). The array order is the API's
 * (sorted by path per contract) and is preserved.
 */
export function galleryImagesFromResponse(
  response: PageImagesResponse,
  urlFor: (path: string) => string,
): GalleryImage[] | null {
  if (!response.is_image_gallery || response.images.length === 0) {
    return null;
  }
  return response.images.map((image) => ({
    url: urlFor(image.path),
    alt: imageBasename(image.path),
  }));
}

/**
 * Fetch the share-side images listing through the public proxy
 * (`/api/sc/{token}/images`). Never throws — any failure (404 for
 * non-gallery shares, older backend without the route, network error,
 * contract violation) resolves to null so the viewer falls back to the
 * plain HTML iframe. Same plain-fetch + parse pattern as the file loads in
 * page-format-viewer (works without providers in the public share viewer).
 */
export async function fetchSharePageImages(
  token: string,
): Promise<PageImagesResponse | null> {
  try {
    const response = await fetch(`/api/sc/${token}/images`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    return PageImagesResponseSchema.parse(await response.json());
  } catch {
    return null;
  }
}
