import { z } from "zod";

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  created_at: z.string(),
});

export const AuthResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),
  user: UserSchema,
});

export const PageResponseSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  url: z.string(),
  title: z.string(),
  archived_at: z.string(),
  preview_text: z.string().optional(),
  size_bytes: z.number().optional(),
  collection_id: z.string().nullable().optional(),
  thumbnail_key: z.string().nullable().optional(),
  /**
   * Stored content formats (text-native-downloads D1): `html` | `markdown` |
   * `text`, html first when present. Tolerant by contract — an older backend
   * omits the field entirely and unknown values are ignored by the viewer,
   * so a pre-change response still parses and renders as before.
   */
  content_formats: z.array(z.string()).default([]),
});

export const ListPagesResponseSchema = z.object({
  pages: z.array(PageResponseSchema),
  total: z.number(),
  page: z.number().default(1),
  page_size: z.number().default(20),
});

export const SuccessResponseSchema = z.object({ success: z.boolean() });

export const CollectionResponseSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  color: z.string(),
  parent_id: z.string().nullable(),
  page_count: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ListCollectionsResponseSchema = z.object({
  collections: z.array(CollectionResponseSchema),
});

export const SearchResultSchema = z.object({
  page_id: z.string(),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  highlights: z
    .array(z.object({ start: z.number(), end: z.number() }))
    .optional()
    .default([]),
  archived_at: z.string(),
});

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  total: z.number(),
});

export const ShareLinkResponseSchema = z.object({
  token: z.string(),
  short_url: z.string(),
  is_public: z.boolean(),
  expires_at: z.string().nullable(),
  view_count: z.number(),
  created_at: z.string(),
});

/**
 * Public share validation payload (design D4 — presigned URLs removed from
 * the REST contract). The validity signal is the gateway's status contract:
 * 404 for invalid/revoked/expired tokens (surfaced as a thrown error by
 * serverFetch). Whatever page-reference metadata the gateway returns, the
 * frontend must not require a URL field here.
 */
export const ValidateShareResponseSchema = z.object({
  valid: z.boolean().optional(),
  page_id: z.string().optional(),
  expires_at: z.string().nullable().optional(),
  /**
   * Same tolerant contract as PageResponseSchema.content_formats — the share
   * viewer derives its format switcher from it (viewer parity, D6) and falls
   * back to the bare HTML iframe when the field is absent.
   */
  content_formats: z.array(z.string()).default([]),
});

export const StatusResponseSchema = z.object({
  status: z.string(),
  version: z.string(),
});

export const StorageUsageSchema = z.object({
  used_bytes: z.number(),
  storage_limit_bytes: z.number(),
  plan: z.string(),
  pages_this_month: z.number(),
  page_limit_monthly: z.number(),
  quota_reset_at: z.string().nullable(),
});

export type User = z.infer<typeof UserSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type PageResponse = z.infer<typeof PageResponseSchema>;
export type ListPagesResponse = z.infer<typeof ListPagesResponseSchema>;
export type CollectionResponse = z.infer<typeof CollectionResponseSchema>;
export type ListCollectionsResponse = z.infer<
  typeof ListCollectionsResponseSchema
>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type ShareLinkResponse = z.infer<typeof ShareLinkResponseSchema>;
export type ValidateShareResponse = z.infer<typeof ValidateShareResponseSchema>;
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
export type StorageUsage = z.infer<typeof StorageUsageSchema>;
