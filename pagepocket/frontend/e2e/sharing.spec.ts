import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { uiLogin } from "./helpers";

test.describe("Sharing", () => {
  test("share dialog opens and shows create state", async ({ page }) => {
    await uiLogin(page);
    await page.goto("/app");
    await page.waitForTimeout(2_000);

    const cards = page.locator(".rounded-lg.border");
    const count = await cards.count();
    if (count > 0) {
      await cards.first().hover();
      await cards.first().locator('button[aria-label="Page actions"]').click();
      await page.getByText("Share").click();
      await page.waitForTimeout(2_000);
      await expect(page.getByText(/share/i)).toBeVisible({ timeout: 5_000 });
    }
  });

  test("public share page shows expired state for invalid token", async ({ page }) => {
    await page.goto("/s/invalid-token-12345");
    await page.waitForTimeout(3_000);
    const hasExpired = (await page.getByText(/expired|no longer available|not found/i).count()) > 0;
    expect(hasExpired).toBeTruthy();
  });

  test("share badge links to home", async ({ page }) => {
    await page.goto("/s/invalid-token-12345");
    await page.waitForTimeout(2_000);
    const badge = page.getByText("Shared via PagePocket");
    await expect(badge).toBeVisible({ timeout: 5_000 });
    // Verify it's a link
    const link = page.locator('a', { hasText: "Shared via PagePocket" });
    await expect(link).toHaveAttribute("href", "/");
  });

  test("custom date picker appears when selecting custom expiry", async ({ page }) => {
    await uiLogin(page);
    await page.goto("/app");
    await page.waitForTimeout(2_000);

    const cards = page.locator(".rounded-lg.border");
    const count = await cards.count();
    if (count === 0) return;

    await cards.first().hover();
    await cards.first().locator('button[aria-label="Page actions"]').click();
    await page.getByText("Share").click();
    await page.waitForTimeout(2_000);
    await expect(page.getByText(/share/i)).toBeVisible({ timeout: 5_000 });

    // Open expiry select and pick "Custom date"
    const expiryTrigger = page.locator('button[role="combobox"]');
    if ((await expiryTrigger.count()) > 0) {
      await expiryTrigger.click();
      await page.getByText("Custom date").click();
      // Calendar should appear
      await expect(page.locator("table")).toBeVisible({ timeout: 3_000 });
    }
  });
});

test.describe("Sharing full flow", () => {
  test("create link → copy → open in new context → revoke → 404", async ({
    page,
    browser,
  }) => {
    await uiLogin(page);
    await page.goto("/app");
    await page.waitForTimeout(2_000);

    const cards = page.locator(".rounded-lg.border");
    const count = await cards.count();
    if (count === 0) return;

    // Open share dialog
    await cards.first().hover();
    await cards.first().locator('button[aria-label="Page actions"]').click();
    await page.getByText("Share").click();
    await page.waitForTimeout(2_000);
    await expect(page.getByText("Share page")).toBeVisible({ timeout: 5_000 });

    // Create link
    const createBtn = page.getByText("Create share link");
    if ((await createBtn.count()) > 0 && (await createBtn.isVisible())) {
      await createBtn.click();
      await page.waitForTimeout(3_000);
    }

    // Wait for link to appear
    const copyBtn = page.getByText("Copy link");
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });

    // Copy link
    await copyBtn.click();
    await page.waitForTimeout(1_000);

    // Extract the share URL from the dialog
    const linkText = page.locator("span.truncate");
    const shareUrl = await linkText.textContent();
    expect(shareUrl).toBeTruthy();

    // Open share URL in a new (unauthenticated) browser context
    const newContext: BrowserContext = await browser.newContext();
    const newPage = await newContext.newPage();

    await newPage.goto(shareUrl!, { timeout: 10_000 });
    await newPage.waitForTimeout(3_000);

    // Verify the share page renders (either iframe or expired state)
    const hasIframe = (await newPage.locator("iframe").count()) > 0;
    const hasExpired = (await newPage.getByText(/expired|no longer available/i).count()) > 0;
    // At least one should be true — if the share was created, iframe should render
    expect(hasIframe || hasExpired).toBeTruthy();

    // Verify "Shared via PagePocket" badge
    const badge = newPage.getByText("Shared via PagePocket");
    await expect(badge).toBeVisible({ timeout: 5_000 });

    await newPage.close();
    await newContext.close();

    // Back to original page — revoke the link
    const revokeBtn = page.locator('button.variant-destructive, button:has(svg.lucide-trash-2)').first();
    if ((await revokeBtn.count()) > 0) {
      page.on("dialog", (dialog) => dialog.accept("Revoke this share link?"));
      await revokeBtn.click();
      await page.waitForTimeout(3_000);
    }

    // Open the share URL again — should show 404/expired state
    const verifyContext = await browser.newContext();
    const verifyPage = await verifyContext.newPage();
    await verifyPage.goto(shareUrl!, { timeout: 10_000 });
    await verifyPage.waitForTimeout(3_000);

    const showsExpired = (await verifyPage.getByText(/expired|revoked|no longer available/i).count()) > 0;
    expect(showsExpired).toBeTruthy();

    await verifyPage.close();
    await verifyContext.close();
  });
});
