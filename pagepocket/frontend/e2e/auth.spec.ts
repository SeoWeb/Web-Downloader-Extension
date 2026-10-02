import { test, expect } from "@playwright/test";

test.describe("Login", () => {
  test("successful login redirects to /app", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[id="email"]', "e2e@test.pagepocket.app");
    await page.fill('input[id="password"]', "TestPass123!");
    await page.click('button[type="submit"]');

    await page.waitForURL("**/app", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/app$/);
  });

  test("invalid credentials shows error", async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[id="email"]', "e2e@test.pagepocket.app");
    await page.fill('input[id="password"]', "WrongPassword!");
    await page.click('button[type="submit"]');

    await expect(page.getByText(/invalid/i)).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Register", () => {
  test("successful register redirects to /app/onboarding", async ({ page }) => {
    const email = `e2e-${Date.now()}@test.pagepocket.app`;
    await page.goto("/register");
    await page.fill('input[id="name"]', "E2E User");
    await page.fill('input[id="email"]', email);
    await page.fill('input[id="password"]', "NewPass123!");
    await page.fill('input[id="confirmPassword"]', "NewPass123!");
    await page.click('button[type="submit"]');

    await page.waitForURL("**/app/onboarding", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/app\/onboarding$/);
  });
});

test.describe("Logout", () => {
  test("logout redirects to /login", async ({ page }) => {
    // Login first
    await page.goto("/login");
    await page.fill('input[id="email"]', "e2e@test.pagepocket.app");
    await page.fill('input[id="password"]', "TestPass123!");
    await page.click('button[type="submit"]');
    await page.waitForURL("**/app", { timeout: 10_000 });

    // Logout via session API
    const res = await page.request.delete("/api/session");
    expect(res.status()).toBe(200);

    // Should redirect to login on next navigation
    await page.goto("/app");
    await page.waitForURL("**/login**", { timeout: 10_000 });
  });
});
