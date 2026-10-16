import { cookies } from "next/headers";
import { serverFetch } from "./http";
import {
  ListPagesResponseSchema,
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
    // By-id metadata fetch (page-viewer spec): never scan a page-size-limited
    // list — pages beyond the newest slice stay viewable. The gateway maps
    // this route to ArchiveService.GetPage (NOT_FOUND for missing/cross-user
    // ids), which the viewer renders as its "Page not found" state.
    return serverFetch({
      route: `/archive/pages/${pageId}`,
      schema: PageResponseSchema,
      cookieStore: await cookies(),
    }).catch(() => null);
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
