import { expect, test, type Page } from "@playwright/test";

const EVIDENCE = "C:\\Users\\Administrator\\evidence";

async function waitReady(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("verdict")).toBeVisible();
}

test("page loads, canvas renders, default placement fits", async ({ page }) => {
  await waitReady(page);
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByTestId("verdict")).toHaveText("Fits provided measurements");
  await page.waitForTimeout(1200); // let a few frames render
  await page.screenshot({ path: `${EVIDENCE}\\desktop-1440-default.png`, fullPage: true });
});

test("moving the item onto the bed shows a FAIL naming it; footprint updates", async ({ page }) => {
  await waitReady(page);
  await page.getByTestId("input-x").fill("2.9");
  await page.getByTestId("input-z").fill("3.0");
  const finding = page.getByTestId("finding-OBSTACLE_OVERLAP").first();
  await expect(finding).toBeVisible();
  await expect(finding).toHaveClass(/fail/);
  await expect(finding).toContainText("bed");
  await expect(page.getByTestId("verdict")).toHaveText("Does not fit provided measurements");
  // SVG footprint should have moved: its path must differ from a fresh one.
  const d = await page.getByTestId("footprint-item-sheen-chair").locator("path").getAttribute("d");
  expect(d).toBeTruthy();
  const m = /M([\d.]+),([\d.]+)/.exec(d!);
  expect(Number(m![1])).toBeGreaterThan(200); // right side of the plan
  await page.screenshot({ path: `${EVIDENCE}\\desktop-1440-collision.png`, fullPage: true });
});

test("no-WebGL fallback shows the 2D plan and item panel", async ({ page }) => {
  await page.goto("/?webgl=off");
  await expect(page.getByText(/WebGL/)).toBeVisible();
  await expect(page.getByTestId("plan2d")).toBeVisible();
  await expect(page.getByTestId("item-panel")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}\\desktop-1440-nowebgl.png`, fullPage: true });
});

test("mobile 390px layout remains usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitReady(page);
  await expect(page.getByTestId("plan2d")).toBeVisible();
  await expect(page.getByTestId("input-x")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}\\mobile-390-default.png`, fullPage: true });
});
