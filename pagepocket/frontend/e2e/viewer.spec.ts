import { test, expect } from "@playwright/test";
import { uiLogin } from "./helpers";

test.beforeEach(async ({ page }) => {
  await uiLogin(page);
});

test.describe("Page Viewer", () => {
  test("renders iframe for a saved page with correct sandbox", async ({
    page,
  }) => {
    await page.goto("/app");
    await page.waitForSelector('a[href^="/app/pages/"]', { timeout: 10_000 });

    const pageLinks = page.locator('a[href^="/app/pages/"]');
    const count = await pageLinks.count();
    test.skip(count === 0, "No saved pages available to test viewer");

    await pageLinks.first().click();
    await page.waitForSelector("iframe[title='Saved page content']", {
      timeout: 10_000,
    });

    const iframe = page.locator("iframe[title='Saved page content']");
    await expect(iframe).toBeVisible();

    // Assert sandbox attribute matches security policy exactly
    await expect(iframe).toHaveAttribute(
      "sandbox",
      "allow-same-origin allow-popups allow-forms",
    );

    // Verify forbidden tokens are absent
    const sandbox = (await iframe.getAttribute("sandbox")) ?? "";
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-scripts-same-origin");
    expect(sandbox).not.toContain("allowfullscreen");

    // Verify no allowfullscreen attribute
    await expect(iframe).not.toHaveAttribute("allowfullscreen", /.*/);
  });

  test("Escape returns to dashboard", async ({ page }) => {
    await page.goto("/app");
    await page.waitForSelector('a[href^="/app/pages/"]', { timeout: 10_000 });

    const pageLinks = page.locator('a[href^="/app/pages/"]');
    const count = await pageLinks.count();
    test.skip(count === 0, "No saved pages available to test viewer");

    await pageLinks.first().click();
    await page.waitForSelector("iframe[title='Saved page content']", {
      timeout: 10_000,
    });

    // Verify we're on a viewer page
    await expect(page).toHaveURL(/\/app\/pages\//);

    // Press Escape to go back
    await page.keyboard.press("Escape");

    // Should navigate back to /app
    await expect(page).toHaveURL(/\/app$/, { timeout: 5_000 });
  });

  test("header shows back, share, and delete buttons", async ({ page }) => {
    await page.goto("/app");
    await page.waitForSelector('a[href^="/app/pages/"]', { timeout: 10_000 });

    const pageLinks = page.locator('a[href^="/app/pages/"]');
    const count = await pageLinks.count();
    test.skip(count === 0, "No saved pages available to test viewer");

    await pageLinks.first().click();
    await page.waitForSelector("iframe[title='Saved page content']", {
      timeout: 10_000,
    });

    await expect(page.locator('button[aria-label="Back to library"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Share"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Delete"]')).toBeVisible();
  });
});
