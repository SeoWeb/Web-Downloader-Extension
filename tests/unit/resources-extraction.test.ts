/**
 * Unit tests for resource extraction (OpenSpec tasks 3.4, 3.5, 3.6).
 *
 * Covers:
 * - favicon extraction: rel="icon", "shortcut icon", "apple-touch-icon"
 * - @import rules in <style> tags join the CSS download list
 * - scheme filtering: blob:, data:, chrome-extension:, fragment-only URLs
 *   are never returned as fetchable resources (incl. CSS url(#fragment))
 * - srcset parsing respects percent-encoded commas (%2C)
 * - CSS url() extraction keeps quoted URLs containing parentheses intact
 */

import { describe, it, expect } from "vitest";
import { getResources } from "../../src/background/resources";

// ---------------------------------------------------------------------------
// Favicons (task 3.5)
// ---------------------------------------------------------------------------

describe("getResources — favicon extraction (task 3.5)", () => {
  it("extracts rel=icon, rel=shortcut icon and rel=apple-touch-icon hrefs", () => {
    const html = `
      <html><head>
        <link rel="icon" href="/favicon.ico">
        <link rel="shortcut icon" href="/static/favicon.png">
        <link rel="apple-touch-icon" href="/touch-icon.png">
        <link rel="apple-touch-icon-precomposed" href="/touch-pre.png">
        <link rel="stylesheet" href="/style.css">
        <link rel="preconnect" href="https://cdn.example.org">
      </head><body></body></html>
    `;
    const result = getResources(html);
    expect(result.images).toContain("/favicon.ico");
    expect(result.images).toContain("/static/favicon.png");
    expect(result.images).toContain("/touch-icon.png");
    expect(result.images).toContain("/touch-pre.png");
    // Non-icon link rels are not images.
    expect(result.images).not.toContain("https://cdn.example.org");
    expect(result.css).toContain("/style.css");
  });

  it("matches rel tokens case-insensitively and skips data:/fragment favicons", () => {
    const html = `
      <link REL="ICON" href="/favicon.ico">
      <link rel="icon" href="data:image/png;base64,AAA">
      <link rel="icon" href="#blank">
    `;
    const result = getResources(html);
    expect(result.images).toEqual(["/favicon.ico"]);
  });
});

// ---------------------------------------------------------------------------
// @import in style tags (task 3.4)
// ---------------------------------------------------------------------------

describe("getResources — @import extraction (task 3.4)", () => {
  it("adds @import url(...) targets from style tags to the CSS list", () => {
    const html = `<style>@import url("theme.css");</style>`;
    const result = getResources(html);
    expect(result.css).toContain("theme.css");
  });

  it("adds @import string-form targets, including with media queries", () => {
    const html = `<style>@import 'print.css' print; @import "reset.css";</style>`;
    const result = getResources(html);
    expect(result.css).toContain("print.css");
    expect(result.css).toContain("reset.css");
  });

  it("does not leak url() references from @import into the images list", () => {
    const html = `<style>@import url("theme.css");</style>`;
    const result = getResources(html);
    // theme.css belongs to css, not images.
    expect(result.css).toContain("theme.css");
    expect(result.images).not.toContain("theme.css");
  });

  it("keeps stylesheet links and imports together, deduplicated", () => {
    const html = `
      <link rel="stylesheet" href="/a.css">
      <style>@import url("/b.css");@import url("/a.css");</style>
    `;
    const result = getResources(html);
    expect(result.css).toEqual(["/a.css", "/b.css"]);
  });
});

// ---------------------------------------------------------------------------
// Scheme filtering (task 3.6)
// ---------------------------------------------------------------------------

describe("getResources — scheme filtering (task 3.6)", () => {
  it("does not return blob: image URLs", () => {
    const html = `
      <img src="blob:https://host/uuid">
      <img src="/real.png">
    `;
    const result = getResources(html);
    expect(result.images).toEqual(["/real.png"]);
  });

  it("does not return data: image URLs", () => {
    const html = `<img src="data:image/gif;base64,R0lGOD">`;
    const result = getResources(html);
    expect(result.images).toEqual([]);
  });

  it("does not return chrome-extension: URLs in any list", () => {
    const html = `
      <img src="chrome-extension://abcdef/icon.png">
      <script src="chrome-extension://abcdef/lib.js"></script>
      <link rel="stylesheet" href="chrome-extension://abcdef/skin.css">
    `;
    const result = getResources(html);
    expect(result.images).toEqual([]);
    expect(result.js).toEqual([]);
    expect(result.css).toEqual([]);
  });

  it("never treats CSS url(#fragment) as a fetchable image", () => {
    const html = `
      <style>
        .gradient { background: url(#gradient); }
        .real { background: url("/bg.png"); }
      </style>
    `;
    const result = getResources(html);
    expect(result.images).toEqual(["/bg.png"]);
  });

  it("does not return fragment-only or javascript: hrefs as links", () => {
    const html = `
      <a href="#section">jump</a>
      <a href="javascript:void(0)">do</a>
      <a href="/page2.html">next</a>
    `;
    const result = getResources(html);
    expect(result.links).toEqual(["/page2.html"]);
  });

  it("does not return blob: document links", () => {
    const html = `
      <a href="blob:https://host/report.pdf">download</a>
      <a href="/docs/report.pdf">download</a>
    `;
    const result = getResources(html);
    expect(result.documents).toEqual(["/docs/report.pdf"]);
  });
});

// ---------------------------------------------------------------------------
// srcset parsing with encoded commas (task 3.6)
// ---------------------------------------------------------------------------

describe("getResources — srcset parsing", () => {
  it("respects percent-encoded commas inside srcset URLs", () => {
    const html = `<img srcset="a%2Cb.jpg 320w, b.jpg 640w, c.jpg 2x">`;
    const result = getResources(html);
    expect(result.images).toContain("a%2Cb.jpg");
    expect(result.images).toContain("b.jpg");
    expect(result.images).toContain("c.jpg");
  });

  it("still splits plain comma-separated srcset entries", () => {
    const html = `<img srcset="small.jpg 320w, large.jpg 1280w">`;
    const result = getResources(html);
    expect(result.images).toEqual(["small.jpg", "large.jpg"]);
  });

  it("filters blob:/data: URLs inside srcset", () => {
    const html = `<img srcset="blob:https://host/u 320w, ok.jpg 640w">`;
    const result = getResources(html);
    expect(result.images).toEqual(["ok.jpg"]);
  });

  it("handles encoded commas in data-srcset lazy attributes", () => {
    const html = `<img data-srcset="lazy%2Cname.webp 800w, other.webp 1200w">`;
    const result = getResources(html);
    expect(result.images).toContain("lazy%2Cname.webp");
  });
});

// ---------------------------------------------------------------------------
// CSS url() robustness
// ---------------------------------------------------------------------------

describe("getResources — CSS url() extraction", () => {
  it("keeps quoted URLs containing parentheses intact", () => {
    const html = `
      <style>
        .a { background-image: url("foo(bar).png"); }
        .b { background: url('a)b.png'); }
        .c { background: url(plain.png); }
      </style>
    `;
    const result = getResources(html);
    expect(result.images).toContain("foo(bar).png");
    expect(result.images).toContain("a)b.png");
    expect(result.images).toContain("plain.png");
  });

  it("does not treat @import url(...) targets as background images", () => {
    const html = `<style>@import url("theme.css");</style>`;
    const result = getResources(html);
    expect(result.images).toEqual([]);
  });
});
