import { env } from "@/lib/env";

type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  path?: string;
  domain?: string;
  expires?: Date;
  maxAge?: number;
};

type CookieSetter = {
  set: (name: string, value: string, opts: CookieOptions) => void;
};

type AuthTokenPayload = {
  access: string;
  /** Omitted/empty when the gateway did not rotate the refresh token. */
  refresh?: string;
};

// Cookie lifetime is transport only (design D10): the browser must not delete
// pp_access when the 1 h access-token value expires — the gateway enforces
// the value TTL on every use, and the /api/pp refresh primitive rotates it.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const COOKIE_OPTS: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  ...(env.COOKIE_DOMAIN && { domain: env.COOKIE_DOMAIN }),
};

export function setAuthCookies(response: CookieSetter, tokens: AuthTokenPayload) {
  response.set("pp_access", tokens.access, {
    ...COOKIE_OPTS,
    expires: new Date(Date.now() + THIRTY_DAYS_MS),
  });
  // Never write an empty pp_refresh cookie — an empty value would look like a
  // live refresh token to the proxy guard and the refresh primitive.
  if (tokens.refresh) {
    response.set("pp_refresh", tokens.refresh, {
      ...COOKIE_OPTS,
      expires: new Date(Date.now() + THIRTY_DAYS_MS),
    });
  }
}

export function clearAuthCookies(response: CookieSetter) {
  response.set("pp_access", "", { ...COOKIE_OPTS, maxAge: 0 });
  response.set("pp_refresh", "", { ...COOKIE_OPTS, maxAge: 0 });
}
