/**
 * Jest setup file — provides browser globals that the extension code
 * depends on at runtime (chrome.storage.local).
 *
 * import.meta.env is handled by the vite-env-transform.cjs at compile time.
 */

const mockStorage = {};

const chromeMock = {
  storage: {
    local: {
      _store: mockStorage, // Exposed for test cleanup
      get: async (keys) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const k of keyArr) {
          if (mockStorage[k] !== undefined) {
            result[k] = mockStorage[k];
          }
        }
        return result;
      },
      set: async (items) => {
        Object.assign(mockStorage, items);
      },
    },
  },
};

globalThis.chrome = chromeMock;

// Mock CompressionStream (browser API) for gzip compression tests
const { createGzip } = require("zlib");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

class MockCompressionStream {
  readable;
  writable;
  constructor(format) {
    if (format !== "gzip") throw new Error(`Unsupported format: ${format}`);

    const gzip = createGzip();
    const compressedChunks = [];
    let writeResolve;
    const writeReady = new Promise((r) => { writeResolve = r; });

    gzip.on("data", (chunk) => compressedChunks.push(new Uint8Array(chunk)));
    gzip.on("end", () => { writeResolve(); });

    this.writable = {
      getWriter: () => ({
        write: async (chunk) => {
          const buf = chunk instanceof ArrayBuffer ? Buffer.from(chunk) : Buffer.from(chunk);
          if (!gzip.write(buf)) {
            await new Promise((r) => gzip.once("drain", r));
          }
        },
        close: async () => {
          gzip.end();
          await writeReady;
        },
      }),
    };

    this.readable = {
      getReader: () => {
        let delivered = false;
        return {
          read: async () => {
            if (delivered) return { done: true, value: undefined };
            await writeReady;
            delivered = true;
            if (compressedChunks.length === 0) return { done: true, value: undefined };
            const total = compressedChunks.reduce((s, c) => s + c.length, 0);
            const result = new Uint8Array(total);
            let offset = 0;
            for (const c of compressedChunks) { result.set(c, offset); offset += c.length; }
            return { done: false, value: result };
          },
        };
      },
    };
  }
}

globalThis.CompressionStream = MockCompressionStream;
