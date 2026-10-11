import { expect, test } from "@playwright/test";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=",
  "base64",
);
const exactAddress = "123 Private Street, Secret City";

test("inventory pages report unavailable identity without a cookie", async ({ page, request }) => {
  const response = await request.get("/api/v1/rooms");
  expect(response.status()).toBe(503);
  expect((await response.json()).code).toBe("IDENTITY_UNAVAILABLE");
  await page.goto("/sell");
  await expect(page.getByText("Identity unavailable", { exact: true })).toBeVisible();
});

test("seller can publish a listing and buyer can create a room", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "rr_test_user", value: "seller-e2e", url: baseURL! }]);
  await page.goto("/sell");
  await page.getByLabel("Title", { exact: true }).fill("E2E desk");
  await page.getByLabel("Category", { exact: true }).fill("Desk");
  await page.getByLabel("Width (m)").fill("1");
  await page.getByLabel("Depth (m)").fill("1");
  await page.getByLabel("Height (m)").fill("1");
  await page.getByLabel("I confirmed these dimensions").check();
  await page.getByLabel("Condition photo").setInputFiles({
    name: "condition.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await page.getByLabel("Price (cents)").fill("5000");
  await page.getByLabel("Pickup starts").fill("2026-05-01T10:00");
  await page.getByLabel("Pickup ends").fill("2026-05-02T10:00");
  await page.getByLabel("Pickup area").fill("Central");
  await page.getByLabel("Exact pickup address (private)").fill(exactAddress);
  const publishButton = page.getByRole("button", { name: "Create draft and publish" });
  await publishButton.click();
  await expect(publishButton).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByRole("status")).toContainText("Published listing");

  const listingResponse = await context.request.get("/api/v1/listings");
  expect(listingResponse.ok()).toBe(true);
  expect(await listingResponse.text()).not.toContain(exactAddress);

  await context.clearCookies();
  await context.addCookies([{ name: "rr_test_user", value: "buyer-e2e", url: baseURL! }]);
  await page.goto("/rooms");
  await page.getByLabel("Room name").fill("E2E bedroom");
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.getByRole("status")).toContainText("Created E2E bedroom");
  await expect(page.getByRole("listitem").filter({ hasText: /E2E bedroom/ }).first()).toBeVisible();
});
