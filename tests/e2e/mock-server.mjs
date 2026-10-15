/**
 * Recording mock server for the download-pipeline E2E test.
 *
 * Two plain-node http servers (no dependencies):
 *  - API server  : implements the minimal PagePocket server API surface read
 *                  from src/background/server-client.ts / server-download.ts.
 *                  ACCEPTS EVERYTHING and RECORDS every request
 *                  (method, path, X-API-Key presence, parsed payloads).
 *  - Fixture server : serves tests/e2e/fixtures/site/ plus special routes
 *                  (Shift_JIS stylesheet, slow route, deliberate 404) and
 *                  RECORDS every request (path, cookie header, ...).
 *
 * The point is observability, not fidelity: unknown API endpoints are logged
 * and answered with a 200 + plausible JSON mirroring the keys the client
 * reads.
 */

import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Recording store
// ---------------------------------------------------------------------------

export function createRecording() {
  return {
    /** Every request that hit the API server. */
    api: [],
    /** Every request that hit the fixture server. */
    fixture: [],
    /** Parsed resource uploads (POST .../resources). */
    uploads: [],
    /** Parsed HTML chunk uploads (POST .../html). */
    htmlChunks: [],
    /** Session ids that received POST .../scrape-complete. */
    scrapeCompleted: [],
    /** Session ids that received POST .../finalize. */
    finalized: [],
    /** Session id -> number of GET .../status polls. */
    statusPolls: {},
    /** Session id -> filename map payload. */
    filenameMaps: {},
    registrations: 0,
    /** Created sessions: {id, url}. */
    sessions: [],
    /** Number of times /fake.zip was served. */
    downloadServed: 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(rec, res, req, status, payload) {
  cors(rec, res, req);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** Echo the request origin so credentialed service-worker fetches succeed. */
export function cors(rec, res, req) {
  const origin = req?.headers?.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Type, Content-Length, X-Content-Gzipped",
    );
  }
  res.setHeader("Cache-Control", "no-store");
}

/**
 * Minimal multipart/form-data parser. Returns { fields, files } where files
 * carry raw Buffers.
 */
export function parseMultipart(buffer, contentTypeHeader) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader || "");
  if (!m) return null;
  const boundary = Buffer.from("--" + (m[1] || m[2]).trim());
  const parts = [];
  let idx = buffer.indexOf(boundary);
  while (idx !== -1) {
    const next = buffer.indexOf(boundary, idx + boundary.length);
    if (next === -1) break;
    let start = idx + boundary.length;
    // skip CRLF after boundary
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    let end = next;
    // strip the CRLF that precedes the next boundary
    if (buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;
    if (end > start) parts.push(buffer.subarray(start, end));
    idx = next;
  }

  const fields = {};
  const files = [];
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    if (fileMatch && fileMatch[1]) {
      files.push({ filename: fileMatch[1], data: body });
    } else if (nameMatch) {
      fields[nameMatch[1]] = body.toString("utf8");
    }
  }
  return { fields, files };
}

/** The Shift_JIS stylesheet the fixture references, pre-encoded to real
 *  Shift_JIS bytes (Node has no shift_jis TextEncoder; these bytes were
 *  generated with python's shift_jis codec). Decoding them as UTF-8 yields
 *  mojibake, decoding as Shift_JIS yields the Japanese text. */
export const SJIS_CSS_TEXT =
  '@charset "Shift_JIS";\n' +
  "/* 日本語のコメント - Shift_JIS charset test (3.3) */\n" +
  '.sjis-rule::before { content: "日本語テキスト"; }\n';

const SJIS_CSS_BYTES = Buffer.from(
  "QGNoYXJzZXQgIlNoaWZ0X0pJUyI7Ci8qIJP6lnuM6oLMg1KDgYOTg2cgLSBTaGlmdF9KSVMgY2hhcnNldCB0ZXN0ICgzLjMpICovCi5zamlzLXJ1bGU6OmJlZm9yZSB7IGNvbnRlbnQ6ICKT+pZ7jOqDZYNMg1iDZyI7IH0K",
  "base64",
);

// ---------------------------------------------------------------------------
// API server
// ---------------------------------------------------------------------------

function startApiServer(rec, port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname;

    if (req.method === "OPTIONS") {
      cors(rec, res, req);
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
      });
      res.end();
      return;
    }

    let body = Buffer.alloc(0);
    try {
      body = await readBody(req);
    } catch {
      sendJson(rec, res, req, 413, { message: "body too large" });
      return;
    }

    rec.api.push({
      ts: Date.now(),
      method: req.method,
      path: p,
      apiKey: !!req.headers["x-api-key"],
      gzipped: req.headers["x-content-gzipped"] === "true",
      bytes: body.length,
    });

    // ---- health (unauthenticated) ----
    if (p === "/api/v1/health" && req.method === "GET") {
      sendJson(rec, res, req, 200, {
        status: "ok",
        version: "e2e-mock",
        mysql: "ok",
        storage_available_mb: 1024,
        storage_total_mb: 2048,
        description: null,
        api_version: "v1",
      });
      return;
    }

    // ---- /fake.zip (download_url target) ----
    if (p === "/fake.zip" && req.method === "GET") {
      rec.downloadServed++;
      cors(rec, res, req);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="e2e-fake.zip"',
        "Content-Length": FAKE_ZIP.length,
      });
      res.end(FAKE_ZIP);
      return;
    }

    // ---- registration (auto-register on first call) ----
    if (p === "/api/v1/auth/register" && req.method === "POST") {
      rec.registrations++;
      let clientId = "unknown";
      try {
        clientId = JSON.parse(body.toString("utf8")).client_id ?? "unknown";
      } catch {}
      sendJson(rec, res, req, 200, {
        api_key: "e2e-test-api-key",
        client_id: clientId,
      });
      return;
    }

    // ---- session create ----
    let m = /^\/api\/v1\/sessions$/.exec(p);
    if (m && req.method === "POST") {
      const sid = `sess-${rec.finalized.length + rec.scrapeCompleted.length + 1}-${Date.now()}`;
      let reqUrl = "";
      try {
        reqUrl = JSON.parse(body.toString("utf8")).url ?? "";
      } catch {}
      rec.api[rec.api.length - 1].sessionUrl = reqUrl;
      rec.sessions.push({ id: sid, url: reqUrl });
      sendJson(rec, res, req, 200, {
        id: sid,
        url: reqUrl,
        status: "scraping",
        options: {},
        html_chunks: 0,
        resources_discovered: null,
        resources_received: 0,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600e3).toISOString(),
        api_version: "v1",
      });
      return;
    }

    m = /^\/api\/v1\/sessions\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) {
      // Unknown endpoint — log raw and answer generically.
      console.log(
        `[mock-api] UNEXPECTED ${req.method} ${p} (${body.length} bytes)`,
      );
      sendJson(rec, res, req, 200, { message: "accepted (mock)" });
      return;
    }

    const [, sessionId, action = ""] = m;

    // ---- HTML chunk upload ----
    if (action === "html" && req.method === "POST") {
      let parsed = {};
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {}
      rec.htmlChunks.push({
        sessionId,
        pageType: parsed.pageType ?? null,
        pageUrl: parsed.pageUrl ?? null,
        scrollIndex: parsed.scrollIndex ?? null,
        html: typeof parsed.html === "string" ? parsed.html.slice(0, 400e3) : "",
        htmlLength: typeof parsed.html === "string" ? parsed.html.length : 0,
      });
      sendJson(rec, res, req, 200, {
        chunk_id: `chunk-${rec.htmlChunks.length}`,
        chunk_count: 1,
        total_size: body.length,
        deduplicated: false,
        api_version: "v1",
      });
      return;
    }

    // ---- resource upload (multipart) ----
    if (action === "resources" && req.method === "POST") {
      const parsed = parseMultipart(body, req.headers["content-type"]);
      const gzipped = req.headers["x-content-gzipped"] === "true";
      const file = parsed?.files?.[0];
      let bytes = file?.data ?? Buffer.alloc(0);
      if (gzipped) {
        try {
          bytes = zlib.gunzipSync(bytes);
        } catch (err) {
          console.log(`[mock-api] gunzip failed for ${parsed?.fields?.path}: ${err.message}`);
        }
      }
      rec.uploads.push({
        sessionId,
        path: parsed?.fields?.path ?? null,
        originalUrl: parsed?.fields?.originalUrl ?? null,
        contentType: parsed?.fields?.contentType ?? null,
        uploadedFilename: file?.filename ?? null,
        gzipped,
        bytes,
      });
      sendJson(rec, res, req, 200, {
        resource_id: `res-${rec.uploads.length}`,
        local_path: parsed?.fields?.path ?? null,
        size: bytes.length,
        deduplicated: false,
        api_version: "v1",
      });
      return;
    }

    // ---- filename map ----
    if (action === "filename-map" && req.method === "POST") {
      let map = {};
      try {
        map = JSON.parse(body.toString("utf8")).map ?? {};
      } catch {}
      rec.filenameMaps[sessionId] = map;
      sendJson(rec, res, req, 200, {
        mappings_count: Object.keys(map).length,
        api_version: "v1",
      });
      return;
    }

    // ---- text content ----
    if (action === "content" && req.method === "POST") {
      let text = "";
      try {
        text = JSON.parse(body.toString("utf8")).text ?? "";
      } catch {}
      rec.api[rec.api.length - 1].textLength = text.length;
      sendJson(rec, res, req, 200, {
        message: "content uploaded",
        size: text.length,
        api_version: "v1",
      });
      return;
    }

    // ---- scrape complete ----
    if (action === "scrape-complete" && req.method === "POST") {
      if (!rec.scrapeCompleted.includes(sessionId)) rec.scrapeCompleted.push(sessionId);
      sendJson(rec, res, req, 200, {
        id: sessionId,
        status: "uploading",
        message: "scrape marked complete (mock)",
        api_version: "v1",
      });
      return;
    }

    // ---- finalize ----
    if (action === "finalize" && req.method === "POST") {
      if (!rec.finalized.includes(sessionId)) rec.finalized.push(sessionId);
      rec.statusPolls[sessionId] = 0;
      sendJson(rec, res, req, 200, {
        id: sessionId,
        status: "assembling",
        message: "assembly started (mock)",
        api_version: "v1",
      });
      return;
    }

    // ---- status polling ----
    if (action === "status" && req.method === "GET") {
      const count = (rec.statusPolls[sessionId] ?? 0) + 1;
      rec.statusPolls[sessionId] = count;
      const ready = count >= 2;
      sendJson(rec, res, req, 200, {
        id: sessionId,
        status: ready ? "ready" : "assembling",
        url: "https://fixture.example/dir/page.html",
        html_chunks: rec.htmlChunks.filter((c) => c.sessionId === sessionId).length,
        resources_discovered: rec.uploads.filter((u) => u.sessionId === sessionId).length,
        resources_received: rec.uploads.filter((u) => u.sessionId === sessionId).length,
        total_size: rec.uploads
          .filter((u) => u.sessionId === sessionId)
          .reduce((acc, u) => acc + u.bytes.length, 0),
        assembly_phase: ready ? "done" : "packaging",
        assembly_progress_pct: ready ? 100 : 50,
        download_url: ready ? `http://127.0.0.1:${port}/fake.zip` : null,
        output_type: ready ? "zip" : null,
        output_size: ready ? FAKE_ZIP.length : null,
        error_message: null,
        api_version: "v1",
      });
      return;
    }

    // ---- delete session ----
    if (action === "" && req.method === "DELETE") {
      sendJson(rec, res, req, 200, { id: sessionId, status: "deleted" });
      return;
    }

    console.log(`[mock-api] UNHANDLED ${req.method} ${p}`);
    sendJson(rec, res, req, 200, { message: "accepted (mock)" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Fixture server
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".js": "text/javascript; charset=utf-8",
};

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Slow route: responds 200 after this delay (> the 30s requestTimeout so the
 *  first queue attempt aborts with a timeout and the retry succeeds). */
const SLOW_ROUTE_DELAY_MS = 40_000;

function startFixtureServer(rec, port, fixturesDir) {
  const pendingTimers = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = decodeURIComponent(url.pathname);

    if (req.method === "OPTIONS") {
      cors(rec, res, req);
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
      });
      res.end();
      return;
    }

    rec.fixture.push({
      ts: Date.now(),
      method: req.method,
      path: p,
      cookie: req.headers.cookie ?? null,
      hasCookie: !!req.headers.cookie,
      ua: req.headers["user-agent"] ?? null,
    });

    // Shift_JIS stylesheet — actual Shift_JIS-encoded bytes.
    if (p === "/css/sjis.css") {
      const bytes = SJIS_CSS_BYTES;
      cors(rec, res, req);
      res.writeHead(200, {
        "Content-Type": "text/css; charset=Shift_JIS",
        "Content-Length": bytes.length,
      });
      res.end(bytes);
      return;
    }

    // Deliberate 404 (failure report + credentials-omit retry path).
    if (p === "/img404.png") {
      cors(rec, res, req);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found (deliberate fixture)");
      return;
    }

    // Slow route — accepted, then stalls 40s, then answers 200.
    if (p === "/slow.png") {
      const t = setTimeout(() => {
        pendingTimers.delete(t);
        try {
          cors(rec, res, req);
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": PNG_1PX.length,
          });
          res.end(PNG_1PX);
        } catch {
          /* response already torn down */
        }
      }, SLOW_ROUTE_DELAY_MS);
      pendingTimers.add(t);
      return;
    }

    // The test entry pages get a session cookie plus a per-tab marker
    // (e2e_tab=A|B). Tab A's entry page is served on 127.0.0.1, tab B's on
    // localhost — distinct cookie jars, so each pipeline's asset fetches
    // carry exactly their own tab's marker and the recorded requests can be
    // attributed per tab (see download-pipeline.test.cjs R1).
    if (p === "/dir/page.html" || p === "/page2.html") {
      const file = path.join(fixturesDir, p.slice(1));
      if (fs.existsSync(file)) {
        const bytes = fs.readFileSync(file);
        const tabMarker = p === "/dir/page.html" ? "A" : "B";
        cors(rec, res, req);
        res.writeHead(200, {
          "Content-Type": MIME[".html"],
          "Content-Length": bytes.length,
          "Set-Cookie": [
            "e2e_session=fixturecookie123; Path=/",
            `e2e_tab=${tabMarker}; Path=/`,
          ],
        });
        res.end(bytes);
        return;
      }
    }

    // Static files.
    const file = path.join(fixturesDir, p.replace(/^\/+/, ""));
    if (
      file.startsWith(fixturesDir) &&
      fs.existsSync(file) &&
      fs.statSync(file).isFile()
    ) {
      const bytes = fs.readFileSync(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      cors(rec, res, req);
      res.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length });
      res.end(bytes);
      return;
    }

    cors(rec, res, req);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("fixture not found");
  });

  const stop = () => {
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => resolve()));
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, stop }));
  });
}

// ---------------------------------------------------------------------------
// Minimal valid ZIP (one stored entry) for /fake.zip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const FAKE_ZIP = (() => {
  const content = Buffer.from("e2e mock archive — pipeline completed\r\n", "utf8");
  const name = Buffer.from("e2e.txt", "utf8");
  const crc = crc32(content);
  const dosTime = 0, dosDate = 0x5821; // arbitrary valid date

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(30 + name.length + content.length, 16);

  return Buffer.concat([local, name, content, central, name, eocd]);
})();

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Start both servers.
 * @returns {Promise<{recording, apiPort, fixturePort, stop(): Promise<void>}>}
 */
export async function startMockServers({ apiPort, fixturePort, fixturesDir }) {
  const rec = createRecording();
  const apiServer = await startApiServer(rec, apiPort);
  const fixture = await startFixtureServer(rec, fixturePort, fixturesDir);
  return {
    recording: rec,
    apiPort,
    fixturePort,
    stop: async () => {
      await fixture.stop();
      apiServer.closeAllConnections?.();
      await new Promise((resolve) => apiServer.close(() => resolve()));
    },
  };
}
