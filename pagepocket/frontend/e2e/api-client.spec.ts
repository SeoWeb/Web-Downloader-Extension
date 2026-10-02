import { test, expect } from "@playwright/test";

test.describe("API proxy routes — authenticated", () => {
  test.beforeEach(async ({ request }) => {
    const res = await request.post("/api/session", {
      data: { email: "e2e@test.pagepocket.app", password: "TestPass123!" },
    });
    expect(res.ok()).toBeTruthy();
  });

  // Archive namespace
  test("archive: list pages returns paginated structure", async ({ request }) => {
    const res = await request.get("/api/pp/archive/pages");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty("pages");
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("page");
    expect(data).toHaveProperty("page_size");
    expect(Array.isArray(data.pages)).toBeTruthy();
  });

  test("archive: list pages with pagination and sort params", async ({ request }) => {
    const res = await request.get(
      "/api/pp/archive/pages?page=1&page_size=5&sort_by=archived_at",
    );
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty("pages");
    expect(data.page).toBe(1);
  });

  // Library namespace
  test("library: list collections returns array", async ({ request }) => {
    const res = await request.get("/api/pp/library/collections");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty("collections");
    expect(Array.isArray(data.collections)).toBeTruthy();
  });

  test("library: create, update, and delete collection", async ({ request }) => {
    const createRes = await request.post("/api/pp/library/collections", {
      data: { name: "E2E Test Collection", color: "#ff0000" },
    });
    expect(createRes.ok()).toBeTruthy();
    const collection = await createRes.json();
    expect(collection).toHaveProperty("id");
    expect(collection.name).toBe("E2E Test Collection");
    expect(collection.color).toBe("#ff0000");

    const updateRes = await request.patch(
      `/api/pp/library/collections/${collection.id}`,
      { data: { name: "Renamed Collection" } },
    );
    expect(updateRes.ok()).toBeTruthy();
    const updated = await updateRes.json();
    expect(updated.name).toBe("Renamed Collection");

    const deleteRes = await request.delete(
      `/api/pp/library/collections/${collection.id}`,
    );
    expect(deleteRes.ok()).toBeTruthy();
  });

  test("library: add page to collection and remove it", async ({ request }) => {
    const colRes = await request.post("/api/pp/library/collections", {
      data: { name: "Move Target", color: "#00ff00" },
    });
    const collection = await colRes.json();

    const pagesRes = await request.get("/api/pp/archive/pages");
    const pagesData = await pagesRes.json();

    if (pagesData.pages.length > 0) {
      const pageId = pagesData.pages[0].id;

      const addRes = await request.post(
        `/api/pp/library/collections/${collection.id}/pages`,
        { data: { page_id: pageId } },
      );
      expect(addRes.ok()).toBeTruthy();

      const removeRes = await request.delete(
        `/api/pp/library/collections/${collection.id}/pages/${pageId}`,
      );
      expect(removeRes.ok()).toBeTruthy();
    }

    await request.delete(`/api/pp/library/collections/${collection.id}`);
  });

  // Search namespace
  test("search: returns results structure", async ({ request }) => {
    const res = await request.get("/api/pp/search?q=test");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty("results");
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("page");
    expect(Array.isArray(data.results)).toBeTruthy();
  });

  test("search: empty query returns valid response", async ({ request }) => {
    const res = await request.get("/api/pp/search?q=");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty("results");
  });

  // Share namespace
  test("share: create, get, and revoke link", async ({ request }) => {
    const pagesRes = await request.get("/api/pp/archive/pages");
    const pagesData = await pagesRes.json();

    if (pagesData.pages.length === 0) {
      test.skip();
      return;
    }

    const pageId = pagesData.pages[0].id;

    const createRes = await request.post("/api/pp/share", {
      data: { page_id: pageId, is_public: true },
    });
    expect(createRes.ok()).toBeTruthy();
    const link = await createRes.json();
    expect(link).toHaveProperty("token");
    expect(link).toHaveProperty("is_public");
    expect(typeof link.token).toBe("string");

    const getRes = await request.get(
      `/api/pp/share?page_id=${pageId}`,
    );
    expect(getRes.ok()).toBeTruthy();
    const fetchedLink = await getRes.json();
    expect(fetchedLink.token).toBe(link.token);

    const revokeRes = await request.delete(`/api/pp/share/${link.token}`);
    expect(revokeRes.ok()).toBeTruthy();
  });

  // Error paths
  test("error: 404 for nonexistent page view", async ({ request }) => {
    const res = await request.get(
      "/api/pp/archive/pages/00000000-0000-0000-0000-000000000000/view",
    );
    expect(res.status()).toBe(404);
  });

  test("error: 404 for nonexistent collection", async ({ request }) => {
    const res = await request.delete(
      "/api/pp/library/collections/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status()).toBe(404);
  });

  test("error: 400 for invalid collection create", async ({ request }) => {
    const res = await request.post("/api/pp/library/collections", {
      data: {},
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("API proxy routes — unauthenticated", () => {
  test("unauthenticated request returns 401", async ({ request }) => {
    const res = await request.get("/api/pp/archive/pages");
    expect(res.status()).toBe(401);
  });

  test("unauthenticated mutation returns 401", async ({ request }) => {
    const res = await request.post("/api/pp/library/collections", {
      data: { name: "Should Fail", color: "#000" },
    });
    expect(res.status()).toBe(401);
  });
});
