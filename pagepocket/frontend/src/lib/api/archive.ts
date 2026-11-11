import { cookies } from "next/headers";
import { serverFetch } from "./http";
import { NotFoundError } from "./errors";
import { ListPagesResponseSchema, PageResponseSchema } from "./schemas";
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
    // this route to ArchiveService.GetPage. Failure split (multipage 8.4):
    // a true 404 (missing or cross-user id) resolves null — the viewer route
    // renders its "Page not found" state — while EVERY other failure
    // (network error, gateway error, 5xx, contract drift) rethrows so the
    // route renders a retryable error state instead of a dead-end 404.
    return serverFetch({
      route: `/archive/pages/${pageId}`,
      schema: PageResponseSchema,
      cookieStore: await cookies(),
    }).catch((error: unknown) => {
      if (error instanceof NotFoundError) return null;
      throw error;
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
