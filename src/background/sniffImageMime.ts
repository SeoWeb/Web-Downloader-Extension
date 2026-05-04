/**
 * Client-side MIME sniffer for image blobs.
 *
 * Reads the first 512 bytes of a Blob and matches against known binary
 * magic-number signatures. Falls back to a bounded UTF-8 text sniff
 * for SVG detection. Returns null when no signature is recognised.
 */

/** Magic-byte signatures mapped to canonical MIME types. */
const SIGNATURES: {
  mime: string;
  match: (buf: Uint8Array) => boolean;
}[] = [
  {
    mime: "image/png",
    match: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a,
  },
  {
    mime: "image/jpeg",
    match: (buf) =>
      buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    mime: "image/gif",
    match: (buf) =>
      (buf.length >= 6 &&
        buf[0] === 0x47 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x38 &&
        buf[4] === 0x37 &&
        buf[5] === 0x61) ||
      (buf.length >= 6 &&
        buf[0] === 0x47 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x38 &&
        buf[4] === 0x39 &&
        buf[5] === 0x61),
  },
  {
    mime: "image/webp",
    match: (buf) =>
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50,
  },
  {
    mime: "image/bmp",
    match: (buf) => buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d,
  },
  {
    mime: "image/x-icon",
    match: (buf) =>
      buf.length >= 4 &&
      buf[0] === 0x00 &&
      buf[1] === 0x00 &&
      buf[2] === 0x01 &&
      buf[3] === 0x00,
  },
  {
    mime: "image/avif",
    match: (buf) =>
      buf.length >= 12 &&
      buf[4] === 0x66 &&
      buf[5] === 0x74 &&
      buf[6] === 0x79 &&
      buf[7] === 0x70 &&
      buf[8] === 0x61 &&
      buf[9] === 0x76 &&
      buf[10] === 0x69 &&
      (buf[11] === 0x66 || buf[11] === 0x73),
  },
  {
    mime: "image/heic",
    match: (buf) => {
      if (buf.length < 12) return false;
      if (
        buf[4] !== 0x66 ||
        buf[5] !== 0x74 ||
        buf[6] !== 0x79 ||
        buf[7] !== 0x70
      )
        return false;
      const brands = [
        0x68656963, 0x68656978, 0x68657663, 0x68657678, 0x6865696d, 0x68656973,
        0x6865766d, 0x68657673, 0x6d696631, 0x6d736631,
      ];
      const brand = (buf[8] << 24) | (buf[9] << 16) | (buf[10] << 8) | buf[11];
      return brands.includes(brand);
    },
  },
  {
    mime: "image/tiff",
    match: (buf) =>
      buf.length >= 4 &&
      ((buf[0] === 0x49 &&
        buf[1] === 0x49 &&
        buf[2] === 0x2a &&
        buf[3] === 0x00) ||
        (buf[0] === 0x4d &&
          buf[1] === 0x4d &&
          buf[2] === 0x00 &&
          buf[3] === 0x2a)),
  },
];

const SVG_REGEX = /<\?xml\b|<svg\b/i;

/**
 * Detect the MIME type of an image blob by inspecting its leading bytes.
 *
 * @param blob - The image blob to inspect
 * @returns A canonical MIME string, or null if no signature matched
 */
export async function sniffImageMimeType(blob: Blob): Promise<string | null> {
  try {
    const raw = await blob.slice(0, 512).arrayBuffer();
    const buf = new Uint8Array(raw);

    if (buf.length === 0) return null;

    for (const sig of SIGNATURES) {
      if (sig.match(buf)) return sig.mime;
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    if (SVG_REGEX.test(text)) return "image/svg+xml";

    return null;
  } catch {
    return null;
  }
}
