import { expect, test, type Page, type Route } from "@playwright/test";

const EVIDENCE = "C:/Users/Administrator/evidence";

const desk = { itemId: "desk-oak-120", title: "Oak writing desk", category: "desk", priceCents: 8000, currency: "USD", confirmedDimsM: { widthM: 1.2, depthM: 0.6, heightM: 0.75 } };
const chair = { itemId: "chair-task-01", title: "Mesh task chair", category: "chair", priceCents: 2500, currency: "USD", confirmedDimsM: { widthM: 0.5, depthM: 0.55, heightM: 0.9 } };

// Placements taken from the committed live eval (pref-study-desk-chair), which validateLayout accepted.
function proposalBody(placements: Array<{ itemId: string; xM: number; zM: number; yawDeg: number }>) {
  return {
    state: "proposal",
    model: { provider: "deepseek", model: "deepseek-flash", responseModels: ["deepseek-flash"] },
    outcome: {
      status: "PROPOSAL",
      calls: [],
      proposal: {
        sellerId: "seller-a",
        sellerName: "Alex (synthetic seller)",
        items: [desk, chair],
        totalPriceCents: 10500,
        placements: placements.map((p) => ({ ...p, yawRad: (p.yawDeg * Math.PI) / 180 })),
        layout: { findings: [], fitsProvidedMeasurements: true, verdict: "Fits provided measurements" },
        unappliedConstraintChanges: [{ constraint: "price", requestedChange: "make it free" }],
        reasonCodes: ["MEETS_REQUESTED_CATEGORY"],
        facts: [],
        modelRationale: "Desk and chair from one seller fit along the left wall.",
      },
    },
  };
}

async function ask(page: Page, text: string) {
  // Retry the fill in case a dev-server hydration pass resets the controlled textarea.
  await expect(async () => {
    await page.getByTestId("proposal-preferences").fill(text);
    await expect(page.getByTestId("proposal-submit")).toBeEnabled({ timeout: 500 });
  }).toPass();
  await page.getByTestId("proposal-submit").click();
}

test("without AI configured the panel shows the unavailable state and keeps the layout", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("verdict")).toBeVisible();
  await ask(page, "a desk and chair for studying");
  const unavailable = page.getByTestId("proposal-unavailable");
  await expect(unavailable).toContainText("AI planning is not configured");
  await expect(unavailable).toContainText("AI_API_KEY");
  await expect(page.getByTestId("proposal-apply")).toHaveCount(0);
  await expect(page.getByTestId("footprint-item-sheen-chair")).toBeVisible();
});

test("applying a proposal renders box proxies, re-checks fit locally, and edits send the current layout", async ({ page }) => {
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/planning/proposal", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    const placements =
      requests.length === 1
        ? [{ itemId: "desk-oak-120", xM: 1, zM: 1.5, yawDeg: 0 }, { itemId: "chair-task-01", xM: 1, zM: 2.3, yawDeg: 0 }]
        : [{ itemId: "desk-oak-120", xM: 2.9, zM: 3.0, yawDeg: 0 }, { itemId: "chair-task-01", xM: 1, zM: 2.3, yawDeg: 0 }];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(proposalBody(placements)) });
  });
  await page.goto("/");
  await expect(page.getByTestId("verdict")).toBeVisible();

  await ask(page, "a desk and chair for studying");
  await expect(page.getByTestId("proposal-total")).toHaveText("$105.00");
  await expect(page.getByTestId("proposal-item-desk-oak-120")).toContainText("$80.00");
  await expect(page.getByTestId("proposal-rationale")).toContainText("unverified");
  await expect(page.getByTestId("proposal-unapplied")).toContainText("price");
  expect(requests[0]!.currentLayout).toBeUndefined();

  await page.getByTestId("proposal-apply").click();
  await expect(page.getByTestId("footprint-desk-oak-120")).toBeVisible();
  await expect(page.getByTestId("footprint-chair-task-01")).toBeVisible();
  await expect(page.getByTestId("footprint-item-sheen-chair")).toHaveCount(0);
  await expect(page.getByTestId("verdict")).toHaveText("Fits provided measurements");
  await expect(page.getByTestId("item-panel")).toContainText("Box proxy from confirmed dimensions");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${EVIDENCE}/proposal-applied.png`, fullPage: true });

  // The server's "fits" claim is advisory to the client: a proposal placed on the bed must still FAIL locally.
  await ask(page, "move the desk to the right");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]!.currentLayout).toEqual([
    { itemId: "desk-oak-120", xM: 1, zM: 1.5, yawDeg: 0 },
    { itemId: "chair-task-01", xM: 1, zM: 2.3, yawDeg: 0 },
  ]);
  await page.getByTestId("proposal-apply").click();
  await expect(page.getByTestId("verdict")).toHaveText("Does not fit provided measurements");
  await expect(page.getByTestId("finding-OBSTACLE_OVERLAP").first()).toContainText("bed");
});

test("clarification and manual fallback offer nothing to apply", async ({ page }) => {
  let n = 0;
  await page.route("**/api/planning/proposal", async (route) => {
    n += 1;
    const model = { provider: "deepseek", model: "deepseek-flash", responseModels: ["deepseek-flash"] };
    const body =
      n === 1
        ? { state: "clarification", model, outcome: { status: "CLARIFICATION", question: "The wardrobe is taller than the ceiling. Want a dresser instead?", unappliedConstraintChanges: [], calls: [] } }
        : { state: "manual_fallback", model, outcome: { status: "MANUAL_FALLBACK", reason: "TIMEOUT", message: "The AI planner timed out. Place items manually; fit checks still apply.", rejections: [], calls: [] } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/");
  await ask(page, "a tall wardrobe");
  await expect(page.getByTestId("proposal-clarification")).toContainText("taller than the ceiling");
  await expect(page.getByTestId("proposal-apply")).toHaveCount(0);
  await ask(page, "a desk");
  await expect(page.getByTestId("proposal-fallback")).toContainText("timed out");
  await expect(page.getByTestId("proposal-apply")).toHaveCount(0);
});

test("proposal panel is usable at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const panel = page.getByTestId("proposal-panel");
  await panel.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("proposal-preferences")).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
});
