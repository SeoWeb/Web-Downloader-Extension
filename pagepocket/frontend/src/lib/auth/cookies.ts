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
  refresh: string;
  expiresAt: number;
};

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
    expires: new Date(tokens.expiresAt * 1000),
  });
  response.set("pp_refresh", tokens.refresh, {
    ...COOKIE_OPTS,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
  });
}

export function clearAuthCookies(response: CookieSetter) {
  response.set("pp_access", "", { ...COOKIE_OPTS, maxAge: 0 });
  response.set("pp_refresh", "", { ...COOKIE_OPTS, maxAge: 0 });
}
