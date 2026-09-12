import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";

test("home loads after test login (no redirect to /login)", async ({ page }) => {
  // Non-admin uid: admins render the breadcrumb topbar where .home-top-title is
  // hidden by design (e2e-user is in ADMIN_IDS in the local/CI stack).
  await loginAs(page, "e2e-regular");
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator(".home-top-title")).toBeVisible();
});

test("create file via API, open it, grid renders", async ({ page }) => {
  await loginAs(page);
  const created = await page.request.post("/api/files", {
    data: {
      name: "e2e smoke",
      preset: "cookie",
      rows: [{ uid: "100001", cookies: "c_user=100001; xs=abc" }],
    },
  });
  const body = await created.text();
  expect(created.ok(), `create file failed: ${created.status()} ${body.slice(0, 500)}`).toBeTruthy();
  const file = JSON.parse(body) as { id: string };
  await page.goto(`/file/${file.id}`);
  await expect(page.locator("table.grid")).toBeVisible();
});
