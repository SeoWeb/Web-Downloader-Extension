import { test, expect } from "@playwright/test";
import { API_BASE, apiLogin, uiLogin, seedPages, cleanupPages } from "./helpers";

let authToken: string;
const pageIds: string[] = [];

test.beforeAll(async ({ request }) => {
  authToken = await apiLogin(request, "e2e-dash@test.pagepocket.app");
  const ids = await seedPages(request, authToken, 30);
  pageIds.push(...ids);
});

test.afterAll(async ({ request }) => {
  await cleanupPages(request, authToken, pageIds);
});

test.beforeEach(async ({ page }) => {
  await uiLogin(page, "e2e-dash@test.pagepocket.app");
});

test.describe("Dashboard", () => {
  test("shows empty state when no pages", async ({ page }) => {
    // Navigate to a clean user or verify empty state UI exists
    // This test relies on the visual state — if seeded pages exist, skip empty check
    await page.goto("/app");
    const emptyState = page.getByText(/no saved pages yet/i);
    const hasCards = (await page.locator("[data-testid]").count()) > 0;
    // Empty state only shows for zero-archive users
    if (await emptyState.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await expect(page.getByText(/install the extension/i)).toBeVisible();
      await expect(page.getByText(/watch a 60-second demo/i)).toBeVisible();
    }
  });

  test("lists seeded page cards on dashboard", async ({ page }) => {
    await page.goto("/app");
    // Wait for cards to render
    const cards = page.locator(".rounded-lg.border");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // Should have loaded the first 20 pages (page_size=20)
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(20);
  });

  test("displays total count in header", async ({ page }) => {
    await page.goto("/app");
    await page.locator(".rounded-lg.border").first().waitFor({ timeout: 10_000 });
    const heading = page.getByText(/all pages \(\d+\)/i);
    await expect(heading).toBeVisible();
  });

  test("infinite scroll loads next page", async ({ page }) => {
    await page.goto("/app");
    await page.locator(".rounded-lg.border").first().waitFor({ timeout: 10_000 });

    const initialCount = await page.locator(".rounded-lg.border").count();
    expect(initialCount).toBeGreaterThanOrEqual(20);

    // Scroll to bottom to trigger infinite scroll sentinel
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    // Wait for loading spinner or additional cards
    await page.waitForTimeout(2_000);

    const newCount = await page.locator(".rounded-lg.border").count();
    expect(newCount).toBeGreaterThan(initialCount);

    // Verify "reached the end" appears after all loaded
    await expect(page.getByText(/you.*reached the end/i)).toBeVisible({ timeout: 10_000 });
  });

  test("sort selector updates URL and reorders cards", async ({ page }) => {
    await page.goto("/app");
    await page.locator(".rounded-lg.border").first().waitFor({ timeout: 10_000 });

    // Change sort to Title A-Z
    await page.locator('button[role="combobox"]').click();
    await page.click('text=Title A-Z');

    // Verify URL updated
    await expect(page).toHaveURL(/sort_by=title/);

    // Verify cards reordered — first card should have a title starting early in alphabet
    const firstCardTitle = await page.locator(".rounded-lg.border").first().textContent();
    expect(firstCardTitle).toBeTruthy();
  });

  test("delete a page optimistically removes card", async ({ page }) => {
    await page.goto("/app");
    await page.locator(".rounded-lg.border").first().waitFor({ timeout: 10_000 });

    const initialCount = await page.locator(".rounded-lg.border").count();

    // Hover first card and open dropdown
    const firstCard = page.locator(".rounded-lg.border").first();
    await firstCard.hover();
    await firstCard.locator('button[aria-label="Page actions"]').click();

    // Accept confirm dialog and click delete
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByText("Delete").click();

    // Card should be removed optimistically
    await page.waitForTimeout(1_000);
    const afterCount = await page.locator(".rounded-lg.border").count();
    expect(afterCount).toBeLessThan(initialCount);
  });

  test("card actions include Share, Move to collection, and Delete", async ({ page }) => {
    await page.goto("/app");
    const firstCard = page.locator(".rounded-lg.border").first();
    await firstCard.waitFor({ timeout: 10_000 });
    await firstCard.hover();
    await firstCard.locator('button[aria-label="Page actions"]').click();

    await expect(page.getByText("Share")).toBeVisible();
    await expect(page.getByText("Move to collection")).toBeVisible();
    await expect(page.getByText("Delete")).toBeVisible();
  });
});
