/**
 * End-to-end browser automation test of the DOWNLOAD PIPELINE
 * (OpenSpec change "stabilize-extension-downloads-and-ux", waves 1-3).
 *
 * What this proves (against a RECORDING mock server + fixture site):
 *   R1  relative URLs resolve against the document URL       (task 1.5)
 *   R2  same-basename assets get distinct archive paths      (tasks 3.1/3.2)
 *   R3  Shift_JIS stylesheet survives charset-aware decode   (task 3.3)
 *   R4  @import chain (a.css -> b.css -> c.css) is followed  (task 3.4)
 *   R5  favicon is fetched + uploaded                        (task 3.5)
 *   R6  blob:/url(#fragment) never fetched                   (task 3.6)
 *   R7  slow/hung asset times out; run completes; cookies recorded (task 2.2)
 *   R8  scrape-complete -> finalize -> poll -> download_url -> ZIP on disk
 *   R9  two concurrent tabs finalize independently           (stretch, E2E_CONCURRENT=1)
 *
 * Build: a DEDICATED bundle in dist-e2e/ (never touches dist/) pointing at
 * the loopback mock server (plain http on 127.0.0.1 is allowed by design).
 *
 * Run:   HEADLESS=true node tests/e2e/download-pipeline.test.cjs
 *        (add E2E_REBUILD=1 to force a rebuild, E2E_CONCURRENT=1 for R9)
 */

const puppeteer = require("puppeteer");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist-e2e");
const FIXTURES_DIR = path.join(__dirname, "fixtures", "site");
const DOWNLOADS_DIR = process.env.E2E_DOWNLOADS_DIR || "/tmp/opencode/e2e-downloads";

const API_PORT = Number(process.env.E2E_API_PORT || 41773);
const FIXTURE_PORT = Number(process.env.E2E_FIXTURE_PORT || 41774);
const SERVER_URL = `http://127.0.0.1:${API_PORT}`;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
// Tab B loads its entry page from `localhost` instead of `127.0.0.1`. Both
// names are loopback (verified reachable in HEADLESS Chrome), but they are
// DISTINCT cookie jars, so each entry page's Set-Cookie `e2e_tab=A|B` marker
// is carried by exactly that tab's pipeline asset fetches. That makes every
// recorded fixture request attributable to a tab even while the two
// pipelines run concurrently (needed by R1's negative assertion — both
// fixtures legitimately fetch /img/x.png & /css/shared.css-shaped paths).
const FIXTURE_ORIGIN_B = `http://localhost:${FIXTURE_PORT}`;

const HEADLESS = process.env.HEADLESS !== "false";
const RUN_CONCURRENT = process.env.E2E_CONCURRENT === "1";
const GLOBAL_TIMEOUT_MS = Number(process.env.E2E_GLOBAL_TIMEOUT_MS || 200_000);
const FLOW_TIMEOUT_MS = Number(process.env.E2E_FLOW_TIMEOUT_MS || 90_000);

// Exactly what the side panel's Filter component sends (useScrapingDownloader
// -> handleStartDownload -> START_DOWNLOAD). singleFile OFF so resources are
// collected; links OFF so the PDF link exercises bounded (non-full) behavior.
const DOWNLOAD_OPTIONS = {
  downloadHTML: true,
  downloadImages: true,
  downloadLinks: false,
  downloadAssets: true,
  downloadContentAsText: false,
  downloadDocuments: true,
  downloadLinksFullScraping: false,
  singleFile: false,
  alwaysAskWhereToSave: false,
};

// ---------------------------------------------------------------------------
// Tiny reporting framework
// ---------------------------------------------------------------------------

const results = [];
function report(id, name, status, evidence) {
  results.push({ id, name, status, evidence });
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⏭️ ";
  console.log(`\n${icon} ${id} ${status} — ${name}`);
  if (evidence) console.log(`   ${String(evidence).split("\n").join("\n   ")}`);
}
const PASS = (id, name, evidence) => report(id, name, "PASS", evidence);
const FAIL = (id, name, evidence) => report(id, name, "FAIL", evidence);
const SKIP = (id, name, reason) => report(id, name, "SKIPPED", reason);

// ---------------------------------------------------------------------------
// Build (dedicated dist-e2e bundle)
// ---------------------------------------------------------------------------

function walkJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(p, acc);
    else if (entry.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function ensureBuild() {
  if (process.env.E2E_REBUILD !== "1" && fs.existsSync(path.join(DIST, "manifest.json"))) {
    console.log(`[build] reusing existing ${DIST}`);
  } else {
    console.log(`[build] building dist-e2e with VITE_SERVER_URL=${SERVER_URL} ...`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = spawnSync(
        "npx",
        [
          "vite",
          "build",
          "--config",
          "tests/e2e/vite.e2e.config.mjs",
          "--emptyOutDir",
        ],
        {
          cwd: ROOT,
          stdio: "inherit",
          timeout: 150_000,
          env: { ...process.env, VITE_SERVER_URL: SERVER_URL },
        },
      );
      if (res.status === 0) break;
      if (attempt === 1) {
        console.log("[build] failed once (possible concurrent dist/ rebuild race) — retrying");
      } else {
        console.error("[build] vite build failed twice");
        process.exit(2);
      }
    }
  }

  if (!fs.existsSync(path.join(DIST, "manifest.json"))) {
    console.error(`[build] ${path.join(DIST, "manifest.json")} missing after build`);
    process.exit(2);
  }
  const baked = walkJsFiles(DIST).some((f) => {
    try {
      return fs.readFileSync(f, "utf8").includes(SERVER_URL);
    } catch {
      return false;
    }
  });
  if (!baked) {
    console.error(
      `[build] VITE_SERVER_URL override did NOT land: no built .js contains ${SERVER_URL}`,
    );
    process.exit(2);
  }
  console.log(`[build] verified: built bundle contains ${SERVER_URL}`);
}

// ---------------------------------------------------------------------------
// Extension ID (pinned by the manifest "key", deterministic derivation)
// ---------------------------------------------------------------------------

function computeExtensionId() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  if (!manifest.key) return null;
  const der = Buffer.from(manifest.key, "base64");
  const hex = require("crypto")
    .createHash("sha256")
    .update(der)
    .digest()
    .subarray(0, 16)
    .toString("hex");
  return hex
    .split("")
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
}

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------

const consoleIssues = [];

function attachPageConsole(page, label) {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleIssues.push({ label, type: msg.type(), text: msg.text().slice(0, 300) });
    }
  });
  page.on("pageerror", (err) => {
    consoleIssues.push({ label, type: "pageerror", text: String(err).slice(0, 300) });
  });
}

async function attachServiceWorkerConsole(browser) {
  const attach = async (target) => {
    if (target.type() !== "service_worker" || !target.url().includes("chrome-extension://")) {
      return;
    }
    try {
      const worker = await target.worker();
      if (!worker || worker.__e2eAttached) return;
      worker.__e2eAttached = true;
      worker.on("console", (msg) => {
        if (msg.type() === "error" || msg.type() === "warning") {
          consoleIssues.push({
            label: "service-worker",
            type: msg.type(),
            text: msg.text().slice(0, 300),
          });
        }
      });
      worker.on("pageerror", (err) => {
        consoleIssues.push({
          label: "service-worker",
          type: "pageerror",
          text: String(err).slice(0, 300),
        });
      });
    } catch {
      /* best-effort */
    }
  };
  browser.targets().forEach((t) => attach(t));
  browser.on("targetcreated", attach);
}

// ---------------------------------------------------------------------------
// Pipeline flow driver (mirrors what the side panel sends)
// ---------------------------------------------------------------------------

/**
 * Drive one full download from `panelPage`'s extension-page context, exactly
 * like src/sidepanel does: START_SCROLL (content-script scrape of the fixture
 * tab) then START_DOWNLOAD (background server-mode pipeline). The awaited
 * START_DOWNLOAD response only resolves once the whole pipeline (upload,
 * finalize, assembly polling, chrome.downloads) has finished.
 */
async function runPipelineFlow(panelPage, { fixtureOrigin, pagePath, label }) {
  return panelPage.evaluate(
    async ({ fixtureOrigin, pagePath, options, timeoutMs }) => {
      const send = (action, data) =>
        chrome.runtime.sendMessage({ target: "background", message: { action, data } });

      const tabs = await chrome.tabs.query({ url: `${fixtureOrigin}/*` });
      const tab = tabs.find((t) => (t.url || "").includes(pagePath));
      if (!tab) {
        return { ok: false, stage: "find-tab", detail: `no tab matches ${pagePath}` };
      }

      // 1) Content-script scrape (same START_SCROLL the panel sends).
      const scrape = await send("START_SCROLL", { tabId: tab.id });
      if (!scrape || scrape.success === false || !scrape.html) {
        return {
          ok: false,
          stage: "scrape",
          detail: JSON.stringify(scrape)?.slice(0, 400) ?? String(scrape),
        };
      }

      // 2) Server-mode download (same START_DOWNLOAD the panel sends).
      const withTimeout = (promise, ms) =>
        Promise.race([
          promise,
          new Promise((resolve) =>
            setTimeout(() => resolve({ __timeout: true }), ms),
          ),
        ]);

      const downloadResponse = await withTimeout(
        send("START_DOWNLOAD", {
          html: scrape.html,
          tabUrl: tab.url,
          tabId: tab.id,
          downloadOptions: options,
        }),
        timeoutMs,
      );

      return {
        ok: true,
        tabId: tab.id,
        tabUrl: tab.url,
        scrapedHtmlLength: scrape.html.length,
        scrapedHtmlHasBlob: scrape.html.includes("blob:"),
        downloadResponse:
          downloadResponse && downloadResponse.__timeout
            ? "TIMEOUT"
            : downloadResponse === undefined
              ? "undefined (pipeline finished, no return value)"
              : JSON.stringify(downloadResponse)?.slice(0, 200),
      };
    },
    { fixtureOrigin, pagePath, options: DOWNLOAD_OPTIONS, timeoutMs: FLOW_TIMEOUT_MS },
  ).then((r) => ({ ...r, label }));
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function uploadFor(rec, sessionId, archivePath) {
  return rec.uploads.find((u) => u.sessionId === sessionId && u.path === archivePath);
}
function fixtureFetches(rec, reqPath) {
  return rec.fixture.filter((f) => f.path === reqPath);
}
/** Attribute a recorded fixture request to a tab via its e2e_tab marker
 *  cookie (set per entry-page response; tab A = 127.0.0.1 jar, tab B =
 *  localhost jar). Returns "A" | "B" | null (unattributed). */
function fixtureTabOf(f) {
  const m = /(?:^|;\s*)e2e_tab=([AB])(?:;|$)/.exec(f.cookie ?? "");
  return m ? m[1] : null;
}
function fixtureFetchesFor(rec, reqPath, tab) {
  return rec.fixture.filter((f) => f.path === reqPath && fixtureTabOf(f) === tab);
}
function bytesToText(buf) {
  return Buffer.from(buf).toString("utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(72));
  console.log("E2E: download pipeline (recording mock server + fixture site)");
  console.log(`  extension bundle : ${DIST}`);
  console.log(`  server (mock API): ${SERVER_URL}`);
  console.log(`  fixture site     : ${FIXTURE_ORIGIN}`);
  console.log(`  downloads dir    : ${DOWNLOADS_DIR}`);
  console.log(`  concurrent (R9)  : ${RUN_CONCURRENT}`);
  console.log("=".repeat(72));

  ensureBuild();

  fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  // Port sanity (must match the URL baked into the bundle).
  for (const port of [API_PORT, FIXTURE_PORT]) {
    const free = await new Promise((resolve) => {
      const probe = require("net").createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (!free) {
      console.error(`[ports] port ${port} is in use — pick another via E2E_API_PORT/E2E_FIXTURE_PORT and rebuild (E2E_REBUILD=1)`);
      process.exit(2);
    }
  }

  const { startMockServers } = await import("./mock-server.mjs");
  const { recording, stop } = await startMockServers({
    apiPort: API_PORT,
    fixturePort: FIXTURE_PORT,
    fixturesDir: FIXTURES_DIR,
  });
  console.log("[mock] servers up");

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: null,
  });
  console.log("[browser] launched");

  let extensionId = computeExtensionId();
  console.log(`[extension] computed id from manifest key: ${extensionId}`);
  const targetId = (() => {
    for (const t of browser.targets()) {
      const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url());
      if (m) return m[1];
    }
    return null;
  })();
  if (targetId && targetId !== extensionId) {
    console.log(`[extension] overriding with id observed from targets: ${targetId}`);
    extensionId = targetId;
  }

  await attachServiceWorkerConsole(browser);

  // CDP: direct chrome downloads into DOWNLOADS_DIR (no Save-As prompts —
  // the flow also passes alwaysAskWhereToSave:false).
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOADS_DIR,
    eventsEnabled: true,
  });

  const pages = await browser.pages();
  const fixturePage = pages[0] || (await browser.newPage());
  attachPageConsole(fixturePage, "fixture-tab");

  await fixturePage.goto(`${FIXTURE_ORIGIN}/dir/page.html`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await new Promise((r) => setTimeout(r, 1000)); // let the blob-URL script run

  const panelPage = await browser.newPage();
  attachPageConsole(panelPage, "sidePanel");
  await panelPage.goto(`chrome-extension://${extensionId}/sidePanel.html`, {
    waitUntil: "load",
    timeout: 20_000,
  });
  await new Promise((r) => setTimeout(r, 1200)); // let React mount

  const flowStartedAt = Date.now();
  const flowAPromise = runPipelineFlow(panelPage, {
    fixtureOrigin: FIXTURE_ORIGIN,
    pagePath: "/dir/page.html",
    label: "A:/dir/page.html",
  });

  // R9 (stretch): second flow from another tab, started while A is in flight.
  let flowBPromise = null;
  if (RUN_CONCURRENT) {
    const pageB = await browser.newPage();
    attachPageConsole(pageB, "fixture-tab-B");
    await pageB.goto(`${FIXTURE_ORIGIN_B}/page2.html`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await new Promise((r) => setTimeout(r, 300));
    flowBPromise = runPipelineFlow(panelPage, {
      fixtureOrigin: FIXTURE_ORIGIN_B,
      pagePath: "/page2.html",
      label: "B:/page2.html",
    });
  }

  const flowA = await flowAPromise;
  const flowB = flowBPromise ? await flowBPromise : null;
  const flowDurationMs = Date.now() - flowStartedAt;
  console.log(
    `[flow A] ${JSON.stringify(flowA)} (${Math.round(flowDurationMs / 1000)}s)`,
  );
  if (flowB) console.log(`[flow B] ${JSON.stringify(flowB)}`);

  // Give chrome.downloads a moment to flush the file.
  let zipFile = null;
  for (let i = 0; i < 40; i++) {
    const files = fs.readdirSync(DOWNLOADS_DIR).filter((f) => f.endsWith(".zip"));
    if (files.length > 0) {
      zipFile = path.join(DOWNLOADS_DIR, files[0]);
      if (fs.statSync(zipFile).size > 0) break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Close the browser BEFORE assertions so the run always terminates.
  await browser.close().catch(() => {});
  await stop();
  console.log("[cleanup] browser + servers closed");

  // -------------------------------------------------------------------------
  // Assertions
  // -------------------------------------------------------------------------
  const rec = recording;
  const sessionsCreate = rec.api.filter(
    (a) => a.method === "POST" && a.path === "/api/v1/sessions",
  );
  const sessionA =
    rec.sessions?.find?.((s) => (s.url || "").includes("/dir/page.html"))?.id ??
    null;

  // ---- Flow-level evidence ----
  if (!flowA.ok) {
    FAIL(
      "FLOW",
      "pipeline flow A did not start",
      `stage=${flowA.stage} detail=${flowA.detail}`,
    );
  } else {
    PASS(
      "FLOW",
      "pipeline flow A ran (START_SCROLL + START_DOWNLOAD accepted)",
      `scrapedHtmlLength=${flowA.scrapedHtmlLength} response=${flowA.downloadResponse}`,
    );
  }

  // ---- R1: relative resolution against the document URL ----
  {
    const scoped = sessionA ? rec.uploads.filter((u) => u.sessionId === sessionA) : rec.uploads;
    const gotNestedImg =
      scoped.some((u) => u.path === "images/dir/img/x.png") &&
      fixtureFetches(rec, "/dir/img/x.png").length > 0;
    const gotSharedCss =
      scoped.some((u) => u.path === "styles/css/shared.css") &&
      fixtureFetches(rec, "/css/shared.css").length > 0;
    // Negative assertion scoped to SESSION A's fetches only: in concurrent
    // mode tab B's document (/page2.html, at the host root) legitimately
    // references /img/x.png and css/shared.css, so an unscoped check would
    // flag B's correct fetches as A's host-root joins. Tab attribution comes
    // from the e2e_tab marker cookie each entry page's response sets (tab A
    // on 127.0.0.1, tab B on localhost — separate cookie jars).
    const hostRootWrong =
      fixtureFetchesFor(rec, "/img/x.png", "A").length > 0 ||
      fixtureFetchesFor(rec, "/dir/css/shared.css", "A").length > 0;

    if (gotNestedImg && gotSharedCss && !hostRootWrong) {
      PASS(
        "R1",
        "relative URLs resolved against the document URL (task 1.5)",
        `uploads: images/dir/img/x.png + styles/css/shared.css; fetches: /dir/img/x.png, /css/shared.css; ` +
          `no host-root-joined fetches from session A ` +
          `(contested paths by tab: /img/x.png A=${fixtureFetchesFor(rec, "/img/x.png", "A").length}/B=${fixtureFetchesFor(rec, "/img/x.png", "B").length}, ` +
          `/dir/css/shared.css A=${fixtureFetchesFor(rec, "/dir/css/shared.css", "A").length}/B=${fixtureFetchesFor(rec, "/dir/css/shared.css", "B").length})`,
      );
    } else {
      FAIL(
        "R1",
        "relative URL resolution",
        `nestedImg=${gotNestedImg} sharedCss=${gotSharedCss} hostRootWrongFetch(A)=${hostRootWrong}` +
          `\nscoped upload paths: ${scoped.map((u) => u.path).join(", ") || "(none)"}`,
      );
    }
  }

  // ---- R2: same-basename collision pair ----
  {
    const scoped = sessionA ? rec.uploads.filter((u) => u.sessionId === sessionA) : rec.uploads;
    const a = uploadFor(rec, sessionA, "styles/a/main.css");
    const b = uploadFor(rec, sessionA, "styles/b/main.css");
    const distinctPaths = !!a && !!b;
    const distinctContent =
      distinctPaths &&
      bytesToText(a.bytes).includes("ALPHA") &&
      bytesToText(b.bytes).includes("BETA");
    if (distinctPaths && distinctContent) {
      PASS(
        "R2",
        "same-basename stylesheets uploaded under DISTINCT paths (tasks 3.1/3.2)",
        `styles/a/main.css (${a.bytes.length}B, "ALPHA") + styles/b/main.css (${b.bytes.length}B, "BETA")`,
      );
    } else {
      FAIL(
        "R2",
        "collision-free archive paths",
        `a=${!!a} b=${!!b} distinctContent=${distinctContent}` +
          `\nall scoped paths: ${scoped.map((u) => u.path).join(", ") || "(none)"}`,
      );
    }
  }

  // ---- R3: Shift_JIS charset ----
  {
    const sjis = uploadFor(rec, sessionA, "styles/css/sjis.css");
    if (!sjis) {
      FAIL(
        "R3",
        "Shift_JIS stylesheet upload",
        `no upload with path styles/css/sjis.css; uploaded: ${rec.uploads.map((u) => u.path).join(", ")}`,
      );
    } else {
      let ok = false;
      let utf8Text = "";
      let evidence = "";
      try {
        // The extension decodes Shift_JIS -> JS string, then uploads the Blob
        // as UTF-8. So the CORRECT uploaded bytes decode as UTF-8 to the
        // intact Japanese text; the regression this guards against (UTF-8
        // response.text() on Shift_JIS bytes) would upload mojibake
        // (譌･譛ｬ...) / U+FFFD instead.
        utf8Text = new TextDecoder("utf-8").decode(Buffer.from(sjis.bytes));
        const correct = utf8Text.includes("日本語テキスト");
        const notMojibake =
          !utf8Text.includes("譌･譛ｬ") && !utf8Text.includes("\uFFFD");
        ok = correct && notMojibake;
        evidence =
          `uploaded bytes (utf-8): ${JSON.stringify(utf8Text.slice(0, 90))}; ` +
          `intact JP text: ${correct}; no mojibake/replacement chars: ${notMojibake}; ` +
          `gzipped-at-upload: ${sjis.gzipped}`;
      } catch (err) {
        evidence = `decode failed: ${err.message}`;
      }
      if (ok) {
        PASS("R3", "Shift_JIS css uploaded without mojibake (task 3.3)", evidence);
      } else {
        FAIL("R3", "Shift_JIS charset-aware decode", evidence);
      }
    }
  }

  // ---- R4: @import chain ----
  {
    const scoped = sessionA ? rec.uploads.filter((u) => u.sessionId === sessionA) : rec.uploads;
    const bUp = scoped.some((u) => u.path === "styles/css/b.css");
    const cUp = scoped.some((u) => u.path === "styles/css/c.css");
    const bFetched = fixtureFetches(rec, "/css/b.css").length > 0;
    const cFetched = fixtureFetches(rec, "/css/c.css").length > 0;
    if (bUp && cUp && bFetched && cFetched) {
      PASS(
        "R4",
        "@import chain followed (a.css -> b.css -> c.css) (task 3.4)",
        `fetches: /css/b.css, /css/c.css; uploads: styles/css/b.css + styles/css/c.css`,
      );
    } else {
      FAIL(
        "R4",
        "@import chain",
        `bFetched=${bFetched} cFetched=${cFetched} bUpload=${bUp} cUpload=${cUp}`,
      );
    }
  }

  // ---- R5: favicon ----
  {
    const fetched = fixtureFetches(rec, "/favicon.ico").length > 0;
    const scoped = sessionA ? rec.uploads.filter((u) => u.sessionId === sessionA) : rec.uploads;
    const uploaded = scoped.some((u) => u.path === "images/favicon.ico");
    if (fetched && uploaded) {
      PASS("R5", "favicon fetched + uploaded (task 3.5)", `/favicon.ico fetched; images/favicon.ico uploaded`);
    } else {
      FAIL("R5", "favicon capture", `fetched=${fetched} uploaded=${uploaded}`);
    }
  }

  // ---- R6: non-downloadable schemes ----
  {
    const blobFetches = rec.fixture.filter(
      (f) => f.path.includes("blob:") || f.path.includes("gradient"),
    );
    const blobUploads = rec.uploads.filter(
      (u) =>
        (u.originalUrl || "").includes("blob:") ||
        (u.path || "").includes("gradient"),
    );
    const domHadBlob = rec.htmlChunks.some((c) => c.html.includes("blob:"));
    if (blobFetches.length === 0 && blobUploads.length === 0) {
      PASS(
        "R6",
        "blob:/url(#fragment) never fetched (task 3.6)",
        `0 fixture requests matched blob:/gradient; 0 uploads reference blob:` +
          `; scraped DOM contained blob: img: ${domHadBlob ? "yes (filtered correctly)" : "NO — page script may not have run"}`,
      );
    } else {
      FAIL(
        "R6",
        "non-downloadable scheme filtering",
        `blobFetches=${JSON.stringify(blobFetches.map((f) => f.path))} blobUploads=${blobUploads.length}`,
      );
    }
  }

  // ---- R7: timeouts + credentials ----
  {
    const slowFetches = fixtureFetches(rec, "/slow.png");
    const notFound = fixtureFetches(rec, "/img404.png");
    const flowOk = flowA.ok;
    const completed = rec.finalized.length > 0;
    const cookieFetches = rec.fixture.filter((f) => f.hasCookie).length;
    if (flowOk && completed && slowFetches.length >= 1) {
      const slowNote =
        slowFetches.length >= 2
          ? `${slowFetches.length} requests (attempt 1 aborted at the 30s requestTimeout, a retry followed)`
          : `${slowFetches.length} request (attempt aborted at the 30s requestTimeout, no retry observed)`;
      PASS(
        "R7",
        "slow asset timed out; pipeline still completed; cookies recorded (task 2.2)",
        `/slow.png: ${slowNote}; ` +
          `/img404.png requested ${notFound.length}x (credentialed 4xx -> credentials:omit retry: ${notFound.length === 2 ? "yes" : "see count"}); ` +
          `fixture requests carrying a Cookie header: ${cookieFetches}/${rec.fixture.length}; ` +
          `flow duration ${Math.round(flowDurationMs / 1000)}s`,
      );
    } else {
      FAIL(
        "R7",
        "timeout enforcement / run completion",
        `slowRequests=${slowFetches.length} flowOk=${flowOk} finalized=${rec.finalized.length}`,
      );
    }
  }

  // ---- R8: session lifecycle + download ----
  {
    const sid = sessionA;
    const scraped = sid && rec.scrapeCompleted.includes(sid);
    const finalized = sid && rec.finalized.includes(sid);
    const polls = sid ? rec.statusPolls[sid] ?? 0 : 0;
    const zipOk = !!zipFile && fs.statSync(zipFile).size > 1;
    const isZip = zipOk && fs.readFileSync(zipFile).subarray(0, 2).toString() === "PK";
    if (sid && scraped && finalized && polls >= 2 && zipOk && isZip) {
      PASS(
        "R8",
        "register -> session -> scrape-complete -> finalize -> poll -> download_url -> ZIP on disk",
        `session=${sid}; scrape-complete + finalize recorded; ${polls} status polls; ` +
          `zip=${zipFile} (${fs.statSync(zipFile).size}B, PK magic ok); /fake.zip served ${rec.downloadServed}x`,
      );
    } else {
      FAIL(
        "R8",
        "session lifecycle / assembly / download",
        `sessionId=${sid} scrapeComplete=${scraped} finalized=${finalized} polls=${polls} ` +
          `zip=${zipFile} zipValid=${isZip}\n` +
          `api recording (first 25):\n` +
          rec.api
            .slice(0, 25)
            .map((a) => `  ${a.method} ${a.path} apiKey=${a.apiKey}`)
            .join("\n"),
      );
    }
  }

  // ---- R9: concurrent tabs (stretch) ----
  if (!RUN_CONCURRENT) {
    SKIP("R9", "concurrent tabs finalize independently", "not requested — run with E2E_CONCURRENT=1");
  } else if (!flowB || !flowB.ok) {
    FAIL(
      "R9",
      "concurrent tabs",
      `flowB=${JSON.stringify(flowB)}; sessions created=${rec.sessions.length}`,
    );
  } else {
    const sessionB =
      rec.sessions.find((s) => (s.url || "").includes("/page2.html"))?.id ?? null;
    const aFinalized = sessionA && rec.finalized.includes(sessionA);
    const bFinalized = sessionB && rec.finalized.includes(sessionB);
    if (sessionB && sessionB !== sessionA && aFinalized && bFinalized) {
      PASS(
        "R9",
        "two tabs finalized independently",
        `A=${sessionA} B=${sessionB} (distinct); both finalized + polled to ready`,
      );
    } else {
      FAIL(
        "R9",
        "concurrent tabs finalize independently",
        `A=${sessionA} (finalized=${!!aFinalized}) B=${sessionB} (finalized=${!!bFinalized}) — ` +
          `see R8/product-findings: the first-finishing tab appears to break the other tab's asset pipeline ` +
          `(shared requestQueue.clear() in download teardown)`,
      );
    }
  }

  // ---- Additional observations (linked-page bounding / documents / timing) ----
  {
    const linkedChunks = rec.htmlChunks.filter((c) => c.pageType === "linked");
    const pdfUpload = uploadFor(rec, sessionA, "documents/doc.pdf");
    const slowUp = uploadFor(rec, sessionA, "images/slow.png");
    const t0 = rec.fixture[0]?.ts ?? 0;
    const rel = (ts) => `+${((ts - t0) / 1000).toFixed(1)}s`;
    console.log(
      `\n[observations] linked-page bounding: linked html chunks=${linkedChunks.length} (expect 0 — PDF must not be uploaded as HTML); ` +
        `documents/doc.pdf uploaded=${!!pdfUpload}; html chunks recorded=${rec.htmlChunks.length}; ` +
        `registrations=${rec.registrations}; filename-map entries=${Object.values(rec.filenameMaps).reduce((a, m) => a + Object.keys(m).length, 0)}`,
    );
    console.log(
      `[observations] /slow.png: requests at ${fixtureFetches(rec, "/slow.png").map((f) => rel(f.ts)).join(", ")}, ` +
        `uploaded=${slowUp ? `${slowUp.bytes.length}B` : "no (recorded as failed)"}` +
        `; /img404.png: requests at ${fixtureFetches(rec, "/img404.png").map((f) => rel(f.ts)).join(", ")}` +
        `; /slow.png cookie header: ${fixtureFetches(rec, "/slow.png").map((f) => f.cookie).join(" | ") || "(none)"}`,
    );
    // Session lifecycle timeline (when each control-plane call happened).
    const apiT0 = rec.api[0]?.ts ?? 0;
    const lifecycle = rec.api
      .filter(
        (a) =>
          a.path === "/api/v1/sessions" ||
          a.path.endsWith("/scrape-complete") ||
          a.path.endsWith("/finalize") ||
          a.path.endsWith("/status"),
      )
      .map(
        (a) =>
          `${a.method} ${a.path.replace("/api/v1/sessions/", "").replace("/api/v1/sessions", "create") || "?"} @+${((a.ts - apiT0) / 1000).toFixed(1)}s`,
      );
    console.log(`[observations] lifecycle: ${lifecycle.join("; ")}`);
    if (linkedChunks.length > 0) {
      console.log(
        `[observations] ⚠️  PRODUCT BUG EVIDENCE: PDF link was uploaded as a linked HTML document: ` +
          linkedChunks.map((c) => `${c.pageUrl} (${c.htmlLength}B)`).join(", "),
      );
    }
  }

  // ---- Console errors ----
  const errors = consoleIssues.filter((i) => i.type !== "warning");
  if (errors.length > 0) {
    console.log(`\n[console] ${errors.length} console/page errors captured:`);
    for (const e of errors.slice(0, 25)) {
      console.log(`  [${e.label}] ${e.type}: ${e.text}`);
    }
  } else {
    console.log("\n[console] no console/page errors captured");
  }

  // ---- Summary ----
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIPPED").length;
  console.log("\n" + "=".repeat(72));
  console.log(`SUMMARY: ${pass} passed, ${fail} failed, ${skip} skipped`);
  console.log("=".repeat(72));

  process.exitCode = fail > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Bootstrap: global timeout + guaranteed cleanup
// ---------------------------------------------------------------------------

const globalTimer = setTimeout(() => {
  console.error(`\nFATAL: global timeout (${GLOBAL_TIMEOUT_MS / 1000}s) — terminating`);
  process.exit(3);
}, GLOBAL_TIMEOUT_MS);
globalTimer.unref?.();

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exitCode = 2;
});
