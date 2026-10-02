import { cookies } from "next/headers";
import { serverFetch } from "./http";
import {
  ShareLinkResponseSchema,
  ValidateShareResponseSchema,
} from "./schemas";

export const share = {
  async createLink(data: {
    page_id: string;
    is_public: boolean;
    expires_at?: string | null;
  }) {
    return serverFetch({
      route: "/share",
      method: "POST",
      body: data,
      schema: ShareLinkResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async revokeLink(token: string) {
    return serverFetch({
      route: `/share/${token}`,
      method: "DELETE",
      schema: ShareLinkResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async getLink(pageId: string) {
    return serverFetch({
      route: "/share",
      query: { page_id: pageId },
      schema: ShareLinkResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async validatePublic(token: string) {
    return serverFetch({
      route: `/share/public/${token}`,
      schema: ValidateShareResponseSchema,
      cookieStore: await cookies(),
      token: "",
    });
  },
};
