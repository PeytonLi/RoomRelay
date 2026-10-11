import { expect, test } from "@playwright/test";

test("checkout explains that payment is unavailable without PayPal capability", async ({ page }) => {
  await page.goto("/checkout/test-order");
  await expect(page.getByRole("heading", { name: "Checkout unavailable" })).toBeVisible();
  await expect(page.getByText("PayPal sandbox checkout is unavailable")).toBeVisible();
  await expect(page.getByText("No payment will be recorded.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Checkout status" }).getByRole("button")).toHaveCount(0);
});

test("checkout API returns 503 before identity or provider work when capability is absent", async ({ request }) => {
  const response = await request.post("/api/v1/checkouts", {
    data: { quoteId: "missing-quote", idempotencyKey: "unavailable-checkout" },
  });
  expect(response.status()).toBe(503);
});
