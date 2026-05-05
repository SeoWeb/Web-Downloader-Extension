import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.string().url(),
  NEXT_PUBLIC_MARKETING_SITE_URL: z.string().url(),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECRET: z.string().min(1),
});

export const env = envSchema.parse({
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_MARKETING_SITE_URL: process.env.NEXT_PUBLIC_MARKETING_SITE_URL,
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
  COOKIE_SECRET: process.env.COOKIE_SECRET,
});
