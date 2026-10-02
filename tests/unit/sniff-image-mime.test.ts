import { sniffImageMimeType } from "../../src/background/sniffImageMime";

/** Helper: build a Blob from a hex string (space-separated byte values). */
function blobFromHex(hex: string): Blob {
  const bytes = hex
    .trim()
    .split(/\s+/)
    .map((b) => parseInt(b, 16));
  return new Blob([new Uint8Array(bytes)]);
}

/** Helper: build a Blob from a UTF-8 string. */
function blobFromText(text: string): Blob {
  return new Blob([new TextEncoder().encode(text)]);
}

describe("sniffImageMimeType", () => {
  it("detects PNG", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("89 50 4E 47 0D 0A 1A 0A 00 00 00 0D"),
    );
    expect(result).toBe("image/png");
  });

  it("detects JPEG", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("FF D8 FF E0 00 10 4A 46 49 46"),
    );
    expect(result).toBe("image/jpeg");
  });

  it("detects GIF87a", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("47 49 46 38 37 61 00 00"),
    );
    expect(result).toBe("image/gif");
  });

  it("detects GIF89a", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("47 49 46 38 39 61 00 00"),
    );
    expect(result).toBe("image/gif");
  });

  it("detects WebP", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("52 49 46 46 00 00 00 00 57 45 42 50 00 00"),
    );
    expect(result).toBe("image/webp");
  });

  it("detects BMP", async () => {
    const result = await sniffImageMimeType(blobFromHex("42 4D 00 00 00 00"));
    expect(result).toBe("image/bmp");
  });

  it("detects ICO", async () => {
    const result = await sniffImageMimeType(blobFromHex("00 00 01 00 01 00"));
    expect(result).toBe("image/x-icon");
  });

  it("detects AVIF (ftypavif)", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("00 00 00 18 66 74 79 70 61 76 69 66 00 00"),
    );
    expect(result).toBe("image/avif");
  });

  it("detects AVIF (ftypavis)", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("00 00 00 18 66 74 79 70 61 76 69 73 00 00"),
    );
    expect(result).toBe("image/avif");
  });

  it("detects HEIC (ftypheic)", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("00 00 00 18 66 74 79 70 68 65 69 63 00 00"),
    );
    expect(result).toBe("image/heic");
  });

  it("detects HEIC (ftypheix)", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("00 00 00 18 66 74 79 70 68 65 69 78 00 00"),
    );
    expect(result).toBe("image/heic");
  });

  it("detects HEIC (ftypmif1)", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("00 00 00 18 66 74 79 70 6D 69 66 31 00 00"),
    );
    expect(result).toBe("image/heic");
  });

  it("detects TIFF little-endian", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("49 49 2A 00 00 00 00 00"),
    );
    expect(result).toBe("image/tiff");
  });

  it("detects TIFF big-endian", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("4D 4D 00 2A 00 00 00 00"),
    );
    expect(result).toBe("image/tiff");
  });

  it("detects SVG via <svg tag", async () => {
    const result = await sniffImageMimeType(
      blobFromText('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    );
    expect(result).toBe("image/svg+xml");
  });

  it("detects SVG via <?xml declaration", async () => {
    const result = await sniffImageMimeType(
      blobFromText('<?xml version="1.0"?><svg></svg>'),
    );
    expect(result).toBe("image/svg+xml");
  });

  it("returns null for unknown content", async () => {
    const result = await sniffImageMimeType(
      blobFromHex("DE AD BE EF 00 11 22 33"),
    );
    expect(result).toBeNull();
  });

  it("returns null for empty blob without throwing", async () => {
    const result = await sniffImageMimeType(new Blob([]));
    expect(result).toBeNull();
  });

  it("returns null for random non-image bytes", async () => {
    const randomBytes = new Uint8Array(
      Array.from({ length: 64 }, () => Math.floor(Math.random() * 256)),
    );
    const result = await sniffImageMimeType(new Blob([randomBytes]));
    expect(result).toBeNull();
  });
});
