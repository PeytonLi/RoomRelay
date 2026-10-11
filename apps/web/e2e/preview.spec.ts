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

test("placement inputs accept real per-key typing (draft state)", async ({ page }) => {
  await waitReady(page);
  const x = page.getByTestId("input-x");
  const yaw = page.getByTestId("input-yaw");

  // Select-all then type "1.2": the draft must survive while focused,
  // and the committed placement must already drive footprint/verdict.
  await x.click();
  await x.press("ControlOrMeta+a");
  await x.pressSequentially("1.2", { delay: 60 });
  await expect(x).toHaveValue("1.2");
  await expect(page.getByTestId("verdict")).toBeVisible();
  const d = await page.getByTestId("footprint-item-sheen-chair").locator("path").getAttribute("d");
  const m = /M([\d.]+),([\d.]+)/.exec(d!);
  // Footprint's first corner = x + w/2 ≈ 1.6135 m → (1.6135 + 0.4 margin) * 110px/m ≈ 221.5px.
  expect(Number(m![1])).toBeGreaterThan(210);
  expect(Number(m![1])).toBeLessThan(235);

  await x.press("Tab"); // blur → formatted committed value
  await expect(x).toHaveValue("1.200");

  await yaw.click();
  await yaw.press("ControlOrMeta+a");
  await yaw.pressSequentially("90", { delay: 60 });
  await expect(yaw).toHaveValue("90");
  await yaw.press("Tab");
  await expect(yaw).toHaveValue("90.0");

  // Invalid draft: clear the field, blur, previous value returns.
  await x.click();
  await x.press("ControlOrMeta+a");
  await x.press("Backspace");
  await expect(x).toHaveValue("");
  await x.press("Tab");
  await expect(x).toHaveValue("1.200");
  await expect(page.getByTestId("verdict")).toContainText(/fit|unknown/i);
  await expect(page.getByTestId("verdict")).not.toContainText("NaN");
});

test("out-of-range numeric drafts are rejected; huge yaw does not break the scene", async ({ page }) => {
  await waitReady(page);
  const yaw = page.getByTestId("input-yaw");
  // Wait for the GLB + selection helper to be attached before sampling centers.
  await page.waitForFunction(() => {
    const c = (window as unknown as { __rrDebug?: { centers(id: string): { model: { x: number; y: number }; helper: { x: number; y: number } | null } | null } }).__rrDebug?.centers("item-sheen-chair");
    return !!c && !!c.helper;
  });

  // Astronomical draft: rejected, never committed, scene stays intact.
  await yaw.fill("1e308");
  await expect(yaw).toHaveAttribute("aria-invalid", "true");
  const centers = await page.evaluate(() =>
    (window as unknown as { __rrDebug?: { centers(id: string): { model: { x: number; y: number }; helper: { x: number; y: number } | null } | null } }).__rrDebug?.centers("item-sheen-chair"),
  );
  expect(centers).toBeTruthy();
  expect(centers!.helper).not.toBeNull();
  await expect(page.getByTestId("verdict")).toHaveText("Fits provided measurements");
  // Blur resyncs the field to the last committed value (default yaw is 180°).
  await yaw.press("Tab");
  await expect(yaw).toHaveValue("180.0");

  // Out-of-range but sane magnitude yaw: 450° normalizes to 90°.
  await yaw.fill("450");
  await yaw.press("Tab");
  await expect(yaw).toHaveValue("90.0");

  // Huge X/Z drafts are likewise rejected.
  const x = page.getByTestId("input-x");
  await x.fill("1e308");
  await expect(x).toHaveAttribute("aria-invalid", "true");
  await x.press("Tab");
  await expect(x).not.toHaveValue("");
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

test("selection helper tracks the model bbox (390px)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitReady(page);
  await page.waitForFunction(() => {
    const c = (window as unknown as { __rrDebug?: { centers(id: string): { model: { x: number; y: number }; helper: { x: number; y: number } | null } | null } }).__rrDebug?.centers("item-sheen-chair");
    return !!c && !!c.helper;
  });
  // Sample across a few frames: model and helper centers must coincide.
  for (let i = 0; i < 5; i++) {
    const c = await page.evaluate(() =>
      (window as unknown as { __rrDebug: { centers(id: string): { model: { x: number; y: number }; helper: { x: number; y: number } } } }).__rrDebug.centers("item-sheen-chair"),
    );
    expect(c.helper).not.toBeNull();
    expect(Math.abs(c.model.x - c.helper.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(c.model.y - c.helper.y)).toBeLessThanOrEqual(3);
    await page.waitForTimeout(120);
  }
});
