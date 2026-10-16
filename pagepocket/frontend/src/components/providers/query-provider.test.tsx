import { describe, it, expect } from "vitest";
import { shouldRedirectOnAuthError } from "@/components/providers/query-provider";
import { AuthenticationError, NetworkError } from "@/lib/api/errors";

describe("shouldRedirectOnAuthError — global 401 handling", () => {
  it("redirects on AuthenticationError inside /app", () => {
    expect(shouldRedirectOnAuthError(new AuthenticationError(), "/app")).toBe(true);
    expect(shouldRedirectOnAuthError(new AuthenticationError(), "/app/pages/abc")).toBe(true);
    expect(shouldRedirectOnAuthError(new AuthenticationError(), "/app/search")).toBe(true);
  });

  it("never hijacks public share viewers or marketing pages", () => {
    const error = new AuthenticationError();
    expect(shouldRedirectOnAuthError(error, "/s/some-token")).toBe(false);
    expect(shouldRedirectOnAuthError(error, "/s")).toBe(false);
    expect(shouldRedirectOnAuthError(error, "/")).toBe(false);
    expect(shouldRedirectOnAuthError(error, "/pricing")).toBe(false);
    expect(shouldRedirectOnAuthError(error, "/login")).toBe(false);
  });

  it("ignores non-authentication errors", () => {
    expect(shouldRedirectOnAuthError(new Error("boom"), "/app")).toBe(false);
    expect(shouldRedirectOnAuthError(new NetworkError(), "/app")).toBe(false);
    expect(shouldRedirectOnAuthError(null, "/app")).toBe(false);
  });
});
