import { cookies } from "next/headers";
import { serverFetch } from "./http";
import { SearchResponseSchema } from "./schemas";

export const search = {
  async search(params: {
    q: string;
    page?: number;
    page_size?: number;
    collection_id?: string;
  }) {
    return serverFetch({
      route: "/search",
      query: params as Record<string, string | number | undefined>,
      schema: SearchResponseSchema,
      cookieStore: await cookies(),
    });
  },
};
