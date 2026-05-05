import { describe, it, expect } from "vitest";
import { validateRedirect } from "@/lib/auth/redirect";

describe("validateRedirect", () => {
  it("returns /app for null", () => {
    expect(validateRedirect(null)).toBe("/app");
  });

  it("returns /app for empty string", () => {
    expect(validateRedirect("")).toBe("/app");
  });

  it("accepts valid same-origin paths", () => {
    expect(validateRedirect("/app")).toBe("/app");
    expect(validateRedirect("/app/pages/123")).toBe("/app/pages/123");
    expect(validateRedirect("/search?q=test")).toBe("/search?q=test");
  });

  it("rejects protocol-relative URLs", () => {
    expect(validateRedirect("//evil.com")).toBe("/app");
  });

  it("rejects absolute URLs", () => {
    expect(validateRedirect("https://evil.com")).toBe("/app");
    expect(validateRedirect("http://evil.com")).toBe("/app");
  });

  it("rejects non-leading-slash paths", () => {
    expect(validateRedirect("app/pages")).toBe("/app");
  });
});
