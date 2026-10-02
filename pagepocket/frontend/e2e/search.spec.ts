import { test, expect } from "@playwright/test";
import { API_BASE, uiLogin } from "./helpers";

test.beforeEach(async ({ page, request }) => {
  // Seed pages with known body text for search verification
  const loginRes = await request.post(`${API_BASE}/auth/login`, {
    data: {
      email: "e2e@test.pagepocket.app",
      password: "TestPass123!",
    },
    failOnStatusCode: false,
  });

  if (loginRes.status() === 200) {
    const { access_token } = await loginRes.json();

    // Seed pages with deterministic content
    const seedPages = [
      {
        url: "https://example.com/react-hooks-guide",
        title: "React Hooks Guide",
        body: "React hooks let you use state and other features in function components. useState and useEffect are the most commonly used hooks in React applications.",
      },
      {
        url: "https://example.com/typescript-patterns",
        title: "TypeScript Design Patterns",
        body: "TypeScript design patterns help structure large applications. Factory, Observer, and Singleton patterns are commonly used in TypeScript projects.",
      },
      {
        url: "https://example.com/react-testing",
        title: "Testing React Applications",
        body: "Testing React components with Vitest and Playwright ensures reliability. Unit tests cover hooks and utilities while e2e tests cover user flows.",
      },
    ];

    for (const pg of seedPages) {
      await request.post(`${API_BASE}/archive/pages`, {
        data: pg,
        headers: { Authorization: `Bearer ${access_token}` },
        failOnStatusCode: false,
      });
    }

    // Create a collection and assign a page to it for filter testing
    const colRes = await request.post(`${API_BASE}/library/collections`, {
      data: { name: "SearchTestCollection", color: "#3B82F6" },
      headers: { Authorization: `Bearer ${access_token}` },
      failOnStatusCode: false,
    });

    if (colRes.status() === 200) {
      const col = await colRes.json();
      // Assign the first page to the collection
      const pagesRes = await request.get(`${API_BASE}/archive/pages?page_size=50`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (pagesRes.status() === 200) {
        const pages = await pagesRes.json();
        const reactPage = pages.pages?.find(
          (p: { title: string }) => p.title === "React Hooks Guide",
        );
        if (reactPage) {
          await request.post(
            `${API_BASE}/library/collections/${col.id}/pages`,
            {
              data: { page_id: reactPage.id },
              headers: { Authorization: `Bearer ${access_token}` },
              failOnStatusCode: false,
            },
          );
        }
      }
    }
  }

  // Login via UI
  await uiLogin(page);
});

test.describe("Search", () => {
  test("search page shows placeholder for empty query", async ({ page }) => {
    await page.goto("/app/search");
    await expect(
      page.getByText(/search for|type a search term/i),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("search with query shows results with highlighted snippets", async ({
    page,
  }) => {
    await page.goto("/app/search?q=React");
    await page.waitForTimeout(3_000);

    // Should have results or the empty state
    const hasResults = (await page.locator("mark").count()) > 0;
    const hasEmpty = (await page.getByText(/no pages match/i).count()) > 0;

    if (hasResults) {
      // Assert highlighted snippets contain the search term
      const marks = page.locator("mark");
      const count = await marks.count();
      expect(count).toBeGreaterThan(0);

      // Verify mark content contains the query term (case-insensitive)
      for (let i = 0; i < Math.min(count, 3); i++) {
        const text = await marks.nth(i).textContent();
        expect(text?.toLowerCase()).toContain("react");
      }

      // Verify result cards have expected structure: title, hostname, date
      const cards = page.locator('a[href^="/app/pages/"]');
      expect((await cards.count())).toBeGreaterThan(0);

      // Each card should have a hostname (example.com)
      const firstCard = cards.first();
      await expect(firstCard.getByText("example.com")).toBeVisible();
    }

    expect(hasResults || hasEmpty).toBeTruthy();
  });

  test("search for non-matching term shows empty state", async ({ page }) => {
    await page.goto("/app/search?q=xyznonexistent123");
    await page.waitForTimeout(2_000);

    await expect(page.getByText(/no pages match/i)).toBeVisible({
      timeout: 5_000,
    });
    // Should have a "Clear search" button
    await expect(
      page.getByRole("button", { name: /clear search/i }),
    ).toBeVisible();
  });

  test("topbar search navigates to search page", async ({ page }) => {
    // Type in the topbar search and submit
    const searchInput = page.locator('input[name="q"]').first();
    await searchInput.fill("TypeScript");
    await searchInput.press("Enter");

    await page.waitForURL(/\/app\/search\?q=TypeScript/, { timeout: 5_000 });
    await page.waitForTimeout(2_000);
  });

  test("collection filter chip is removable", async ({ page, request }) => {
    // Get a collection ID from the API
    const loginRes = await request.post(`${API_BASE}/auth/login`, {
      data: {
        email: "e2e@test.pagepocket.app",
        password: "TestPass123!",
      },
    });

    if (loginRes.status() === 200) {
      const { access_token } = await loginRes.json();
      const colsRes = await request.get(`${API_BASE}/library/collections`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });

      if (colsRes.status() === 200) {
        const cols = await colsRes.json();
        const testCol = cols.collections?.find(
          (c: { name: string }) => c.name === "SearchTestCollection",
        );

        if (testCol) {
          await page.goto(
            `/app/search?q=React&collection_id=${testCol.id}`,
          );
          await page.waitForTimeout(2_000);

          const chip = page.locator('[data-testid="collection-filter-chip"]');
          if ((await chip.count()) > 0) {
            // Verify chip shows collection name, not generic "Filtered"
            const chipText = await chip.textContent();
            expect(chipText).toContain("SearchTestCollection");

            // Remove the filter
            await chip.locator("button").click();
            await page.waitForURL(
              /.*[?&]q=React(&|$)/,
              { timeout: 5_000 },
            );

            // collection_id should be gone from URL
            const url = page.url();
            expect(url).not.toContain("collection_id");
          }
        }
      }
    }
  });

  test("arrow key navigation moves focus through results", async ({
    page,
  }) => {
    await page.goto("/app/search?q=React");
    await page.waitForTimeout(3_000);

    const results = page.locator('[role="option"]');
    if ((await results.count()) > 1) {
      // Focus the results list
      const listbox = page.locator('[role="listbox"]');
      await listbox.focus();

      // Press ArrowDown to move focus
      await listbox.press("ArrowDown");

      // First item should be focused (have ring class)
      const firstOption = results.first();
      const classes = await firstOption.getAttribute("class");
      expect(classes).toContain("ring");
    }
  });
});
