import { cookies } from "next/headers";
import { serverFetch } from "./http";
import {
  CollectionResponseSchema,
  ListCollectionsResponseSchema,
} from "./schemas";

export const library = {
  async listCollections() {
    return serverFetch({
      route: "/library/collections",
      schema: ListCollectionsResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async createCollection(data: {
    name: string;
    color: string;
    parent_id?: string | null;
  }) {
    return serverFetch({
      route: "/library/collections",
      method: "POST",
      body: data,
      schema: CollectionResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async updateCollection(
    id: string,
    data: { name?: string; color?: string },
  ) {
    return serverFetch({
      route: `/library/collections/${id}`,
      method: "PATCH",
      body: data,
      schema: CollectionResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async deleteCollection(id: string) {
    return serverFetch({
      route: `/library/collections/${id}`,
      method: "DELETE",
      schema: CollectionResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async addPageToCollection(collectionId: string, pageId: string) {
    return serverFetch({
      route: `/library/collections/${collectionId}/pages`,
      method: "POST",
      body: { page_id: pageId },
      schema: CollectionResponseSchema,
      cookieStore: await cookies(),
    });
  },

  async removePageFromCollection(collectionId: string, pageId: string) {
    return serverFetch({
      route: `/library/collections/${collectionId}/pages/${pageId}`,
      method: "DELETE",
      schema: CollectionResponseSchema,
      cookieStore: await cookies(),
    });
  },
};
