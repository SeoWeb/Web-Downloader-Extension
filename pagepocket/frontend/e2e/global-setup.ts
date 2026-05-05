import { test as setup } from "@playwright/test";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:8080/api/v1";

setup("seed test user", async ({ request }) => {
  const res = await request.post(`${API_BASE}/auth/register`, {
    data: {
      email: "e2e@test.pagepocket.app",
      password: "TestPass123!",
    },
    failOnStatusCode: false,
  });

  // 200 or 409 (already exists) is fine
  if (res.status() !== 200 && res.status() !== 409) {
    throw new Error(`Failed to seed test user: ${res.status()} ${await res.text()}`);
  }
});
