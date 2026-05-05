import type { Page, APIRequestContext } from "@playwright/test";

export const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:8080/api/v1";

/** Register + login a user via the gateway API, returning the access token. */
export async function apiLogin(
  request: APIRequestContext,
  email = "e2e@test.pagepocket.app",
  password = "TestPass123!",
): Promise<string> {
  await request.post(`${API_BASE}/auth/register`, {
    data: { email, password },
    failOnStatusCode: false,
  });
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { email, password },
  });
  const body = await res.json();
  return body.access_token as string;
}

/** Log in via the UI and wait for redirect to /app. */
export async function uiLogin(
  page: Page,
  email = "e2e@test.pagepocket.app",
  password = "TestPass123!",
): Promise<void> {
  await page.goto("/login");
  await page.fill('input[id="email"]', email);
  await page.fill('input[id="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/app", { timeout: 10_000 });
}

/** Seed N pages with sequential titles. Returns page IDs for cleanup. */
export async function seedPages(
  request: APIRequestContext,
  token: string,
  count: number,
  prefix = "Seed Page",
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const res = await request.post(`${API_BASE}/archive/pages`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        url: `https://example.com/seed-${prefix.toLowerCase().replace(/\s+/g, "-")}-${i}`,
        title: `${prefix} ${String(i + 1).padStart(2, "0")}`,
      },
      failOnStatusCode: false,
    });
    if (res.ok()) {
      const page = await res.json();
      ids.push(page.id);
    }
  }
  return ids;
}

/** Delete pages by ID. */
export async function cleanupPages(
  request: APIRequestContext,
  token: string,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    await request.delete(`${API_BASE}/archive/pages/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    });
  }
}
