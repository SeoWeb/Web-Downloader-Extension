import { cookies } from "next/headers";
import { serverFetch } from "./http";
import {
  ListPagesResponseSchema,
  PageContentResponseSchema,
  PageResponseSchema,
} from "./schemas";
import type { PageResponse } from "./schemas";

export const archive = {
  async listPages(params: {
    page?: number;
    page_size?: number;
    sort_by?: string;
    collection_id?: string;
  }) {
    return serverFetch({
      route: "/archive/pages",
      query: params as Record<string, string | number | undefined>,
      schema: ListPagesResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async getPage(pageId: string): Promise<PageResponse | null> {
    const result = await serverFetch({
      route: "/archive/pages",
      query: { page_size: 50 },
      schema: ListPagesResponseSchema,
      cookieStore: await cookies(),
    });
    return result.pages.find((p) => p.id === pageId) ?? null;
  },

  async viewPage(pageId: string) {
    return serverFetch({
      route: `/archive/pages/${pageId}/view`,
      schema: PageContentResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async deletePage(pageId: string) {
    return serverFetch({
      route: `/archive/pages/${pageId}`,
      method: "DELETE",
      schema: PageResponseSchema,
      cookieStore: await cookies(),
    });
  },
};
