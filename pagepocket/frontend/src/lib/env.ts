import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.string().url(),
  NEXT_PUBLIC_MARKETING_SITE_URL: z.string().url(),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECRET: z.string().min(1),
  API_GATEWAY_URL: z.string().url().optional(),
});

export const env = envSchema.parse({
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_MARKETING_SITE_URL: process.env.NEXT_PUBLIC_MARKETING_SITE_URL,
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
  COOKIE_SECRET: process.env.COOKIE_SECRET,
  API_GATEWAY_URL: process.env.API_GATEWAY_URL,
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
