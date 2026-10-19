import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  assetFileUrlPrefix,
  assetTokenExpiryEpoch,
  injectAssetToken,
  mintAssetToken,
} from "./asset-token";

// env.ts parses process.env at import time — seed before importing it.
process.env.NEXT_PUBLIC_API_BASE_URL ||= "http://localhost:8090/api/v1";
process.env.NEXT_PUBLIC_MARKETING_SITE_URL ||= "http://localhost:3000";
process.env.COOKIE_SECRET ||= "test-cookie-secret";

const { DEFAULT_ASSET_TOKEN_TTL_SECONDS, assetTokenConfig } =
  await import("./env");

const SECRET = "unit-test-asset-secret";
const TTL = 604800;

const PAGE_ID = "17860421";
const USER_ID = "6b8136ae-a772-4e16-93ab-3518d609c754";

afterEach(() => {
  delete process.env.ASSET_TOKEN_SECRET;
  delete process.env.ASSET_TOKEN_TTL_SECONDS;
});

describe("mintAssetToken — wire contract", () => {
  const nowMs = Date.UTC(2026, 9, 19, 12, 0, 0);

  function b64url(input: string): string {
    return Buffer.from(input, "utf8").toString("base64url");
  }

  it("payload is compact JSON {p,u,e}, base64url without padding", async () => {
    const token = await mintAssetToken({
      secret: SECRET,
      pageId: PAGE_ID,
      userId: USER_ID,
      ttlSeconds: TTL,
      nowMs,
    });

    const [payload, mac] = token.split(".") as [string, string];
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mac).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");

    const expectedPayload = b64url(
      JSON.stringify({
        p: PAGE_ID,
        u: USER_ID,
        e: assetTokenExpiryEpoch(TTL, nowMs),
      }),
    );
    expect(payload).toBe(expectedPayload);
    expect(Buffer.from(payload, "base64url").toString("utf8")).toBe(
      JSON.stringify({
        p: PAGE_ID,
        u: USER_ID,
        e: assetTokenExpiryEpoch(TTL, nowMs),
      }),
    );
  });

  it("mac is HMAC-SHA256(ASSET_TOKEN_SECRET, payload_b64url), base64url no padding", async () => {
    const token = await mintAssetToken({
      secret: SECRET,
      pageId: PAGE_ID,
      userId: USER_ID,
      ttlSeconds: TTL,
      nowMs,
    });

    const [payload, mac] = token.split(".") as [string, string];
    const expectedMac = createHmac("sha256", SECRET)
      .update(payload)
      .digest("base64url");
    expect(mac).toBe(expectedMac);
  });

  it("expiry buckets: e = (floor(now/TTL) + 2) * TTL — stable within a bucket, different across buckets", async () => {
    const bucketStartMs = 1792368000000 - (1792368000000 % (TTL * 1000)); // aligned to a bucket edge
    const earlyInBucket = bucketStartMs + 1000;
    const lateInBucket = bucketStartMs + TTL * 1000 - 2000; // same bucket
    const nextBucket = bucketStartMs + TTL * 1000 + 1000; // next bucket

    expect(assetTokenExpiryEpoch(TTL, earlyInBucket)).toBe(
      (Math.floor(earlyInBucket / 1000 / TTL) + 2) * TTL,
    );

    const early = await mintAssetToken({
      secret: SECRET,
      pageId: PAGE_ID,
      userId: USER_ID,
      ttlSeconds: TTL,
      nowMs: earlyInBucket,
    });
    const late = await mintAssetToken({
      secret: SECRET,
      pageId: PAGE_ID,
      userId: USER_ID,
      ttlSeconds: TTL,
      nowMs: lateInBucket,
    });
    const next = await mintAssetToken({
      secret: SECRET,
      pageId: PAGE_ID,
      userId: USER_ID,
      ttlSeconds: TTL,
      nowMs: nextBucket,
    });

    // Deterministic within the bucket → browser-cached URLs stay valid.
    expect(late).toBe(early);
    // A new bucket mints a new (still-valid-until-end-of-next) token.
    expect(next).not.toBe(early);
    const earlyExp = JSON.parse(
      Buffer.from(early.split(".")[0]!, "base64url").toString("utf8"),
    ) as { e: number };
    const nextExp = JSON.parse(
      Buffer.from(next.split(".")[0]!, "base64url").toString("utf8"),
    ) as { e: number };
    expect(nextExp.e).toBe(earlyExp.e + TTL);
  });

  it("a different secret, page, or user yields a different token", async () => {
    const base = {
      pageId: PAGE_ID,
      userId: USER_ID,
      ttlSeconds: TTL,
      nowMs: 0,
    };
    const a = await mintAssetToken({ secret: SECRET, ...base });
    const b = await mintAssetToken({ secret: "other-secret", ...base });
    const c = await mintAssetToken({ secret: SECRET, ...base, pageId: "p-2" });
    const d = await mintAssetToken({ secret: SECRET, ...base, userId: "u-2" });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe("injectAssetToken — <base> href injection", () => {
  const token = "abcDEF123_-xyz.987ZYX_w-1";
  const prefix = assetFileUrlPrefix(PAGE_ID);
  // The iframe document URL the browser resolves relative refs against.
  const documentUrl = `https://app.pagepocket.app/api/pp/archive/pages/${PAGE_ID}/f/index.html`;

  /** Resolve `ref` the way the browser does, against `base`. */
  function resolve(ref: string, base: string): string {
    return new URL(ref, new URL(base, documentUrl)).href;
  }

  it("injects <base href='./at/{token}/'> immediately after <head> when the HTML has no <base>", () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><link href="./styles/entry.B_c7_SPs.css" rel="stylesheet"><img src="./images/x.svg"></body></html>`;

    const { html: out, modified } = injectAssetToken(html, PAGE_ID, token);

    expect(modified).toBe(true);
    expect(out).toBe(
      `<!doctype html><html lang="en"><head><base href="./at/${token}/"><meta charset="utf-8"><title>t</title></head><body><link href="./styles/entry.B_c7_SPs.css" rel="stylesheet"><img src="./images/x.svg"></body></html>`,
    );
  });

  it("relative refs (./, ../, plain, inline CSS url()) resolve to the gateway's /f/at/{token}/ route via the injected base", () => {
    const html = `<head></head><body><link href="./styles/entry.B_c7_SPs.css" rel="stylesheet"><img src="../images/up.svg"><img src="images/plain.svg"><style>mask:url("./images/day-cloudy.svg")</style></body>`;

    const { html: out } = injectAssetToken(html, PAGE_ID, token);
    const base = /<base href="([^"]+)">/.exec(out)![1]!;

    expect(resolve(base, documentUrl)).toBe(
      `https://app.pagepocket.app/api/pp/archive/pages/${PAGE_ID}/f/at/${token}/`,
    );
    // Every ref kind under the base resolves inside the token segment…
    expect(resolve("./styles/entry.B_c7_SPs.css", base)).toBe(
      `https://app.pagepocket.app/api/pp/archive/pages/${PAGE_ID}/f/at/${token}/styles/entry.B_c7_SPs.css`,
    );
    expect(resolve("images/plain.svg", base)).toBe(
      `https://app.pagepocket.app/api/pp/archive/pages/${PAGE_ID}/f/at/${token}/images/plain.svg`,
    );
    expect(resolve("./images/day-cloudy.svg", base)).toBe(
      `https://app.pagepocket.app/api/pp/archive/pages/${PAGE_ID}/f/at/${token}/images/day-cloudy.svg`,
    );
    // …except a `../` that climbs OUT of the token segment (base sits at
    // /f/at/{token}/, so one `../` pops the token and lands on /f/at/) —
    // inherent to the scheme; documented here so the resolution is pinned,
    // not assumed.
    expect(resolve("../images/up.svg", base)).toBe(
      `https://app.pagepocket.app/api/pp/archive/pages/${PAGE_ID}/f/at/images/up.svg`,
    );
  });

  it("matches <head> case-insensitively and with attributes; falls back to <html>, then prepends", () => {
    const withHeadAttrs = injectAssetToken(
      `<HTML lang="en"><HEAD profile="x"><title>t</title></HEAD>`,
      PAGE_ID,
      token,
    );
    expect(withHeadAttrs.html).toContain(
      `<HEAD profile="x"><base href="./at/${token}/">`,
    );

    const noHead = injectAssetToken(
      `<html><body><p>hi</p></body></html>`,
      PAGE_ID,
      token,
    );
    expect(noHead.html).toBe(
      `<html><base href="./at/${token}/"><body><p>hi</p></body></html>`,
    );

    const neither = injectAssetToken(`<p>fragment</p>`, PAGE_ID, token);
    expect(neither.html).toBe(`<base href="./at/${token}/"><p>fragment</p>`);
  });

  it("inline <style> url() bytes are NOT rewritten — the base element does the work", () => {
    const style = `<style>.i{mask:url("./images/day-cloudy.svg")}</style>`;
    const html = `<html><head>${style}</head><body><img src="./images/x.svg"></body></html>`;

    const { html: out, modified } = injectAssetToken(html, PAGE_ID, token);

    expect(modified).toBe(true);
    // Only the base element was inserted — the style rule is byte-identical.
    expect(out).toContain(style);
    expect(out).toBe(
      `<html><head><base href="./at/${token}/">${style}</head><body><img src="./images/x.svg"></body></html>`,
    );
    // No asset URL anywhere gained a token segment.
    expect(out.match(/at\//g)).toHaveLength(1);
  });

  it("retokenizes an EXISTING <base href> that points at this page's f-route (root-relative and absolute)", () => {
    const rootRelative = injectAssetToken(
      `<html><head><base href="${prefix}"></head></html>`,
      PAGE_ID,
      token,
    );
    expect(rootRelative.modified).toBe(true);
    expect(rootRelative.html).toContain(`<base href="${prefix}at/${token}/">`);

    const absolute = injectAssetToken(
      `<html><head><base href="https://app.pagepocket.app${prefix}" target="_blank"></head></html>`,
      PAGE_ID,
      token,
    );
    expect(absolute.modified).toBe(true);
    expect(absolute.html).toContain(
      `<base href="https://app.pagepocket.app${prefix}at/${token}/" target="_blank">`,
    );
  });

  it("leaves the document untouched when an existing <base> points elsewhere (fail-safe)", () => {
    for (const href of [
      "/f/",
      "/api/pp/archive/pages/other-page/f/",
      "/api/sc/tok/f/",
      "https://cdn.example.com/assets/",
    ]) {
      const html = `<html><head><base href="${href}"></head><body><img src="./x.png"></body></html>`;
      const { html: out, modified } = injectAssetToken(html, PAGE_ID, token);
      expect(modified).toBe(false);
      expect(out).toBe(html);
    }
  });

  it("a <base> without href establishes no base URL — document untouched", () => {
    const html = `<html><head><base target="_blank"></head></html>`;
    const { html: out, modified } = injectAssetToken(html, PAGE_ID, token);
    expect(modified).toBe(false);
    expect(out).toBe(html);
  });

  it("is idempotent — an already-injected ./at/ base or an already-tokenized f-route base is never double-inserted", () => {
    const injected = `<html><head><base href="./at/${token}/"></head></html>`;
    const again = injectAssetToken(injected, PAGE_ID, token);
    expect(again.modified).toBe(false);
    expect(again.html).toBe(injected);

    const tokenized = `<html><head><base href="${prefix}at/${token}/x/"></head></html>`;
    const retok = injectAssetToken(tokenized, PAGE_ID, token);
    expect(retok.modified).toBe(false);
    expect(retok.html).toBe(tokenized);
    expect(retok.html).not.toContain("/at/at/");
  });
});

describe("assetTokenConfig — feature flag", () => {
  it("is OFF (null) when the secret is unset or empty", () => {
    delete process.env.ASSET_TOKEN_SECRET;
    expect(assetTokenConfig()).toBeNull();
    process.env.ASSET_TOKEN_SECRET = "   ";
    expect(assetTokenConfig()).toBeNull();
  });

  it("is ON with the default TTL when only the secret is set", () => {
    process.env.ASSET_TOKEN_SECRET = "s3cret";
    delete process.env.ASSET_TOKEN_TTL_SECONDS;
    expect(assetTokenConfig()).toEqual({
      secret: "s3cret",
      ttlSeconds: DEFAULT_ASSET_TOKEN_TTL_SECONDS,
    });
    expect(DEFAULT_ASSET_TOKEN_TTL_SECONDS).toBe(604800);
  });

  it("parses ASSET_TOKEN_TTL_SECONDS when set, falling back on garbage", () => {
    process.env.ASSET_TOKEN_SECRET = "s3cret";
    process.env.ASSET_TOKEN_TTL_SECONDS = "3600";
    expect(assetTokenConfig()).toEqual({ secret: "s3cret", ttlSeconds: 3600 });
    process.env.ASSET_TOKEN_TTL_SECONDS = "not-a-number";
    expect(assetTokenConfig()).toEqual({
      secret: "s3cret",
      ttlSeconds: DEFAULT_ASSET_TOKEN_TTL_SECONDS,
    });
  });
});
