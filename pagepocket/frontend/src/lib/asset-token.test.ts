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

describe("injectAssetToken — HTML rewrite", () => {
  const token = "abcDEF123_-xyz.987ZYX_w-1";
  const prefix = assetFileUrlPrefix(PAGE_ID);

  it("rewrites absolute (any host) and root-relative f-URLs for THIS page", () => {
    const html = [
      `<link href="https://app.pagepocket.app${prefix}assets/style.css" rel="stylesheet">`,
      `<link href="http://localhost:3000${prefix}assets/app.js" rel="stylesheet">`,
      `<img src="${prefix}img.png">`,
    ].join("\n");

    const { html: rewritten, replaced } = injectAssetToken(
      html,
      PAGE_ID,
      token,
    );

    expect(replaced).toBe(3);
    expect(rewritten).toContain(
      `https://app.pagepocket.app${prefix}at/${token}/assets/style.css`,
    );
    expect(rewritten).toContain(
      `http://localhost:3000${prefix}at/${token}/assets/app.js`,
    );
    expect(rewritten).toContain(`src="${prefix}at/${token}/img.png"`);
  });

  it("is idempotent — URLs already carrying a token are never double-injected", () => {
    const html = `<img src="${prefix}at/${token}/x.png">`;

    const { html: rewritten, replaced } = injectAssetToken(
      html,
      PAGE_ID,
      token,
    );

    expect(replaced).toBe(0);
    expect(rewritten).toBe(html);
    expect(rewritten).not.toContain("/at/at/");
  });

  it("never touches other pages' f-URLs or share (/api/sc) URLs", () => {
    const html = [
      `<img src="/api/pp/archive/pages/other-page/f/x.png">`,
      `<a href="/api/sc/tok/f/index.html">share</a>`,
      `<img src="/api/sc/tok/f/at/${token}/y.png">`,
    ].join("\n");

    const { html: rewritten, replaced } = injectAssetToken(
      html,
      PAGE_ID,
      token,
    );

    expect(replaced).toBe(0);
    expect(rewritten).toBe(html);
  });

  it("leaves HTML without matching URLs byte-identical (replaced: 0)", () => {
    const html = `<p>relative refs only</p><img src="assets/logo.png"><a href="#top">top</a>`;
    const { html: rewritten, replaced } = injectAssetToken(
      html,
      PAGE_ID,
      token,
    );
    expect(replaced).toBe(0);
    expect(rewritten).toBe(html);
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
