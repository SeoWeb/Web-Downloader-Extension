import { test, expect } from "@playwright/test";
import { uiLogin } from "./helpers";

test.beforeEach(async ({ page }) => {
  await uiLogin(page);
});

test.describe("Collections", () => {
  test("create a new collection via sidebar dialog", async ({ page }) => {
    await page.goto("/app");
    await page.waitForTimeout(2_000);

    await page.click('aside button[aria-label="New collection"]');
    await page.fill(
      'input[placeholder="Collection name"]',
      "E2E Created Col",
    );
    await page.click('button:has-text("Create")');
    await expect(page.getByText("E2E Created Col")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("clicking a collection navigates to its filtered page", async ({
    request,
    page,
  }) => {
    const res = await request.post("/api/pp/library/collections", {
      data: { name: "Nav Test Col", color: "#3b82f6" },
    });
    const col = await res.json();

    await page.goto("/app");
    await page.waitForTimeout(2_000);

    await page.click(`aside button:has-text("Nav Test Col")`);
    await expect(page).toHaveURL(
      new RegExp(`/app/collections/${col.id}`),
      { timeout: 5_000 },
    );
    await expect(
      page.getByRole("heading", { name: "Nav Test Col" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("create sub-collection via context menu", async ({
    request,
    page,
  }) => {
    await request.post("/api/pp/library/collections", {
      data: { name: "Parent Col", color: "#ef4444" },
    });

    await page.goto("/app");
    await page.waitForTimeout(2_000);

    await page.click(`aside button:has-text("Parent Col")`, {
      button: "right",
    });
    await page.click('text=Add sub-collection');
    await page.fill(
      'input[placeholder="Collection name"]',
      "Child Col",
    );
    await page.click('button:has-text("Create")');
    await expect(page.getByText("Child Col")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("context menu shows all items", async ({ request, page }) => {
    await request.post("/api/pp/library/collections", {
      data: { name: "Ctx Menu Col", color: "#06b6d4" },
    });

    await page.goto("/app");
    await page.waitForTimeout(2_000);

    await page.click(`aside button:has-text("Ctx Menu Col")`, {
      button: "right",
    });
    await expect(page.getByText("Rename")).toBeVisible();
    await expect(page.getByText("Recolour")).toBeVisible();
    await expect(page.getByText("Add sub-collection")).toBeVisible();
    await expect(page.getByText("Delete")).toBeVisible();
  });

  test("delete collection via confirmation dialog", async ({
    request,
    page,
  }) => {
    const parentRes = await request.post("/api/pp/library/collections", {
      data: { name: "Delete Parent Col", color: "#f59e0b" },
    });
    const parent = await parentRes.json();
    await request.post("/api/pp/library/collections", {
      data: {
        name: "Orphan Child Col",
        color: "#8b5cf6",
        parent_id: parent.id,
      },
    });

    await page.goto("/app");
    await page.waitForTimeout(2_000);

    await page.click(`aside button:has-text("Delete Parent Col")`, {
      button: "right",
    });
    await page.click('text=Delete');

    // Confirm via Dialog (not browser confirm)
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(
      dialog.getByText("Pages will not be deleted"),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("Delete Parent Col")).not.toBeVisible({
      timeout: 5_000,
    });
  });

  test("drag page into collection", async ({ request, page }) => {
    const colRes = await request.post("/api/pp/library/collections", {
      data: { name: "Drop Target Col", color: "#22c55e" },
    });
    await colRes.json();

    await page.goto("/app");
    await page.waitForTimeout(2_000);

    const pageCards = page.locator(".rounded-lg.border");
    const count = await pageCards.count();
    if (count > 0) {
      const collectionNode = page.locator(
        `aside button:has-text("Drop Target Col")`,
      );
      await pageCards.first().dragTo(collectionNode);
      await page.waitForTimeout(2_000);
    }
  });
});
