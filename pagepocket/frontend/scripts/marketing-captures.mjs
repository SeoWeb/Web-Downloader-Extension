#!/usr/bin/env node
/**
 * Marketing screenshot pipeline (openspec: professional-marketing-site, task 1.9 — design D3/D4).
 *
 * Seeds a dedicated, clearly-named demo account on the production app with 2
 * clean, permissively-licensed archived pages (Wikipedia "Web archiving", MDN
 * "Fetch API") via the monolith ingest API, then captures the core marketing
 * set — library, page viewer, full-text search, collections, public share page
 * and the extension side panel — in light AND dark themes at 1440x900 @2x into
 * `public/screenshots/`.
 *
 * Usage:
 *   node scripts/marketing-captures.mjs [seed|capture|all]     # default: all
 *
 * Required environment (never hardcode credentials):
 *   PP_DEMO_EMAIL       email of the dedicated demo account
 *   PP_DEMO_PASSWORD    password of the dedicated demo account
 * Optional:
 *   PP_APP_URL          default https://app.pagepocket.app
 *   PP_SERVER_URL       default https://server.pagepocket.app
 *   PP_OUT_DIR          default <frontend>/public/screenshots
 *
 * Safety: every authenticated call in this script uses ONLY the demo account
 * credentials provided via env. Seeding is idempotent — pages already present
 * in the demo library (matched by URL) are skipped, collections/shares are
 * reused. The script never touches any other account or data.
 */

import { chromium } from "playwright";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(SCRIPT_DIR, "..");

const APP_URL = (
  process.env.PP_APP_URL ?? "https://app.pagepocket.app"
).replace(/\/+$/, "");
const SERVER_URL = (
  process.env.PP_SERVER_URL ?? "https://server.pagepocket.app"
).replace(/\/+$/, "");
const OUT_DIR = resolve(
  FRONTEND_ROOT,
  process.env.PP_OUT_DIR ?? "public/screenshots",
);
// Seed state lives next to the script (NOT in public/ — it is an internal
// re-run artifact and would otherwise be web-served).
const STATE_FILE = resolve(SCRIPT_DIR, ".marketing-demo-state.json");
const VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE_FACTOR = 2;
const SIDE_PANEL_VIEWPORT = { width: 420, height: 780 };
const EXTENSION_DIST = resolve(FRONTEND_ROOT, "../../dist");

/** Demo library content. Visually clean + permissively licensed pages only. */
const SEED_PAGES = [
  {
    key: "wikipedia-web-archiving",
    url: "https://en.wikipedia.org/wiki/Web_archiving",
    searchWord: "archiving",
  },
  {
    key: "wikipedia-digital-preservation",
    url: "https://en.wikipedia.org/wiki/Digital_preservation",
    searchWord: "preservation",
  },
  {
    key: "mdn-fetch-api",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
    searchWord: "fetch",
  },
];

const COLLECTION_NAME = "Research sources";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function requireDemoCredentials() {
  const email = process.env.PP_DEMO_EMAIL;
  const password = process.env.PP_DEMO_PASSWORD;
  if (!email || !password) {
    console.error(
      "Missing PP_DEMO_EMAIL / PP_DEMO_PASSWORD. Provide the dedicated demo account credentials (never commit them).",
    );
    process.exit(1);
  }
  return { email, password };
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const detail =
      data && typeof data === "object"
        ? JSON.stringify(data.detail ?? data).slice(0, 300)
        : text.slice(0, 300);
    throw new Error(
      `${options.method ?? "GET"} ${url} → ${res.status}: ${detail}`,
    );
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

/** Login via the frontend's extension auth proxy → raw tokens. */
async function login(email, password) {
  const data = await apiJson(`${APP_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = JSON.parse(
    Buffer.from(data.access_token.split(".")[1], "base64url").toString(),
  );
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    userId: payload.sub,
  };
}

function cookieHeader(access) {
  return `pp_access=${access}`;
}

// ---------------------------------------------------------------------------
// monolith ingest API (mirrors the extension flow)
// ---------------------------------------------------------------------------

async function registerMonolithClient() {
  // Fixed client_id → the server returns the SAME api key on re-runs (idempotent).
  const data = await apiJson(`${SERVER_URL}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "marketing-captures",
      name: "Marketing screenshot pipeline",
    }),
  });
  return data.api_key;
}

async function cloudLink(apiKey, accessToken) {
  await apiJson(`${SERVER_URL}/api/v1/cloud/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ access_token: accessToken }),
  });
}

async function monolith(path, apiKey, options = {}) {
  return apiJson(`${SERVER_URL}/api/v1${path}`, {
    ...options,
    headers: { "X-API-Key": apiKey, ...(options.headers ?? {}) },
  });
}

// ---------------------------------------------------------------------------
// seeding: fetch a live page with Playwright and ingest it as a single-file
// cloud page (same pipeline the extension uses: html chunks + resources)
// ---------------------------------------------------------------------------

const RESOURCE_BUDGET = {
  maxCount: 120,
  maxPerFileBytes: 3 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
};

function resourceKind(contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("text/css")) return "styles";
  if (ct.startsWith("image/")) return "images";
  if (ct.startsWith("font/") || ct.includes("font/")) return "fonts";
  return null;
}

function resourceLocalPath(url, contentType) {
  const kind = resourceKind(contentType);
  if (!kind) return null;
  let name;
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    return null;
  }
  name = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "asset";
  const extByType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/gif": ".gif",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
    "font/woff2": ".woff2",
    "font/woff": ".woff",
    "text/css": ".css",
  };
  const cleanType = (contentType || "").split(";")[0].trim().toLowerCase();
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += extByType[cleanType] ?? "";
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `${kind}/${hash}-${name}`;
}

/**
 * Load `url` in a real browser and return { html, title, resources }.
 * Resources = every css/image/font response body, keyed by absolute URL.
 */
async function fetchPageWithResources(url) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  const resources = new Map(); // absolute url → { body, contentType }
  let totalBytes = 0;

  page.on("response", async (response) => {
    if (
      resources.size >= RESOURCE_BUDGET.maxCount ||
      totalBytes >= RESOURCE_BUDGET.maxTotalBytes
    )
      return;
    try {
      const request = response.request();
      if (request.method() !== "GET") return;
      const contentType = response.headers()["content-type"] ?? "";
      if (!resourceKind(contentType)) return;
      const resUrl = response.url();
      if (resUrl.startsWith("data:")) return;
      const body = await response.body();
      if (!body || body.length === 0) return;
      if (body.length > RESOURCE_BUDGET.maxPerFileBytes) return;
      totalBytes += body.length;
      resources.set(resUrl, { body, contentType });
    } catch {
      // redirect/cache/opaque responses without bodies — skip silently
    }
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  } catch {
    // analytics beacons can keep the network busy — a loaded DOM is good enough
    log("seed", `networkidle timed out for ${url}, continuing with loaded DOM`);
  }
  await page.waitForTimeout(2_000); // settle late layout

  // Close any hover/focus menus so the captured DOM is the resting state
  await page.mouse.move(3, 3);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el && typeof el.blur === "function") el.blur();
  });
  await page.waitForTimeout(400);

  const html0 = await page.content();

  // Sweep the rendered DOM for resources the response listener missed
  // (memory-cache hits, late lazy-loads). Missing ones are fetched via the
  // context's shared request pipeline, which reliably returns bodies.
  const needed = await page.evaluate(() => {
    const abs = (u) => {
      try {
        return new URL(u, document.baseURI).href;
      } catch {
        return null;
      }
    };
    const urls = new Set();
    for (const img of document.querySelectorAll("img")) {
      const u = img.currentSrc || img.getAttribute("src");
      if (u && !u.startsWith("data:")) {
        const a = abs(u);
        if (a) urls.add(a);
      }
    }
    for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
      const a = abs(l.href);
      if (a) urls.add(a);
    }
    return [...urls];
  });
  for (const resUrl of needed) {
    if (resources.has(resUrl)) continue;
    if (
      resources.size >= RESOURCE_BUDGET.maxCount ||
      totalBytes >= RESOURCE_BUDGET.maxTotalBytes
    )
      break;
    try {
      const res = await context.request.get(resUrl);
      if (!res.ok()) continue;
      const contentType = res.headers()["content-type"] ?? "";
      if (!resourceKind(contentType)) continue;
      const body = await res.body();
      if (
        !body ||
        body.length === 0 ||
        body.length > RESOURCE_BUDGET.maxPerFileBytes
      )
        continue;
      totalBytes += body.length;
      resources.set(resUrl, { body, contentType });
    } catch {
      // unreachable or opaque — leave it; unuploaded URLs stay live links
    }
  }

  const title = await page.title();
  await browser.close();

  // Drop srcset/sizes: candidates we did not capture would 404 inside the
  // sandboxed viewer and OVERRIDE the inlined `src`. With srcset removed the
  // browser uses the (inlined) src — deterministic single-file rendering.
  let html = html0.replace(/\s(srcset|sizes)="[^"]*"/gi, "");

  // Make images survive the server pipeline deterministically:
  //  - SVG <img> → true inline <svg> markup (untouched by the server).
  //  - Raster <img> (with known dimensions) → fixed-size span with a
  //    `background-image: url(data:…)`. Both server phases skip data: URIs
  //    inside CSS url(), and the server's own single-file inliner derives
  //    the MIME from a UUID storage path (no extension) →
  //    `data:application/octet-stream`, which Chrome refuses to render.
  // Stylesheets keep being server-inlined (text inlining is type-agnostic).
  html = inlineImagesForViewer(html, url, resources);

  return { html, title, resources };
}

/** Replace <img> tags with self-contained markup that always renders. */
function inlineImagesForViewer(html, pageUrl, resources) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const match = tag.match(/\ssrc="([^"]*)"/i);
    if (!match) return tag;
    const raw = decodeHtmlEntities(match[1]);
    if (raw.startsWith("data:")) return tag;
    let abs;
    try {
      abs = new URL(raw, pageUrl).href;
    } catch {
      return tag;
    }
    const res = resources.get(abs);
    if (!res) return tag; // not captured — leaves the server's normal path
    const mime = (res.contentType || "").split(";")[0].trim().toLowerCase();

    if (mime === "image/svg+xml") {
      let svg = res.body.toString("utf8");
      const width = tag.match(/\swidth="(\d+)"/i)?.[1];
      const height = tag.match(/\sheight="(\d+)"/i)?.[1];
      svg = svg.replace(/<svg\b/i, (m) => {
        let attrs = m;
        if (width && !/\swidth=/.test(svg)) attrs += ` width="${width}"`;
        if (height && !/\sheight=/.test(svg)) attrs += ` height="${height}"`;
        return attrs;
      });
      if (/<svg[\s>]/i.test(svg)) return svg; // not parseable SVG — keep <img>
      return tag;
    }

    if (mime.startsWith("image/")) {
      const width = Number(tag.match(/\swidth="(\d+)"/i)?.[1]);
      const height = Number(tag.match(/\sheight="(\d+)"/i)?.[1]);
      if (!width || !height) return tag; // unknown layout — best effort
      const alt = (tag.match(/\salt="([^"]*)"/i)?.[1] ?? "").replace(
        /"/g,
        "&quot;",
      );
      const b64 = res.body.toString("base64");
      return (
        `<span role="img" aria-label="${alt}" ` +
        `style="display:inline-block;width:${width}px;height:${height}px;` +
        `background-image:url('data:${mime};base64,${b64}');` +
        `background-size:contain;background-repeat:no-repeat;background-position:center"></span>`
      );
    }
    return tag;
  });
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function ingestPage({ url }, apiKey, userId) {
  log("seed", `Fetching live page ${url}`);
  const { html, resources } = await fetchPageWithResources(url);

  const session = await monolith("/sessions", apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      options: { singleFile: true, pagepocketUserId: userId },
    }),
  });
  log("seed", `Session ${session.id} created`);

  await monolith(`/sessions/${session.id}/html`, apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html, scrollIndex: 0, pageType: "main" }),
  });
  log("seed", `HTML uploaded (${(html.length / 1024).toFixed(0)} KB)`);

  let uploaded = 0;
  let bytes = 0;
  for (const [resUrl, { body, contentType }] of resources) {
    const path = resourceLocalPath(resUrl, contentType);
    if (!path) continue;
    const form = new FormData();
    form.append(
      "file",
      new Blob([body], { type: contentType }),
      path.split("/").pop(),
    );
    form.append("path", path);
    form.append("originalUrl", resUrl);
    form.append("contentType", contentType);
    try {
      await monolith(`/sessions/${session.id}/resources`, apiKey, {
        method: "POST",
        body: form,
      });
      uploaded += 1;
      bytes += body.length;
    } catch (err) {
      log("seed", `  resource skipped (${path}): ${err.message.slice(0, 120)}`);
    }
  }
  log(
    "seed",
    `${uploaded} resources uploaded (${(bytes / 1024 / 1024).toFixed(1)} MB)`,
  );

  await monolith(`/sessions/${session.id}/scrape-complete`, apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceCount: uploaded }),
  });

  await monolith(`/sessions/${session.id}/finalize`, apiKey, {
    method: "POST",
  });

  // Poll until assembly + cloud push complete
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await sleep(2_500);
    const status = await monolith(`/sessions/${session.id}/status`, apiKey);
    if (status.status === "ready") {
      if (status.cloud_status === "success" && status.cloud_page_id) {
        log("seed", `Published to cloud: page ${status.cloud_page_id}`);
        return status.cloud_page_id;
      }
      if (status.cloud_status === "failed") {
        throw new Error(
          `Cloud push failed: ${status.cloud_error ?? "unknown error"}`,
        );
      }
    }
    if (status.status === "failed") {
      throw new Error(
        `Assembly failed: ${status.error_message ?? "unknown error"}`,
      );
    }
  }
  throw new Error(`Timed out waiting for session ${session.id} to publish`);
}

// ---------------------------------------------------------------------------
// demo library state (collections / share links) via the app's /api/pp proxy
// ---------------------------------------------------------------------------

async function pp(path, access, options = {}) {
  return apiJson(`${APP_URL}/api/pp${path}`, {
    ...options,
    headers: {
      Cookie: cookieHeader(access),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function listLibraryPages(access) {
  const data = await pp("/archive/pages?page=1&page_size=100", access);
  // gateway returns `id`; normalize to the page_id used elsewhere
  return (data.pages ?? []).map((p) => ({ ...p, page_id: p.page_id ?? p.id }));
}

async function ensureDemoState(access, seededPages, previousState) {
  // collection
  const { collections } = await pp("/library/collections", access);
  let collection = collections.find((c) => c.name === COLLECTION_NAME);
  if (!collection) {
    collection = await pp("/library/collections", access, {
      method: "POST",
      body: JSON.stringify({ name: COLLECTION_NAME, color: "#0d9488" }),
    });
    log("seed", `Collection "${COLLECTION_NAME}" created (${collection.id})`);
  } else {
    log("seed", `Collection "${COLLECTION_NAME}" exists (${collection.id})`);
  }
  for (const { pageId } of Object.values(seededPages)) {
    await pp(`/library/collections/${collection.id}/pages/${pageId}`, access, {
      method: "POST",
    });
  }

  // public share link for the Wikipedia page. The gateway shows the token
  // exactly once (at creation) — a later GET returns the record with an empty
  // token. To stay re-runnable, revoke the previously recorded link first.
  const wikiPageId = seededPages["wikipedia-web-archiving"].pageId;
  let share = await pp(`/share?page_id=${wikiPageId}`, access).catch(
    () => null,
  );
  if (share && !share.token) {
    const stale = previousState?.share?.token;
    if (stale) {
      await pp(`/share/${stale}`, access, { method: "DELETE" }).catch(() => {});
      log("seed", `Revoked stale share link /s/${stale}`);
    }
    share = null;
  }
  if (!share?.token) {
    share = await pp("/share", access, {
      method: "POST",
      body: JSON.stringify({ page_id: wikiPageId, is_public: true }),
    });
  }
  if (!share?.token) {
    throw new Error(
      "Share link exists but its token is unrecoverable (the gateway reveals it only at creation). " +
        "Delete the link for the demo page, or restore share.token in demo-state.json, and re-run.",
    );
  }
  log("seed", `Share link ready: /s/${share.token}`);

  return { collection, share };
}

async function seed() {
  const { email, password } = requireDemoCredentials();
  const auth = await login(email, password);
  log("seed", `Logged in as ${email} (user ${auth.userId})`);

  const previousState = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : null;

  const apiKey = await registerMonolithClient();
  await cloudLink(apiKey, auth.access);
  log("seed", "Monolith API client registered + cloud-linked");

  const existing = await listLibraryPages(auth.access);
  const seededPages = {};

  for (const spec of SEED_PAGES) {
    const already = existing.find((p) => p.url === spec.url);
    if (already) {
      log(
        "seed",
        `Page already in library (skip): ${spec.url} → ${already.page_id}`,
      );
      seededPages[spec.key] = {
        pageId: already.page_id,
        title: already.title,
        url: spec.url,
      };
      continue;
    }
    const pageId = await ingestPage(spec, apiKey, auth.userId);
    const pages = await listLibraryPages(auth.access);
    const created = pages.find((p) => p.page_id === pageId);
    seededPages[spec.key] = {
      pageId,
      title: created?.title ?? spec.key,
      url: spec.url,
    };
  }

  const { collection, share } = await ensureDemoState(
    auth.access,
    seededPages,
    previousState,
  );

  const state = {
    seededAt: new Date().toISOString(),
    account: email,
    pages: seededPages,
    collection: { id: collection.id, name: collection.name },
    share: { token: share.token, url: `${APP_URL}/s/${share.token}` },
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log("seed", `Demo state written to ${STATE_FILE}`);
  return state;
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

async function newAppContext(browser, colorScheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme,
    baseURL: APP_URL,
  });
  const { email, password } = requireDemoCredentials();
  // Login through the app's own BFF endpoint → pp_access/pp_refresh cookies
  // are set for the whole context exactly like a real browser session.
  const res = await context.request.post("/api/session", {
    data: { email, password },
  });
  if (!res.ok())
    throw new Error(`Demo login failed: ${res.status()} ${await res.text()}`);
  return context;
}

async function shoot(page, path) {
  await page.screenshot({ path });
  log("shot", `${path.replace(OUT_DIR + "/", "")}`);
}

async function loadDemoState(access) {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  }
  // Derive from the live library when no state file exists (capture-only runs).
  log("capture", "No demo-state.json — deriving ids from the demo library");
  const pages = await listLibraryPages(access);
  const state = { pages: {}, collection: null, share: null };
  for (const spec of SEED_PAGES) {
    const found = pages.find((p) => p.url === spec.url);
    if (found)
      state.pages[spec.key] = {
        pageId: found.page_id,
        title: found.title,
        url: found.url,
      };
  }
  const { collections } = await pp("/library/collections", access);
  const col = collections.find((c) => c.name === COLLECTION_NAME);
  if (col) state.collection = { id: col.id, name: col.name };
  const wiki = state.pages["wikipedia-web-archiving"];
  if (wiki) {
    const share = await pp(`/share?page_id=${wiki.pageId}`, access).catch(
      () => null,
    );
    if (share?.token)
      state.share = { token: share.token, url: `${APP_URL}/s/${share.token}` };
  }
  return state;
}

async function captureTheme(browser, theme, state) {
  const context = await newAppContext(browser, theme);
  const page = await context.newPage();

  // (a) library
  await page.goto("/app", { waitUntil: "networkidle" });
  await page
    .locator('a[href^="/app/pages/"]')
    .first()
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await shoot(page, join(OUT_DIR, `library-${theme}.png`));

  // (c) full-text search results
  await page.goto("/app/search?q=preservation", { waitUntil: "networkidle" });
  await page
    .locator('a[href^="/app/pages/"]')
    .first()
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await shoot(page, join(OUT_DIR, `search-${theme}.png`));

  // (d) collections view
  if (state.collection?.id) {
    await page.goto(`/app/collections/${state.collection.id}`, {
      waitUntil: "networkidle",
    });
    await page
      .locator('a[href^="/app/pages/"]')
      .first()
      .waitFor({ timeout: 20_000 });
    await page.waitForTimeout(500);
    await shoot(page, join(OUT_DIR, `collections-${theme}.png`));
  }

  // (b) page viewer with the archived page rendered
  const wiki = state.pages["wikipedia-web-archiving"];
  if (wiki) {
    await page.goto(`/app/pages/${wiki.pageId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("iframe").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(4_000); // archived document + external images
    await shoot(page, join(OUT_DIR, `viewer-${theme}.png`));

    if (theme === "light") {
      // tight crop: topbar search bar + live preview dropdown (clipped region
      // — the dropdown overflows the header's border box)
      await page.goto("/app", { waitUntil: "networkidle" });
      await page
        .locator('a[href^="/app/pages/"]')
        .first()
        .waitFor({ timeout: 20_000 });
      const input = page.locator('header input[name="q"]');
      await input.click();
      await input.pressSequentially("preservation", { delay: 60 });
      const dropdown = page.locator("header div.absolute").first();
      await dropdown.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      const drop = await dropdown.boundingBox();
      await page.screenshot({
        path: join(OUT_DIR, "search-preview-light.png"),
        clip: {
          x: 0,
          y: 0,
          width: Math.ceil(drop.x + drop.width + 16),
          height: Math.ceil(drop.y + drop.height + 12),
        },
      });
      log("shot", "search-preview-light.png (search + preview crop)");

      // tight crop: share dialog in its create state (page without a link)
      const mdn = state.pages["mdn-fetch-api"];
      await page.goto(`/app/pages/${mdn.pageId}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("iframe").waitFor({ timeout: 20_000 });
      await page.locator('[aria-label="Share"]').click();
      await page.getByText("Share page").first().waitFor({ timeout: 10_000 });
      await page
        .getByText("Create share link")
        .first()
        .waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await page
        .locator('[role="dialog"]')
        .screenshot({ path: join(OUT_DIR, "share-dialog-light.png") });
      log("shot", "share-dialog-light.png (dialog crop)");
    }
  }

  // (e) public share page
  if (state.share?.token) {
    // public route: open WITHOUT the demo cookies to prove it is public
    const anon = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      colorScheme: theme,
      baseURL: APP_URL,
    });
    const anonPage = await anon.newPage();
    await anonPage.goto(`/s/${state.share.token}`, {
      waitUntil: "domcontentloaded",
    });
    await anonPage.locator("iframe").waitFor({ timeout: 20_000 });
    await anonPage.waitForTimeout(4_000);
    await shoot(anonPage, join(OUT_DIR, `share-${theme}.png`));
    await anon.close();
  }

  await context.close();
}

/** Extension side panel: the action popup IS a side panel page. */
async function captureExtension() {
  if (!existsSync(EXTENSION_DIST)) {
    log(
      "capture",
      `Extension dist not found at ${EXTENSION_DIST} — skipping extension shots`,
    );
    return;
  }
  const profile = join(OUT_DIR, ".tmp-extension-profile");
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    viewport: SIDE_PANEL_VIEWPORT,
    args: [
      "--headless=new",
      `--disable-extensions-except=${EXTENSION_DIST}`,
      `--load-extension=${EXTENSION_DIST}`,
    ],
  });
  try {
    await sleep(1_500);
    const sw = context.serviceWorkers()[0];
    if (!sw) throw new Error("Extension service worker not found");
    const extId = new URL(sw.url()).host;
    const panelUrl = `chrome-extension://${extId}/sidePanel.html`;

    // onboarding modal state (PagePocket announcement) — only on a fresh profile
    const panel = await context.newPage();
    await panel.goto(panelUrl, { waitUntil: "networkidle" });
    const getStarted = panel.getByText("Get Started").first();
    try {
      await getStarted.waitFor({ timeout: 8_000 });
    } catch {
      log("capture", "Onboarding modal did not appear (profile not fresh?)");
    }
    await panel.waitForTimeout(600);
    await shoot(panel, join(OUT_DIR, "extension-onboarding.png"));

    // main "ready" state: dismiss onboarding, then stage a real page as the
    // active tab — the panel re-queries tabs.onActivated and renders the
    // connected state for that page.
    const later = panel.getByText("Maybe Later");
    if (await later.count()) {
      await later.click();
      await panel.waitForTimeout(500);
    }
    const real = await context.newPage();
    const wiki = SEED_PAGES[0].url;
    await real.goto(wiki, { waitUntil: "domcontentloaded" });
    await real.bringToFront();
    await panel.waitForTimeout(2_000);
    await shoot(panel, join(OUT_DIR, "extension-sidepanel-ready.png"));
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

async function capture() {
  const { email, password } = requireDemoCredentials();
  const auth = await login(email, password);
  const state = await loadDemoState(auth.access);
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    await captureTheme(browser, "light", state);
    await captureTheme(browser, "dark", state);
  } finally {
    await browser.close();
  }
  await captureExtension();
  log("capture", `Done — screenshots in ${OUT_DIR}`);
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const mode = process.argv[2] ?? "all";
  if (mode === "seed") await seed();
  else if (mode === "capture") await capture();
  else if (mode === "all") {
    await seed();
    await capture();
  } else {
    console.error(`Unknown mode "${mode}". Use seed | capture | all.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
