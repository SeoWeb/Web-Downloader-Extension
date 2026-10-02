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
});

export const ListPagesResponseSchema = z.object({
  pages: z.array(PageResponseSchema),
  total: z.number(),
  page: z.number().default(1),
  page_size: z.number().default(20),
});

export const PageContentResponseSchema = z.object({
  url: z.string(),
  expires_at: z.number(),
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
  highlights: z.array(z.object({ start: z.number(), end: z.number() })).optional().default([]),
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

export const ValidateShareResponseSchema = z.object({
  url: z.string(),
  expires_at: z.string().nullable(),
});

export const StatusResponseSchema = z.object({
  status: z.string(),
  version: z.string(),
});

export type User = z.infer<typeof UserSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type PageResponse = z.infer<typeof PageResponseSchema>;
export type ListPagesResponse = z.infer<typeof ListPagesResponseSchema>;
export type PageContentResponse = z.infer<typeof PageContentResponseSchema>;
export type CollectionResponse = z.infer<typeof CollectionResponseSchema>;
export type ListCollectionsResponse = z.infer<typeof ListCollectionsResponseSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type ShareLinkResponse = z.infer<typeof ShareLinkResponseSchema>;
export type ValidateShareResponse = z.infer<typeof ValidateShareResponseSchema>;
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
