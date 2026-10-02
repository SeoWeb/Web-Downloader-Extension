"use client";

import type { ZodType } from "zod";
import { ZodError } from "zod";
import {
  AuthenticationError,
  PermissionError,
  NotFoundError,
  ConflictError,
  QuotaExceededError,
  RateLimitError,
  ValidationError,
  ApiContractError,
  NetworkError,
} from "./api/errors";
import {
  ListPagesResponseSchema,
  PageContentResponseSchema,
  PageResponseSchema,
  ListCollectionsResponseSchema,
  CollectionResponseSchema,
  SearchResponseSchema,
  ShareLinkResponseSchema,
  SuccessResponseSchema,
} from "./api/schemas";

type ClientFetchOptions<T> = {
  route: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  schema: ZodType<T>;
};

async function clientFetch<T>({
  route,
  method = "GET",
  body,
  query,
  schema,
}: ClientFetchOptions<T>): Promise<T> {
  const url = new URL(`/api/pp${route}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const init: RequestInit = {
    method,
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), init);
  } catch {
    throw new NetworkError();
  }

  if (response.status === 401) {
    throw new AuthenticationError();
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    switch (response.status) {
      case 400:
        throw new ValidationError(
          (errorBody.fields ?? {}) as Record<string, string>,
        );
      case 402:
        throw new QuotaExceededError();
      case 403:
        throw new PermissionError();
      case 404:
        throw new NotFoundError();
      case 409:
        throw new ConflictError();
      case 429: {
        const retryAfter = Number(errorBody.retry_after ?? 60);
        throw new RateLimitError(retryAfter);
      }
      default:
        throw new Error(`API error ${response.status}`);
    }
  }

  const data = await response.json();
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new ApiContractError(route, e.message);
    }
    throw e;
  }
}

export const clientApi = {
  // Archive
  listPages: (params: {
    page?: number;
    page_size?: number;
    sort_by?: string;
    collection_id?: string;
  }) =>
    clientFetch({
      route: "/archive/pages",
      query: params,
      schema: ListPagesResponseSchema,
    }),

  viewPage: (pageId: string) =>
    clientFetch({
      route: `/archive/pages/${pageId}/view`,
      schema: PageContentResponseSchema,
    }),

  deletePage: (pageId: string) =>
    clientFetch({
      route: `/archive/pages/${pageId}`,
      method: "DELETE",
      schema: PageResponseSchema,
    }),

  // Library
  listCollections: () =>
    clientFetch({
      route: "/library/collections",
      schema: ListCollectionsResponseSchema,
    }),

  createCollection: (data: {
    name: string;
    color: string;
    parent_id?: string | null;
  }) =>
    clientFetch({
      route: "/library/collections",
      method: "POST",
      body: data,
      schema: CollectionResponseSchema,
    }),

  updateCollection: (
    id: string,
    data: { name?: string; color?: string },
  ) =>
    clientFetch({
      route: `/library/collections/${id}`,
      method: "PATCH",
      body: data,
      schema: CollectionResponseSchema,
    }),

  deleteCollection: (id: string) =>
    clientFetch({
      route: `/library/collections/${id}`,
      method: "DELETE",
      schema: CollectionResponseSchema,
    }),

  addPageToCollection: (collectionId: string, pageId: string) =>
    clientFetch({
      route: `/library/collections/${collectionId}/pages/${pageId}`,
      method: "POST",
      schema: SuccessResponseSchema,
    }),

  removePageFromCollection: (collectionId: string, pageId: string) =>
    clientFetch({
      route: `/library/collections/${collectionId}/pages/${pageId}`,
      method: "DELETE",
      schema: SuccessResponseSchema,
    }),

  // Search
  search: (params: {
    q: string;
    page?: number;
    page_size?: number;
    collection_id?: string;
  }) =>
    clientFetch({
      route: "/search",
      query: params,
      schema: SearchResponseSchema,
    }),

  // Share
  createLink: (data: {
    page_id: string;
    is_public: boolean;
    expires_at?: string | null;
  }) =>
    clientFetch({
      route: "/share",
      method: "POST",
      body: data,
      schema: ShareLinkResponseSchema,
    }),

  revokeLink: (token: string) =>
    clientFetch({
      route: `/share/${token}`,
      method: "DELETE",
      schema: SuccessResponseSchema,
    }),

  getLink: (pageId: string) =>
    clientFetch({
      route: "/share",
      query: { page_id: pageId },
      schema: ShareLinkResponseSchema,
    }).catch((e) => {
      if (e instanceof NotFoundError) return null;
      throw e;
    }),
};
