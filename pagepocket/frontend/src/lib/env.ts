import "server-only";
import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.string().url(),
  NEXT_PUBLIC_MARKETING_SITE_URL: z.string().url(),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECRET: z.string().min(1),
  API_GATEWAY_URL: z.string().url().optional(),
  // Signed asset tokens (fix E, archived-html-serving "Credential-less
  // archived asset access"): dedicated HMAC secret — NEVER reuse JWT_SECRET.
  // Unset/empty disables the feature (HTML is served untouched).
  ASSET_TOKEN_SECRET: z.string().min(1).optional(),
  ASSET_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  // Cloudflare Web Analytics beacon token (design D5, privacy-friendly
  // analytics). OPTIONAL: unset or empty disables the beacon entirely —
  // the (marketing) layout renders no analytics script at all (zero
  // requests, zero bytes). Cookieless, so no consent banner is needed.
  NEXT_PUBLIC_CF_BEACON_TOKEN: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
});

export const env = envSchema.parse({
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_MARKETING_SITE_URL: process.env.NEXT_PUBLIC_MARKETING_SITE_URL,
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
  COOKIE_SECRET: process.env.COOKIE_SECRET,
  API_GATEWAY_URL: process.env.API_GATEWAY_URL,
  ASSET_TOKEN_SECRET: process.env.ASSET_TOKEN_SECRET,
  ASSET_TOKEN_TTL_SECONDS: process.env.ASSET_TOKEN_TTL_SECONDS,
  NEXT_PUBLIC_CF_BEACON_TOKEN: process.env.NEXT_PUBLIC_CF_BEACON_TOKEN,
});

/**
 * Server-side address of the API gateway. This must point at the gateway
 * service itself (e.g. http://api-gateway:8090/api/v1), NOT the public web
 * app host. Falls back to NEXT_PUBLIC_API_BASE_URL, then to a local gateway.
 */
export const API_GATEWAY_URL =
  process.env.API_GATEWAY_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:8090/api/v1";

/**
 * Default signed-asset-token lifetime bucket: 7 days. A token minted inside
 * the current bucket stays valid through the end of the NEXT bucket, so
 * browser-cached asset URLs keep working across a bucket flip.
 */
export const DEFAULT_ASSET_TOKEN_TTL_SECONDS = 604800;

/**
 * Cloudflare Web Analytics beacon token (design D5), or `null` when unset
 * or empty: the (marketing) layout then renders NO beacon at all, so
 * analytics is purely opt-in via the environment. Prerendered marketing
 * pages bake this at BUILD time — set it in the frontend env on the host
 * before `pnpm build` (see openspec/changes/professional-marketing-site/
 * handoff.md, §1).
 */
export const CF_BEACON_TOKEN = env.NEXT_PUBLIC_CF_BEACON_TOKEN ?? null;

/**
 * Signed-asset-token feature config (fix E), resolved PER REQUEST — not from
 * the import-time `env` object — so the feature can be toggled by the
 * environment without a module reload (and tests can flip it). Returns null
 * when the secret is unset/empty: the feature is OFF and archived HTML is
 * served exactly as upstream (graceful — never breaks serving).
 */
export function assetTokenConfig(): {
  secret: string;
  ttlSeconds: number;
} | null {
  const secret = process.env.ASSET_TOKEN_SECRET?.trim() ?? "";
  if (!secret) return null;
  const parsed = Number.parseInt(process.env.ASSET_TOKEN_TTL_SECONDS ?? "", 10);
  return {
    secret,
    ttlSeconds:
      Number.isSafeInteger(parsed) && parsed > 0
        ? parsed
        : DEFAULT_ASSET_TOKEN_TTL_SECONDS,
  };
}
