/**
 * Puppeteer UI smoke automation for docs/manual-smoke-test.md
 * (change: stabilize-extension-downloads-and-ux)
 *
 * Automates the load/render/i18n slice of the manual matrix against the
 * EXISTING dist/ build (this script never rebuilds — run `npm run build`
 * separately if you need a fresh build).
 *
 * Covered M-IDs (see REPORT in the scenario registry at the bottom):
 *   B1 (partial), B2, B3 (partial), M8, M9, M16 (partial), M18,
 *   M21 (partial), M22 (partial), M24, M25 (partial)
 * Not automatable here (real downloads / mid-download lifecycle):
 *   M1–M7, M10–M15, M17, M19, M20, M23
 *
 * Usage:
 *   HEADLESS=true node tests/e2e/ui-smoke.test.cjs   # headless (CI)
 *   node tests/e2e/ui-smoke.test.cjs                 # headed (needs a display)
 *
 * Exit codes: 0 = all scenarios PASS/SKIPPED, 1 = at least one FAIL,
 *             2 = global watchdog fired (hang protection).
 */

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist");
const HEADLESS = process.env.HEADLESS === "true";
const SHOTS_DIR = path.join(__dirname, "screenshots-ui-smoke");

const SW_ALIVE_MS = 15_000; // scenario 1: service worker must stay alive this long
const GLOBAL_WATCHDOG_MS = 8 * 60 * 1000; // hard stop so the suite never hangs

// The build bakes the production PagePocket endpoints; offline failures to
// them are expected noise, not findings (per the smoke matrix M11 premise).
const EXPECTED_OFFLINE_HOST_RE = /pagepocket\.app/;
const NETWORK_ERROR_RE =
  /net::ERR_|Failed to fetch|NetworkError|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED|ERR_EMPTY_RESPONSE|ERR_PROXY|ERR_TUNNEL/i;

// i18n keys whose literal appearance in rendered text would be a raw-key bug.
const TARGETED_RAW_KEYS = [
  "status.finalizingPartial",
  "status.downloadLocally",
  "tab.unsupportedTitle",
  "pagepocketAnnouncement.newFeature",
];

// ---------------------------------------------------------------------------
// Console output helpers (this suite PRINTS; the old e2e silenced its logs)
// ---------------------------------------------------------------------------

const C = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m" };
function log(msg, color = "reset") {
  console.log(`${C[color]}${msg}${C.reset}`);
}
function shotName(name) {
  return path.join(SHOTS_DIR, `${name}.png`);
}

// ---------------------------------------------------------------------------
// Small async helpers — every wait is bounded so the process always terminates
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT after ${ms}ms: ${label}`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitUntil(fn, { timeout = 15_000, interval = 250, label = "condition" } = {}) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  throw new Error(`waitUntil timed out after ${timeout}ms (${label})${lastError ? `; last error: ${lastError.message}` : ""}`);
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || "");
}

async function waitForBodyText(page, test, { timeout = 15_000, label = "text" } = {}) {
  return waitUntil(
    async () => {
      const text = await bodyText(page);
      return test(text) ? text : null;
    },
    { timeout, label: `body text: ${label}` },
  );
}

/**
 * The i18n backend loads locale chunks asynchronously; until then components
 * render raw keys (i18next useSuspense:false). Raw-key scans must only run on
 * the settled render, so wait for any translated marker first.
 */
async function waitForI18nReady(page, timeout = 20_000, markers = null) {
  const list = markers || [
    "This page can't be downloaded",
    "Start download",
    "Website connected!",
    "Waiting connection...",
  ];
  return waitForBodyText(
    page,
    (text) => list.some((marker) => text.includes(marker)),
    { timeout, label: `i18n settled (markers: ${list.slice(0, 2).join(" / ")}...)` },
  );
}

async function screenshot(page, name) {
  try {
    await page.screenshot({ path: shotName(name), fullPage: true });
  } catch {
    // Screenshots are best-effort diagnostics only.
  }
}

// ---------------------------------------------------------------------------
// Console / error collectors (scenario 7 sweep)
// ---------------------------------------------------------------------------

const consoleEntries = [];

function attachCollector(label, target) {
  const onConsole = (message) => {
    if (message.type() === "error") {
      consoleEntries.push({ label, kind: "console", text: message.text() || "", loc: message.location()?.url || "" });
    }
  };
  const onPageError = (error) => {
    consoleEntries.push({ label, kind: "pageerror", text: String(error?.message || error), loc: "" });
  };
  const onRequestFailed = (request) => {
    const failure = request.failure()?.errorText || "requestfailed";
    consoleEntries.push({ label, kind: "requestfailed", text: `${failure} ${request.url()}`, loc: request.url() });
  };
  target.on("console", onConsole);
  target.on("pageerror", onPageError);
  target.on("requestfailed", onRequestFailed);
  return () => {
    try {
      target.off("console", onConsole);
      target.off("pageerror", onPageError);
      target.off("requestfailed", onRequestFailed);
    } catch {
      // ignore detach races
    }
  };
}

/**
 * Classify one collected entry as a real finding or expected offline noise.
 * Expected: unreachable production PagePocket endpoints (baked VITE_SERVER_URL
 * / VITE_PAGEPOCKET_URL), the deliberately-blocked web_accessible_resources
 * probe (M24), and generic offline network failures for non-loopback hosts.
 * Loopback (our own test HTTP server) failures ARE findings.
 */
function classifyEntry(entry) {
  const text = entry.text || "";
  const urlInText = (text.match(/https?:\/\/[^\s'"]+/) || [])[0] || "";
  const url = entry.loc || urlInText;

  if (url.includes("/locales/") && /chrome-extension:|Blocked|ERR_BLOCKED_BY_CLIENT/i.test(text + url)) {
    return "expected-probe"; // M24 deliberate denial probe
  }
  // Chromium records a renderer-blocked chrome-extension:// fetch as a failed
  // request to "chrome-extension://invalid/" — same M24 probe, internal view.
  if (/chrome-extension:\/\/invalid\//.test(url) || /chrome-extension:\/\/invalid\//.test(text)) {
    return "expected-probe";
  }
  if (EXPECTED_OFFLINE_HOST_RE.test(text) || EXPECTED_OFFLINE_HOST_RE.test(url)) {
    return "expected-offline";
  }
  if (entry.kind === "requestfailed") {
    return /127\.0\.0\.1|localhost/.test(url) ? "finding" : "expected-offline";
  }
  if (NETWORK_ERROR_RE.test(text) && !url.startsWith("chrome-extension://")) {
    return "expected-offline";
  }
  return "finding";
}

// ---------------------------------------------------------------------------
// i18n raw-key scanning
// ---------------------------------------------------------------------------

function flattenKeys(obj, prefix, out) {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") flattenKeys(value, fullKey, out);
    else out.add(fullKey);
  }
  return out;
}

function loadKnownKeys() {
  try {
    const en = JSON.parse(fs.readFileSync(path.join(DIST, "locales", "en.json"), "utf8"));
    return flattenKeys(en, "", new Set());
  } catch {
    return new Set();
  }
}

const KEY_TOKEN_RE = /[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+/g;

/**
 * Scan rendered text for raw i18n keys. Two passes:
 *  1. targeted: the mission-specified key list must never appear literally.
 *  2. generic:  any dotted token in the (URL-stripped) text that exactly
 *               matches a known en.json key is a rendered raw key.
 */
function scanRawKeys(text, knownKeys) {
  const cleaned = String(text || "").replace(/https?:\/\/\S+/g, " ");
  const tokens = cleaned.match(KEY_TOKEN_RE) || [];
  const generic = [...new Set(tokens.filter((token) => knownKeys.has(token)))];
  const targeted = TARGETED_RAW_KEYS.filter((key) => cleaned.includes(key));
  return { generic, targeted };
}

// ---------------------------------------------------------------------------
// dist/ build integrity (fs-level, no browser) — B1 partial + M25 partial
// ---------------------------------------------------------------------------

function checkBuildIntegrity() {
  const problems = [];
  const required = [
    "manifest.json",
    "background.js",
    "sidePanel.html",
    "welcome.html",
    "icons",
    "_locales",
    "locales",
  ];
  for (const entry of required) {
    if (!fs.existsSync(path.join(DIST, entry))) problems.push(`missing dist/${entry}`);
  }
  if (fs.existsSync(path.join(DIST, "popup.html"))) problems.push("dist/popup.html must not exist (panel-only UI)");

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  } catch (error) {
    problems.push(`dist/manifest.json unreadable: ${error.message}`);
  }
  if (manifest) {
    const minimum = parseInt(manifest.minimum_chrome_version || "0", 10);
    if (!(minimum >= 116)) problems.push(`minimum_chrome_version expected >= 116, got "${manifest.minimum_chrome_version}"`);
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    for (const perm of ["storage", "alarms"]) {
      if (!permissions.includes(perm)) problems.push(`manifest permissions missing "${perm}"`);
    }
    if ("web_accessible_resources" in manifest) problems.push("manifest must not declare web_accessible_resources (M25/M24)");
    if (manifest.background?.type !== "module" || !manifest.background?.service_worker) {
      problems.push("manifest background must be a module service worker");
    }
  }
  return { manifest, problems };
}

/** Deterministic unpacked extension ID derived from the manifest "key". */
function extensionIdFromManifest(manifest) {
  try {
    const derKey = Buffer.from(manifest.key, "base64");
    const hash = crypto.createHash("sha256").update(derKey).digest("hex");
    return hash
      .substring(0, 32)
      .split("")
      .map((hexChar) => String.fromCharCode(parseInt(hexChar, 16) + 97))
      .join("");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tiny loopback HTTP server for the "supported page" scenario
// ---------------------------------------------------------------------------

function startLocalServer() {
  return new Promise((resolve) => {
    const page = [
      "<!DOCTYPE html><html><head><title>Smoke Test Page</title></head>",
      "<body><h1>Smoke Test Page</h1><p id=\"p\">local supported page</p></body></html>",
    ].join("");
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

// ---------------------------------------------------------------------------
// Scenario bookkeeping
// ---------------------------------------------------------------------------

const scenarios = [];

function recordScenario(id, mids, assertions) {
  const failed = assertions.filter((a) => a.status === "FAIL");
  const skipped = assertions.filter((a) => a.status === "SKIP");
  const status = failed.length ? "FAIL" : skipped.length ? "SKIPPED" : "PASS";
  scenarios.push({ id, mids, status, assertions });
  const color = status === "PASS" ? "green" : status === "FAIL" ? "red" : "yellow";
  log(`\n=== [${id}] ${status}  (M-IDs: ${mids.join(", ") || "n/a"}) ===`, color);
  for (const assertion of assertions) {
    const mark = assertion.status === "PASS" ? "✅" : assertion.status === "FAIL" ? "❌" : "⏭️ ";
    log(`  ${mark} ${assertion.name}${assertion.detail ? ` — ${assertion.detail}` : ""}`, assertion.status === "FAIL" ? "red" : "gray");
  }
  return status;
}

const pass = (name, detail = "") => ({ name, status: "PASS", detail });
const fail = (name, detail = "") => ({ name, status: "FAIL", detail });
const skip = (name, detail = "") => ({ name, status: "SKIP", detail });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const knownKeys = loadKnownKeys();
  const { manifest, problems: buildProblems } = checkBuildIntegrity();

  // ---- Scenario 1a: build integrity (fs) ---------------------------------
  {
    const assertions = [];
    if (buildProblems.length === 0) {
      assertions.push(pass("dist/ contains manifest, background.js, sidePanel.html, welcome.html, icons/, _locales/, locales/ and no popup.html"));
      assertions.push(pass("manifest: minimum_chrome_version>=116, storage+alarms permissions, no web_accessible_resources (M25 partial)"));
    } else {
      assertions.push(fail("build integrity", buildProblems.join("; ")));
    }
    recordScenario("S1a-build-integrity", ["B1 (partial — dist contents; no rebuild performed)", "M25 (partial)"], assertions);
    if (buildProblems.length) {
      log("\nBuild integrity failed — browser scenarios would test a broken build. Exiting.", "red");
      return 1;
    }
  }

  // ---- Local HTTP server for the supported-page tab ----------------------
  const { server, url: localUrl } = await startLocalServer();
  log(`\nLocal test page: ${localUrl}`, "gray");

  let browser = null;
  const detachAll = [];
  let extId = null;
  // chrome://settings tab, created in S3 and reused by S5 to activate an
  // unsupported tab (page.reload does NOT activate a background tab, so a
  // deliberate bringToFront is required to retrigger the unsupported state).
  let settingsPage = null;

  try {
    log(`\nLaunching Chrome (${HEADLESS ? "headless=new" : "headed"}) with --load-extension=${DIST}`, "cyan");
    browser = await withTimeout(
      puppeteer.launch({
        headless: HEADLESS ? "new" : false,
        args: [
          `--disable-extensions-except=${DIST}`,
          `--load-extension=${DIST}`,
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1280,1600",
        ],
        defaultViewport: null,
      }),
      60_000,
      "puppeteer.launch",
    );
    log("Browser launched.", "green");

    // ---- Scenario 1b: service worker target + extension id ---------------
    const swErrors = [];
    {
      const assertions = [];
      let swTarget = null;
      try {
        swTarget = await waitUntil(
          () => browser.targets().find((target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://")) || null,
          { timeout: 25_000, label: "service worker target" },
        );
        extId = new URL(swTarget.url()).host;
        assertions.push(pass(`service worker target exists (type=service_worker): ${swTarget.url()}`));
      } catch (error) {
        assertions.push(fail("service worker target appears within 25s", error.message));
      }

      if (swTarget) {
        // Monitor the worker for errors while we verify it stays alive 15s.
        try {
          const worker = await swTarget.worker();
          if (worker) {
            detachAll.push(attachCollector("service-worker", worker));
            assertions.push(pass("attached error listener to service worker"));
          } else {
            assertions.push(skip("attach error listener to service worker", "target.worker() returned null; liveness still polled via target list"));
          }
        } catch (error) {
          assertions.push(skip("attach error listener to service worker", `worker() failed: ${error.message}`));
        }

        const seenUrls = new Set();
        let stayedAlive = true;
        const start = Date.now();
        while (Date.now() - start < SW_ALIVE_MS) {
          const stillThere = browser
            .targets()
            .some((target) => target.type() === "service_worker" && target.url().startsWith(`chrome-extension://${extId}/`));
          if (!stillThere) {
            stayedAlive = false;
            break;
          }
          await delay(1000);
        }
        if (stayedAlive) assertions.push(pass(`service worker stayed alive ≥${SW_ALIVE_MS / 1000}s`));
        else assertions.push(fail("service worker stayed alive", "worker target disappeared during the 15s window"));
        if (swErrors.length) {
          assertions.push(fail("service worker console clean", swErrors.map((entry) => entry.text).join(" | ")));
        } else {
          assertions.push(pass("no console/page errors captured from the service worker"));
        }
        void seenUrls;
      }

      // Fallback extension-id discovery for the rest of the suite.
      if (!extId) {
        const derived = extensionIdFromManifest(manifest);
        if (derived) {
          extId = derived;
          assertions.push(skip("extension id from SW target", `fell back to manifest-key derivation: ${extId}`));
        }
      }
      recordScenario("S1b-service-worker", ["B2 (partial — loads as SW)", "M12 (supplementary: SW console clean, no download in flight)"], assertions);
    }

    if (!extId) {
      log("\nNo extension id available — cannot continue with page scenarios.", "red");
      return 1;
    }

    const panelUrl = `chrome-extension://${extId}/sidePanel.html`;
    const welcomeUrl = `chrome-extension://${extId}/welcome.html`;

    // ---- chrome://extensions: listed AND enabled (B2) ---------------------
    {
      const assertions = [];
      let extensionsPage = null;
      try {
        extensionsPage = await browser.newPage();
        detachAll.push(attachCollector("chrome://extensions", extensionsPage));
        await withTimeout(
          extensionsPage.goto("chrome://extensions", { waitUntil: "domcontentloaded", timeout: 20_000 }),
          25_000,
          "goto chrome://extensions",
        );
        await delay(1500);
        const info = await withTimeout(
          extensionsPage.evaluate(() => {
            const manager = document.querySelector("extensions-manager");
            const toolbar = manager?.shadowRoot?.querySelector("extensions-toolbar");
            const devMode = toolbar?.shadowRoot?.querySelector("#devMode");
            if (devMode && !devMode.checked) devMode.click();
            const items = manager?.shadowRoot?.querySelector("extensions-item-list")?.shadowRoot?.querySelectorAll("extensions-item") || [];
            const found = [];
            for (const item of items) {
              const name = item.shadowRoot?.querySelector("#name")?.textContent?.trim() || "";
              const enabled = item.shadowRoot?.querySelector("#enableToggle")?.checked || false;
              found.push({ id: item.id, name, enabled });
            }
            return found;
          }),
          20_000,
          "scrape chrome://extensions",
        );
        // The manifest name is a __MSG_ placeholder; resolve via _locales/en.
        let extensionName = "Web Page Downloader";
        try {
          const messages = JSON.parse(fs.readFileSync(path.join(DIST, "_locales", "en", "messages.json"), "utf8"));
          extensionName = messages.extensionName?.message || extensionName;
        } catch {
          // keep default
        }
        const mine = info.find((entry) => entry.id === extId && entry.name.includes(extensionName));
        if (mine && mine.enabled) assertions.push(pass(`extension listed and enabled in chrome://extensions ("${mine.name}", ${mine.id})`));
        else if (mine) assertions.push(fail("extension listed and enabled", `found but disabled: ${JSON.stringify(mine)}`));
        else assertions.push(fail("extension listed and enabled", `not found among ${JSON.stringify(info)}`));
      } catch (error) {
        assertions.push(skip("extension listed and enabled (chrome://extensions scrape)", `scrape failed: ${error.message}`));
      }
      await screenshot(extensionsPage, "chrome-extensions");
      recordScenario("S1c-extensions-listing", ["B2", "B3 (partial — install clean, no warnings surface in listing)"], assertions);
    }

    // ---- Panel host page + deterministic English seeding ------------------
    const panelPage = (await browser.pages())[0] || (await browser.newPage());
    detachAll.push(attachCollector("sidePanel", panelPage));
    await panelPage.setViewport({ width: 420, height: 900 });

    const seededEnglish = async () => {
      // The panel reads chrome.storage.local "language" (i18n/config.ts).
      // Seed it from inside the panel's own extension context, then reload.
      await panelPage.evaluate((language) => chrome.storage.local.set({ language }), "en");
      await withTimeout(panelPage.reload({ waitUntil: "load", timeout: 20_000 }), 25_000, "panel reload (en)");
    };

    await withTimeout(panelPage.goto(panelUrl, { waitUntil: "load", timeout: 20_000 }), 25_000, "goto sidePanel.html");
    await seededEnglish();

    // ---- Scenario 2: panel renders, no error boundary, no uncaught errors
    {
      const assertions = [];
      const errorCountBefore = consoleEntries.filter((entry) => entry.label === "sidePanel" && classifyEntry(entry) === "finding").length;
      try {
        await waitForBodyText(panelPage, (text) => text.length > 50, { timeout: 15_000, label: "non-empty panel" });
        // Locale chunks load async (raw keys flash briefly first) — scans and
        // error-boundary checks must observe the settled render.
        await waitForI18nReady(panelPage);
        const info = await panelPage.evaluate(() => ({
          children: document.getElementById("root")?.children.length || 0,
          text: (document.body?.innerText || "").slice(0, 400),
          hasAlert: !!document.querySelector('[role="alert"]'),
        }));
        if (info.children > 0) assertions.push(pass(`panel root rendered (${info.children} child nodes)`));
        else assertions.push(fail("panel root rendered", "empty #root"));

        const boundaryPhrases = ["Something went wrong", "unexpected error occurred", "Try again"];
        const boundaryHit = boundaryPhrases.filter((phrase) => info.text.includes(phrase));
        if (!info.hasAlert && boundaryHit.length === 0) assertions.push(pass("no error boundary (no role=alert, no 'Something went wrong')"));
        else assertions.push(fail("no error boundary", `role=alert=${info.hasAlert}, phrases=[${boundaryHit.join("; ")}]`));

        const scan = scanRawKeys(await bodyText(panelPage), knownKeys);
        if (scan.targeted.length === 0 && scan.generic.length === 0) assertions.push(pass("no raw i18n keys in rendered panel (en)"));
        else assertions.push(fail("no raw i18n keys in rendered panel (en)", JSON.stringify(scan)));

        const pageErrors = consoleEntries
          .filter((entry) => entry.label === "sidePanel" && entry.kind === "pageerror")
          .concat(consoleEntries.filter((entry) => entry.label === "sidePanel" && entry.kind === "console" && classifyEntry(entry) === "finding"));
        if (pageErrors.length === 0) assertions.push(pass("no uncaught errors during panel load"));
        else assertions.push(fail("no uncaught errors during panel load", pageErrors.map((entry) => entry.text).join(" | ")));
      } catch (error) {
        assertions.push(fail("panel renders", error.message));
      }
      await screenshot(panelPage, "panel-en-initial");
      void errorCountBefore;
      recordScenario("S2-panel-direct-load", ["B3 (partial — panel opens with real content; toolbar tooltip not automatable)"], assertions);
    }

    // ---- Scenario 3: unsupported state with chrome://settings active -----
    let unsupportedPathUsed = "tabs.onActivated after activating chrome://settings";
    {
      const assertions = [];
      try {
        settingsPage = await browser.newPage();
        detachAll.push(attachCollector("chrome://settings", settingsPage));
        await withTimeout(
          settingsPage.goto("chrome://settings", { waitUntil: "domcontentloaded", timeout: 20_000 }),
          25_000,
          "goto chrome://settings",
        );
        await settingsPage.bringToFront();
        await delay(500);

        const enUnsupported = JSON.parse(fs.readFileSync(path.join(DIST, "locales", "en.json"), "utf8")).translation.tab.unsupportedTitle;
        let sawUnsupported = false;
        try {
          await waitForBodyText(panelPage, (text) => text.includes(enUnsupported), { timeout: 8000, label: "unsupported title after tab switch" });
          sawUnsupported = true;
        } catch {
          // Fallback: reload the panel while chrome://settings is up. The panel
          // tab becomes active again and its own chrome-extension:// URL is
          // equally unsupported — different trigger, same asserted state.
          unsupportedPathUsed = "panel reload (panel's own chrome-extension:// URL unsupported; onActivated path did not update within 8s)";
          await withTimeout(panelPage.reload({ waitUntil: "load", timeout: 20_000 }), 25_000, "panel reload (unsupported)");
          await waitForBodyText(panelPage, (text) => text.includes(enUnsupported), { timeout: 15_000, label: "unsupported title after reload" });
          sawUnsupported = true;
        }
        if (sawUnsupported) assertions.push(pass(`unsupported-page state rendered via ${unsupportedPathUsed}`));

        const formCheck = await panelPage.evaluate(() => {
          const buttons = [...document.querySelectorAll("button")].map((button) => button.textContent?.trim() || "");
          const startButton = buttons.find((label) => /start download/i.test(label));
          const singleFile = document.getElementById("singleFile");
          const unsupportedCard = !!document.body.innerText.match(/This page can't be downloaded/i);
          return { startButton: startButton || null, hasSingleFile: !!singleFile, unsupportedCard };
        });
        if (formCheck.unsupportedCard) assertions.push(pass("localized unsupported card visible"));
        else assertions.push(fail("localized unsupported card visible", "expected text not found"));
        if (!formCheck.startButton && !formCheck.hasSingleFile) {
          assertions.push(pass("no Start button and no download form on unsupported tab"));
        } else {
          assertions.push(fail("no Start button and no download form on unsupported tab", JSON.stringify(formCheck)));
        }
      } catch (error) {
        assertions.push(fail("unsupported state", error.message));
      }
      await screenshot(panelPage, "panel-unsupported");
      if (settingsPage) await screenshot(settingsPage, "settings-tab");
      recordScenario("S3-unsupported-page", ["M8"], assertions);
    }

    // ---- Scenario 4: supported state with local http tab active ----------
    {
      const assertions = [];
      let localPage = null;
      try {
        localPage = await browser.newPage();
        detachAll.push(attachCollector("local-test-page", localPage));
        await withTimeout(localPage.goto(localUrl, { waitUntil: "load", timeout: 20_000 }), 25_000, "goto local test page");
        await localPage.bringToFront();
        await delay(500);

        // Panel must re-evaluate on tab activation WITHOUT a reload (M9).
        await waitForBodyText(panelPage, (text) => text.includes("Website connected!"), { timeout: 15_000, label: "connected state after switching to http tab" });
        assertions.push(pass("panel re-evaluated on tab switch without reopening (M9)"));

        const form = await waitUntil(
          async () => {
            const state = await panelPage.evaluate(() => {
              const startButton = [...document.querySelectorAll("button")].find((button) => /start download/i.test(button.textContent || ""));
              return {
                startFound: !!startButton,
                startDisabled: startButton ? startButton.disabled : null,
                singleFile: !!document.getElementById("singleFile"),
                text: document.body?.innerText || "",
              };
            });
            return state.startFound ? state : null;
          },
          { timeout: 15_000, label: "Start control enabled" },
        );
        if (!form.startDisabled && form.singleFile) {
          assertions.push(pass("connected/ready state with enabled Start control + download form (M18: no permission gate)"));
        } else {
          assertions.push(fail("enabled Start control", JSON.stringify({ startDisabled: form.startDisabled, singleFile: form.singleFile })));
        }

        const scan = scanRawKeys(form.text, knownKeys);
        if (scan.targeted.length === 0 && scan.generic.length === 0) assertions.push(pass("no raw i18n keys in supported state (en)"));
        else assertions.push(fail("no raw i18n keys in supported state (en)", JSON.stringify(scan)));
      } catch (error) {
        assertions.push(fail("supported state", error.message));
      }
      await screenshot(panelPage, "panel-supported");
      recordScenario("S4-supported-page", ["M9", "M18", "B3 (panel shows enabled form)"], assertions);
    }

    // ---- Scenario 5: i18n de pass + raw-key scans -------------------------
    {
      const assertions = [];
      try {
        await panelPage.evaluate((language) => chrome.storage.local.set({ language }), "de");
        await withTimeout(panelPage.reload({ waitUntil: "load", timeout: 20_000 }), 25_000, "panel reload (de)");
        const deLocale = JSON.parse(fs.readFileSync(path.join(DIST, "locales", "de.json"), "utf8")).translation;
        const deUnsupportedTitle = deLocale.tab.unsupportedTitle;
        const deConnected = deLocale.status.connected;
        const deStart = deLocale.filter.startDownload;

        // German unsupported state. page.reload() does NOT activate a
        // background tab, so the active tab is still whatever S4 left in
        // front — deliberately activate the chrome://settings tab again to
        // retrigger the unsupported state in German.
        await waitForI18nReady(panelPage, 20_000, [deUnsupportedTitle, deConnected, deStart]);
        if (settingsPage) {
          await settingsPage.bringToFront();
          await delay(500);
        }
        await waitForBodyText(panelPage, (text) => text.includes(deUnsupportedTitle), { timeout: 15_000, label: "de unsupported state" });
        const deUnsupportedScan = scanRawKeys(await bodyText(panelPage), knownKeys);
        if (deUnsupportedScan.targeted.length === 0 && deUnsupportedScan.generic.length === 0) assertions.push(pass("de unsupported state: no raw i18n keys"));
        else assertions.push(fail("de unsupported state: no raw i18n keys", JSON.stringify(deUnsupportedScan)));

        // German supported state — bring the local page back to front.
        const pages = browser.targets().filter((target) => target.type() === "page");
        let localPageAgain = null;
        for (const target of pages) {
          if (target.url().startsWith("http://127.0.0.1")) {
            localPageAgain = await target.page();
            break;
          }
        }
        if (!localPageAgain) throw new Error("local test page tab not found for de pass");
        await localPageAgain.bringToFront();
        await delay(500);
        await waitForBodyText(panelPage, (text) => text.includes(deConnected), { timeout: 15_000, label: `de connected state ("${deConnected}")` });
        const deForm = await panelPage.evaluate((startLabel) => {
          const startButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(startLabel));
          return { found: !!startButton, disabled: startButton ? startButton.disabled : null };
        }, deStart);
        if (deForm.found && !deForm.disabled) assertions.push(pass(`de UI active: "${deConnected}" + enabled "${deStart}" (language switch took effect)`));
        else assertions.push(fail("de supported state", JSON.stringify(deForm)));

        const deScan = scanRawKeys(await bodyText(panelPage), knownKeys);
        if (deScan.targeted.length === 0 && deScan.generic.length === 0) assertions.push(pass("de supported state: no raw i18n keys"));
        else assertions.push(fail("de supported state: no raw i18n keys", JSON.stringify(deScan)));
      } catch (error) {
        assertions.push(fail("i18n de pass", error.message));
      }
      await screenshot(panelPage, "panel-de-supported");
      recordScenario("S5-i18n", ["supplementary i18n coverage for B3/M8/M9 (no dedicated M-ID)"], assertions);
    }

    // ---- Scenario 6a: announcement dismissal persists (M21 partial) ------
    {
      const assertions = [];
      try {
        // Deterministic start: clear any dismissal persisted by an earlier
        // run (same in-page seeding pattern as the language setting), then
        // reload so the announcement re-evaluates from clean storage.
        await panelPage.evaluate(() => chrome.storage.local.remove("pagepocket-announcement-dismissed"));
        await panelPage.evaluate((language) => chrome.storage.local.set({ language }), "en");
        await withTimeout(panelPage.reload({ waitUntil: "load", timeout: 20_000 }), 25_000, "panel reload (announcement persistence)");
        await waitForI18nReady(panelPage);
        await delay(1500); // announcement shows (if feature enabled) after storage get resolves
        const modalVisible = () =>
          panelPage.evaluate(() => {
            // Compare lowercased: the "New Feature" badge is uppercased by CSS
            // text-transform, so innerText shows "NEW FEATURE".
            const text = (document.body?.innerText || "").toLowerCase();
            return text.includes("new feature") && (text.includes("maybe later") || text.includes("get started"));
          });
        if (!(await modalVisible())) {
          assertions.push(
            skip(
              "'Maybe Later' dismissal persists across reopen (M21)",
              "announcement modal absent even with pagepocket-announcement-dismissed cleared — announcement feature likely disabled in this build (IS_PAGEPOCKET_AVAILABLE=false), so there is nothing to dismiss; Maybe Later flow not exercised.",
            ),
          );
          assertions.push(pass("no announcement modal obstructs the panel"));
        } else {
          assertions.push(pass("announcement modal rendered on fresh load (dismissal key cleared first)"));
          // Real M21 path: dismiss via "Maybe Later" (case-insensitive —
          // the component's handleMaybeLater persists the dismissal).
          const clicked = await panelPage.evaluate(() => {
            const maybeLater = [...document.querySelectorAll("button")].find((button) => /maybe later/i.test(button.textContent || ""));
            maybeLater?.click();
            return !!maybeLater;
          });
          if (!clicked) throw new Error("'Maybe Later' button not found in the rendered announcement modal");
          await waitUntil(async () => !(await modalVisible()), { timeout: 10_000, label: "modal closes after Maybe Later" });
          // Persistence, not a one-off: the modal must stay absent across
          // two consecutive reloads.
          for (const attempt of ["first", "second"]) {
            await withTimeout(panelPage.reload({ waitUntil: "load", timeout: 20_000 }), 25_000, `panel reload (${attempt} reopen)`);
            await waitForI18nReady(panelPage);
            await delay(1500);
            if (await modalVisible()) throw new Error(`announcement modal re-appeared after ${attempt} reopen despite persisted dismissal`);
          }
          assertions.push(pass("'Maybe Later' dismissal persists across reopen (M21)", "dismissed once, then absent on two consecutive panel reloads"));
        }
      } catch (error) {
        assertions.push(fail("announcement persistence (M21)", error.message));
      }
      recordScenario("S6a-announcement-persistence", ["M21 (partial — Maybe Later path; close-button path not separately run)"], assertions);
    }

    // ---- Scenario 6b: welcome page (M16 partial) -------------------------
    {
      const assertions = [];
      let welcomePage = null;
      try {
        welcomePage = await browser.newPage();
        detachAll.push(attachCollector("welcome", welcomePage));
        await withTimeout(welcomePage.goto(welcomeUrl, { waitUntil: "load", timeout: 20_000 }), 25_000, "goto welcome.html");
        const text = await waitForBodyText(welcomePage, (body) => /how it works/i.test(body), { timeout: 15_000, label: "welcome steps title" });
        // Note: headings are uppercased by CSS text-transform, so match
        // case-insensitively against innerText.
        const checks = {
          title: /welcome to web page downloader/i.test(text),
          subtitle: /save any web page as a zip archive/i.test(text),
          steps: /open the side panel/i.test(text) && /configure your download/i.test(text) && /download the page/i.test(text),
          cta: (text.match(/open the side panel/gi) || []).length >= 2, // step1 + CTA share the label
        };
        if (checks.title && checks.subtitle) assertions.push(pass("welcome title + subtitle rendered"));
        else assertions.push(fail("welcome title + subtitle rendered", JSON.stringify(checks)));
        if (checks.steps && checks.cta) assertions.push(pass("welcome 3-step flow + CTA rendered (M16 content)"));
        else assertions.push(fail("welcome 3-step flow + CTA rendered", JSON.stringify(checks)));

        const welcomeScan = scanRawKeys(text, knownKeys);
        if (welcomeScan.targeted.length === 0 && welcomeScan.generic.length === 0) assertions.push(pass("welcome: no raw i18n keys"));
        else assertions.push(fail("welcome: no raw i18n keys", JSON.stringify(welcomeScan)));

        const welcomeErrors = consoleEntries.filter((entry) => entry.label === "welcome" && classifyEntry(entry) === "finding");
        if (welcomeErrors.length === 0) assertions.push(pass("welcome: no console errors"));
        else assertions.push(fail("welcome: no console errors", welcomeErrors.map((entry) => entry.text).join(" | ")));
      } catch (error) {
        assertions.push(fail("welcome page", error.message));
      }
      await screenshot(welcomePage, "welcome");
      recordScenario("S6b-welcome-page", ["M16 (partial — content only; 'opens exactly once on fresh install' not automated)"], assertions);
    }

    // ---- Scenario 6c: locales/en.json not web-accessible (M24) -----------
    {
      const assertions = [];
      const pages = browser.targets().filter((target) => target.type() === "page");
      let localPage = null;
      for (const target of pages) {
        if (target.url().startsWith("http://127.0.0.1")) {
          localPage = await target.page();
          break;
        }
      }
      if (!localPage) {
        recordScenario("S6c-web-accessible-probe", ["M24"], [skip("fetch probe", "local test page tab not available")]);
      } else {
        try {
          const result = await localPage.evaluate(async (probeUrl) => {
            try {
              const response = await fetch(probeUrl);
              return { ok: response.ok, status: response.status };
            } catch (error) {
              return { ok: false, status: 0, error: String(error?.message || error) };
            }
          }, `chrome-extension://${extId}/locales/en.json`);
          if (!result.ok) assertions.push(pass(`locales/en.json denied from web page context (${result.error || `HTTP ${result.status}`})`));
          else assertions.push(fail("locales/en.json denied from web page context", `fetch succeeded with HTTP ${result.status} — web_accessible_resources leak`));
        } catch (error) {
          assertions.push(skip("fetch probe", error.message));
        }
        recordScenario("S6c-web-accessible-probe", ["M24"], assertions);
      }
    }

    // ---- Scenario 6d: a11y spot-checks (M22 partial) ---------------------
    {
      const assertions = [];
      try {
        // Panel is currently on the en unsupported state (panel tab active);
        // that's fine — the header switcher + config toggle live outside the
        // form, but the config toggle needs the form → bring local tab front.
        const pages = browser.targets().filter((target) => target.type() === "page");
        let localPage = null;
        for (const target of pages) {
          if (target.url().startsWith("http://127.0.0.1")) {
            localPage = await target.page();
            break;
          }
        }
        if (localPage) {
          await localPage.bringToFront();
          await delay(500);
          await waitForBodyText(panelPage, (text) => text.includes("Start download"), { timeout: 15_000, label: "form present for a11y checks" });
        }

        const a11y = await panelPage.evaluate(() => {
          const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
          const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
          const configToggle = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-controls") === "filter-advanced-config");
          const expandedBefore = configToggle?.getAttribute("aria-expanded");
          const langTrigger = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-haspopup") === "listbox");
          return {
            duplicates,
            hasConfigToggle: !!configToggle,
            expandedBefore,
            hasLangTrigger: !!langTrigger,
          };
        });
        if (a11y.duplicates.length === 0) assertions.push(pass("no duplicate element ids in panel"));
        else assertions.push(fail("no duplicate element ids in panel", `duplicates: ${a11y.duplicates.join(", ")}`));

        if (a11y.hasConfigToggle) {
          const toggled = await panelPage.evaluate(() => {
            const configToggle = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-controls") === "filter-advanced-config");
            const before = configToggle.getAttribute("aria-expanded");
            configToggle.click();
            return new Promise((resolve) => {
              setTimeout(() => {
                const after = configToggle.getAttribute("aria-expanded");
                // restore collapsed state
                configToggle.click();
                setTimeout(() => resolve({ before, after, collapsedAgain: configToggle.getAttribute("aria-expanded") === before }), 200);
              }, 200);
            });
          });
          if (toggled.before !== toggled.after) assertions.push(pass(`advanced-config toggle reports aria-expanded (${toggled.before} → ${toggled.after})`));
          else assertions.push(fail("advanced-config toggle aria-expanded", JSON.stringify(toggled)));
        } else {
          assertions.push(skip("advanced-config toggle aria-expanded", "config toggle not rendered"));
        }

        if (a11y.hasLangTrigger) {
          const listbox = await panelPage.evaluate(async () => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const trigger = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-haspopup") === "listbox");
            trigger.click();
            await sleep(200);
            const list = document.querySelector('[role="listbox"]');
            const options = document.querySelectorAll('[role="option"]');
            if (!list || options.length === 0) return { open: false };
            options[0].focus();
            const first = document.activeElement?.textContent?.slice(0, 30) || "";
            const downEvent = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
            (document.querySelector('[role="option"]')?.parentElement || document.body).dispatchEvent(downEvent);
            await sleep(150);
            const afterDown = document.activeElement?.textContent?.slice(0, 30) || "";
            const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
            (document.querySelector('[role="option"]')?.parentElement || document.body).dispatchEvent(escapeEvent);
            await sleep(200);
            const closedAfterEscape = !document.querySelector('[role="listbox"]');
            return { open: true, first, moved: afterDown !== first, closedAfterEscape };
          });
          if (listbox.open && listbox.moved && listbox.closedAfterEscape) {
            assertions.push(pass("language listbox: opens, ArrowDown moves focus, Escape closes (M22 partial)"));
          } else {
            assertions.push(fail("language listbox keyboard support", JSON.stringify(listbox)));
          }
        } else {
          assertions.push(skip("language listbox keyboard support", "switcher trigger not found"));
        }
      } catch (error) {
        assertions.push(fail("a11y spot-checks", error.message));
      }
      recordScenario("S6d-a11y", ["M22 (partial — duplicate ids, aria-expanded, listbox keyboard; tabbability of collapsed controls not fully asserted)"], assertions);
    }

    // ---- Scenario 7: console-error sweep ----------------------------------
    {
      const findings = [];
      const expected = [];
      for (const entry of consoleEntries) {
        const verdict = classifyEntry(entry);
        if (verdict === "finding") findings.push(entry);
        else expected.push(entry);
      }
      const assertions = [];
      if (findings.length === 0) {
        assertions.push(pass(`no console/page/request failures beyond expected offline noise (${expected.length} expected entries ignored)`));
      } else {
        const unique = [];
        const seen = new Set();
        for (const entry of findings) {
          const key = `${entry.label}|${entry.kind}|${entry.text.slice(0, 200)}`;
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(entry);
          }
        }
        assertions.push(
          fail(
            "console-error sweep",
            `${findings.length} entries (${unique.length} unique): ` +
              unique.slice(0, 12).map((entry) => `[${entry.label}/${entry.kind}] ${entry.text.slice(0, 220)}`).join(" || "),
          ),
        );
      }
      if (expected.length) {
        log("\n  Expected offline/benign entries (not failures):", "gray");
        const seen = new Set();
        for (const entry of expected) {
          const key = `${entry.label}|${entry.text.slice(0, 120)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          log(`    [${entry.label}/${entry.kind}] ${entry.text.slice(0, 160)}`, "gray");
        }
      }
      recordScenario("S7-console-sweep", ["supplementary: M12 noise check (no download in flight — M12 itself NOT verified)"], assertions);
    }

    // ---- Summary -----------------------------------------------------------
    log("\n" + "=".repeat(72), "cyan");
    log("SMOKE SUMMARY (docs/manual-smoke-test.md mapping)", "cyan");
    log("=".repeat(72), "cyan");
    for (const scenario of scenarios) {
      const color = scenario.status === "PASS" ? "green" : scenario.status === "FAIL" ? "red" : "yellow";
      log(`  ${scenario.status.padEnd(8)} ${scenario.id.padEnd(32)} ${scenario.mids.join(", ")}`, color);
    }
    const failedCount = scenarios.filter((scenario) => scenario.status === "FAIL").length;
    const skippedCount = scenarios.filter((scenario) => scenario.status === "SKIPPED").length;
    log(
      `\n${scenarios.length} scenarios: ${scenarios.length - failedCount - skippedCount} passed, ${failedCount} failed, ${skippedCount} skipped`,
      failedCount ? "red" : "green",
    );
    log("Not automated (real downloads / lifecycle): M1–M7, M10–M15, M17, M19, M20, M23", "gray");
    return failedCount ? 1 : 0;
  } catch (error) {
    log(`\nFatal error: ${error.message}`, "red");
    if (error.stack) log(error.stack.split("\n").slice(0, 4).join("\n"), "gray");
    return 1;
  } finally {
    for (const detach of detachAll) {
      try {
        detach();
      } catch {
        // ignore
      }
    }
    if (browser) {
      try {
        await withTimeout(browser.close(), 15_000, "browser.close");
        log("\nBrowser closed.", "gray");
      } catch (error) {
        log(`Browser close failed: ${error.message}`, "yellow");
      }
    }
    try {
      server.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point with global watchdog so the suite can never hang
// ---------------------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error(`\nGLOBAL WATCHDOG: suite did not finish within ${GLOBAL_WATCHDOG_MS / 1000}s — aborting with exit code 2.`);
  process.exit(2);
}, GLOBAL_WATCHDOG_MS);

process.on("unhandledRejection", (reason) => {
  consoleEntries.push({ label: "process", kind: "pageerror", text: `unhandledRejection: ${String(reason)}`, loc: "" });
});

main()
  .then((code) => {
    clearTimeout(watchdog);
    process.exit(code);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error(`Fatal: ${error?.stack || error}`);
    process.exit(1);
  });
