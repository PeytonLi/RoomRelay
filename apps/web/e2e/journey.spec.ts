import { expect, test, type Page, type Route } from "@playwright/test";
import {
  ORDER_ID,
  QUOTE_ID,
  ROOM_ID,
  candidatesResponse,
  checkoutView,
  openCase,
  orderView,
  quoteSummary,
  quoteView,
  roomsResponse,
} from "./fixtures/journey";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

type Handler = (route: Route, body: unknown) => unknown;

/** Intercepts every /api/v1 call and dispatches on `METHOD path`. */
async function mockApi(page: Page, handlers: Record<string, Handler | unknown>) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const key = `${route.request().method()} ${url.pathname}`;
    const entry = handlers[key];
    if (entry === undefined) return route.fulfill(json({ code: "NOT_FOUND", message: `unmocked ${key}` }, 404));
    const result = typeof entry === "function" ? (entry as Handler)(route, route.request().postDataJSON()) : entry;
    if (result && typeof result === "object" && "__status" in result) {
      return route.fulfill(json((result as { body: unknown }).body, (result as { __status: number }).__status));
    }
    return route.fulfill(json(result));
  });
}

const findings = [
  { code: "ROOM_REVISION", status: "PASS", itemIds: [], geometryRefs: [], evidenceIds: [], message: "Room measurements are current." },
];

const layoutCreated = { kind: "ok", layout: { id: "layout-1" }, evaluation: { findings } };
const layoutQuotable = { quotable: true, findings, reasons: [] };

test.describe("rooms find-furniture journey", () => {
  test("finds candidates, confirms layout, and requests a quote", async ({ page }) => {
    let layoutsBody: Record<string, unknown> | null = null;
    let quoteBody: Record<string, unknown> | null = null;
    await mockApi(page, {
      "GET /api/v1/rooms": roomsResponse,
      "POST /api/v1/rooms/room-1/candidates": candidatesResponse(),
      "POST /api/v1/layouts": (_route, body) => {
        layoutsBody = body as Record<string, unknown>;
        return layoutCreated;
      },
      "POST /api/v1/layouts/layout-1/quotable": layoutQuotable,
      "POST /api/v1/quotes": (_route, body) => {
        quoteBody = body as Record<string, unknown>;
        return { quote: { id: QUOTE_ID } };
      },
      "GET /api/v1/quotes/quote-1": { quote: quoteView({ status: "REQUESTED" }) },
    });

    await page.goto("/rooms");
    await expect(page.getByRole("radio", { name: /Bedroom/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("radio", { name: /Bedroom/ }).check();
    await page.locator('input[name="budget"]').fill("800");
    await page.getByRole("button", { name: "Find furniture" }).click();

    await expect(page.getByRole("heading", { name: "Candidates (3)" })).toBeVisible();
    const list = page.locator(".candidate-list > li");
    await expect(list).toHaveCount(3);
    await expect(list.first()).toContainText("Oak chair");
    await expect(list.first()).toContainText("Total");
    await expect(list.first()).toContainText("Pickup window");
    await expect(list.first()).toContainText("PASS");
    await expect(page.getByText("Not shown (1) and why")).toBeVisible();
    await page.getByText("Not shown (1) and why").click();
    await expect(page.getByText("Leather sofa")).toBeVisible();
    await expect(page.getByText("Over your budget")).toBeVisible();

    await page.getByRole("button", { name: "Choose Oak chair" }).click();
    await expect(page.getByText("PASS — server confirmed this layout is quotable")).toBeVisible();
    expect(layoutsBody).not.toBeNull();
    const created = layoutsBody as { placements: unknown; requirements: unknown; roomId: unknown };
    expect(created.placements).toEqual([
      { itemId: "item-1", listingVersion: 1, xM: 1, zM: 1.5, yawRad: 0 },
    ]);
    expect(created.requirements).toMatchObject({ budgetCents: 80_000 });
    expect(created.roomId).toBe(ROOM_ID);

    await page.getByRole("button", { name: "Request quote" }).click();
    await page.waitForURL(`**/quotes/${QUOTE_ID}`);
    await expect.poll(() => quoteBody).not.toBeNull();
    expect(quoteBody).not.toBeNull();
    expect(quoteBody!.layoutRevisionId).toBe("layout-1");
    expect(quoteBody!.roomId).toBe(ROOM_ID);
    expect(quoteBody!.termsVersion).toBe("roomrelay-pickup-terms-v1");
    expect(quoteBody!.sellerId).toBe("seller-1");
    const slot = quoteBody!.pickupSlot as { start: string; end: string };
    const start = new Date(slot.start).getTime();
    const end = new Date(slot.end).getTime();
    expect(end).toBeGreaterThan(start);
  });

  test("shows FAIL verdict and no request-quote button when the layout is not quotable", async ({ page }) => {
    await mockApi(page, {
      "GET /api/v1/rooms": roomsResponse,
      "POST /api/v1/rooms/room-1/candidates": candidatesResponse(),
      "POST /api/v1/layouts": layoutCreated,
      "POST /api/v1/layouts/layout-1/quotable": {
        __status: 422,
        body: {
          code: "LAYOUT_NOT_QUOTABLE",
          message: "layout is not quotable",
          findings,
          reasons: [{ code: "BUDGET_EXCEEDED", message: "total price exceeds the budget" }],
        },
      },
    });
    await page.goto("/rooms");
    await page.getByRole("radio", { name: /Bedroom/ }).check();
    await page.locator('input[name="budget"]').fill("800");
    await page.getByRole("button", { name: "Find furniture" }).click();
    await page.getByRole("button", { name: "Choose Oak chair" }).click();
    await expect(page.getByText("FAIL — server says this layout is not quotable")).toBeVisible();
    await expect(page.getByText("total price exceeds the budget")).toBeVisible();
    await expect(page.getByRole("button", { name: "Request quote" })).toHaveCount(0);
  });

  test("explains when every candidate is rejected", async ({ page }) => {
    await mockApi(page, {
      "GET /api/v1/rooms": roomsResponse,
      "POST /api/v1/rooms/room-1/candidates": {
        candidates: candidatesResponse().candidates.filter((c) => c.rejectionReason),
      },
    });
    await page.goto("/rooms");
    await page.getByRole("radio", { name: /Bedroom/ }).check();
    const budget = page.locator('input[name="budget"]');
    await budget.fill("");
    await budget.pressSequentially("250");
    await page.getByRole("button", { name: "Find furniture" }).click();
    await expect(page.getByText("No furniture fits these constraints.")).toBeVisible();
    await expect(page.getByText(/exceed your \$250\.00 budget/)).toBeVisible();
  });
});

test.describe("quote page journey", () => {
  test("buyer approves with all acknowledgements then starts checkout", async ({ page }) => {
    let approved = false;
    let approvalBody: Record<string, unknown> | null = null;
    let checkoutBody: Record<string, unknown> | null = null;
    await mockApi(page, {
      "GET /api/v1/quotes/quote-1": () => ({
        quote: quoteView({ status: approved ? "BUYER_APPROVED" : "SELLER_APPROVED", buyerApprovedAt: approved ? new Date().toISOString() : null }),
      }),
      "POST /api/v1/quotes/quote-1/buyer-approval": (_route, body) => {
        approvalBody = body as Record<string, unknown>;
        approved = true;
        return { quote: { id: QUOTE_ID } };
      },
      "POST /api/v1/checkouts": (_route, body) => {
        checkoutBody = body as Record<string, unknown>;
        return { checkout: { id: ORDER_ID } };
      },
      "GET /api/v1/checkouts/order-1": { checkout: checkoutView() },
    });

    await page.goto(`/quotes/${QUOTE_ID}`);
    await expect(page.getByText("Seller approved — waiting for buyer approval")).toBeVisible({ timeout: 30_000 });
    const approve = page.getByRole("button", { name: "Approve" });
    await expect(approve).toBeDisabled();
    const boxes = page.locator(".acks input[type=checkbox]");
    await expect(boxes).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) await boxes.nth(i).check();
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect.poll(() => approvalBody).toEqual({
      contentHash: "f".repeat(64),
      acknowledgedWarnings: ["FIT_MEASURED_ROOM_ONLY_V1", "PICKUP_ROUTE_NOT_MEASURED_V1", "PICKUP_TERMS_V1"],
    });

    await expect(page.getByRole("button", { name: "Start checkout" })).toBeVisible();
    await page.getByRole("button", { name: "Start checkout" }).click();
    await page.waitForURL(`**/checkout/${ORDER_ID}`);
    await expect.poll(() => checkoutBody).not.toBeNull();
    expect(checkoutBody!.quoteId).toBe(QUOTE_ID);
    expect(typeof checkoutBody!.idempotencyKey).toBe("string");
    expect(String(checkoutBody!.idempotencyKey).length).toBeGreaterThan(0);
  });

  test("seller approves exact terms on a requested quote", async ({ page }) => {
    let approvalBody: Record<string, unknown> | null = null;
    await mockApi(page, {
      "GET /api/v1/quotes/quote-1": () => ({
        quote: quoteView({ role: "SELLER", status: "REQUESTED", sellerApprovedAt: approvalBody ? new Date().toISOString() : null }),
      }),
      "POST /api/v1/quotes/quote-1/seller-approval": (_route, body) => {
        approvalBody = body as Record<string, unknown>;
        return { quote: { id: QUOTE_ID } };
      },
    });
    await page.goto(`/quotes/${QUOTE_ID}`);
    await expect(page.getByRole("button", { name: "Approve exact terms" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Approve exact terms" }).click();
    await expect.poll(() => approvalBody).toEqual({ contentHash: "f".repeat(64) });
  });

  test("closed checkout offers Start checkout with a fresh idempotency key", async ({ page }) => {
    let checkoutBody: Record<string, unknown> | null = null;
    await page.addInitScript(() => {
      sessionStorage.setItem("rr-checkout-key:quote-1", "stale-checkout-key");
    });
    await mockApi(page, {
      "GET /api/v1/quotes/quote-1": {
        quote: quoteView({
          status: "BUYER_APPROVED",
          buyerApprovedAt: new Date().toISOString(),
          checkout: { id: "order-canceled", status: "CANCELED" },
        }),
      },
      "POST /api/v1/checkouts": (_route, body) => {
        checkoutBody = body as Record<string, unknown>;
        return { checkout: { id: ORDER_ID } };
      },
      "GET /api/v1/checkouts/order-1": { checkout: checkoutView() },
    });
    await page.goto(`/quotes/${QUOTE_ID}`);
    await expect(page.getByRole("button", { name: "Start checkout" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link", { name: "Continue checkout" })).toHaveCount(0);
    await page.getByRole("button", { name: "Start checkout" }).click();
    await page.waitForURL(`**/checkout/${ORDER_ID}`);
    await expect.poll(() => checkoutBody).not.toBeNull();
    expect(checkoutBody!.quoteId).toBe(QUOTE_ID);
    expect(checkoutBody!.idempotencyKey).not.toBe("stale-checkout-key");
    expect(String(checkoutBody!.idempotencyKey).length).toBeGreaterThan(0);
  });

  test("stale quote blocks approval and checkout", async ({ page }) => {
    await mockApi(page, {
      "GET /api/v1/quotes/quote-1": {
        quote: quoteView({ stale: true, staleReasons: ["QUOTE_EXPIRED"] }),
      },
    });
    await page.goto(`/quotes/${QUOTE_ID}`);
    await expect(page.getByText("This quote is stale and cannot be approved or paid.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("The quote expiry time has passed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start checkout" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Request a new quote/ })).toBeVisible();
  });
});

test.describe("checkout page journey", () => {
  const sandboxBadge = (page: Page) => page.getByText("PayPal Sandbox").first();

  test("pay flow: approval, capture, recheck and redirect to the order", async ({ page }) => {
    let gets = 0;
    let approvalBody: Record<string, unknown> | null = null;
    let captureBody: Record<string, unknown> | null = null;
    await mockApi(page, {
      "GET /api/v1/checkouts/order-1": () => {
        gets += 1;
        const status = gets === 1 ? "CREATED" : gets === 2 ? "APPROVED" : gets <= 4 ? "PENDING" : "PAID";
        return {
          checkout: checkoutView({
            status,
            providerOrderId: gets >= 2 ? "PAYPALORDER1" : null,
            paidAt: status === "PAID" ? new Date().toISOString() : null,
          }),
        };
      },
      "POST /api/v1/checkouts/order-1/paypal-order": {
        checkout: { approveUrl: `/checkout/${ORDER_ID}?paypal=return&token=PAYPALORDER1` },
      },
      "POST /api/v1/checkouts/order-1/approval": (_route, body) => {
        approvalBody = body as Record<string, unknown>;
        return { checkout: checkoutView({ status: "APPROVED" }) };
      },
      "POST /api/v1/checkouts/order-1/capture": (_route, body) => {
        captureBody = body as Record<string, unknown>;
        return { checkout: checkoutView({ status: "PENDING" }) };
      },
      "GET /api/v1/orders/order-1": { order: orderView() },
    });

    await page.goto(`/checkout/${ORDER_ID}`);
    await expect(sandboxBadge(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("MERCHANT1")).toBeVisible();
    await expect(page.getByText("$45.00").first()).toBeVisible();
    await expect(page.getByTestId("hold-countdown")).toBeVisible();

    await page.getByRole("button", { name: "Pay with PayPal" }).click();
    await page.waitForURL("**/checkout/order-1?paypal=return&token=PAYPALORDER1");
    await expect.poll(() => approvalBody).toEqual({ providerOrderId: "PAYPALORDER1" });
    await expect.poll(() => captureBody).toEqual({ providerOrderId: "PAYPALORDER1" });
    await page.waitForURL(`**/orders/${ORDER_ID}`, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Receipt" })).toBeVisible({ timeout: 30_000 });
  });

  test("rechecking status is visible while payment is pending", async ({ page }) => {
    await mockApi(page, {
      "GET /api/v1/checkouts/order-1": () => ({
        checkout: checkoutView({ status: "PENDING", providerOrderId: "PAYPALORDER1" }),
      }),
    });
    await page.goto(`/checkout/${ORDER_ID}`);
    await expect(page.getByText(/Rechecking payment status/)).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toContain(`/checkout/${ORDER_ID}`);
  });

  test("expired hold disables payment and links back to the quote", async ({ page }) => {
    await mockApi(page, {
      "GET /api/v1/checkouts/order-1": {
        checkout: checkoutView({ hold: { state: "ACTIVE", expiresAt: new Date(Date.now() - 60_000).toISOString() } }),
      },
    });
    await page.goto(`/checkout/${ORDER_ID}`);
    await expect(page.getByText("The item hold expired. Payment is disabled.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Pay with PayPal" })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Review the quote and request a new one" })).toBeVisible();
  });

  test("released hold shows Released and no countdown", async ({ page }) => {
    await mockApi(page, {
      "GET /api/v1/checkouts/order-1": {
        checkout: checkoutView({ status: "CANCELED", hold: { state: "RELEASED", expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() } }),
      },
    });
    await page.goto(`/checkout/${ORDER_ID}`);
    await expect(page.getByText("Released", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("hold-countdown")).toHaveCount(0);
  });

  test("cancel checkout releases the hold view", async ({ page }) => {
    let canceled = false;
    await mockApi(page, {
      "GET /api/v1/checkouts/order-1": () => ({
        checkout: checkoutView({ status: canceled ? "CANCELED" : "CREATED" }),
      }),
      "POST /api/v1/checkouts/order-1/cancel": () => {
        canceled = true;
        return { checkout: { id: ORDER_ID } };
      },
    });
    await page.goto(`/checkout/${ORDER_ID}`);
    await page.getByRole("button", { name: "Cancel checkout" }).click();
    await expect(page.getByText(/This checkout was canceled/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Pay with PayPal" })).toBeDisabled();
  });
});

test.describe("order page journey", () => {
  test("buyer sees placement guide, asymmetric acks and a disabled confirm with an open case", async ({ page }) => {
    await mockApi(page, {
      "GET /api/v1/orders/order-1": {
        order: orderView({ cases: [openCase()], nextAction: "SUPPORT" }),
      },
    });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(page.getByTestId("placement-guide")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("guide-item-1")).toBeVisible();
    await expect(page.getByTestId("guide-item-2")).toBeVisible();
    await expect(page.getByRole("table", { name: /Placement positions/ })).toBeVisible();
    await expect(page.getByRole("table", { name: /Placement positions/ }).getByRole("row")).toHaveCount(3);
    await expect(page.getByText("Item footprints use the seller-listed dimensions.")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    await expect(page.getByText(/You \(Buyer\): not confirmed yet/)).toBeVisible();
    await expect(page.getByText(/Seller: confirmed/)).toBeVisible();
    await expect(page.getByText("Both participants confirmed the handoff.")).toHaveCount(0);

    await expect(page.getByText("Leg is cracked, not as described.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm handoff" })).toBeDisabled();
    await expect(page.locator("body")).not.toContainText(/released|escrow/i);
  });

  test("buyer confirms handoff, reports an issue and adds a note", async ({ page }) => {
    let ackBody: unknown = "unset";
    let issueBody: Record<string, unknown> | null = null;
    let noteBody: Record<string, unknown> | null = null;
    await mockApi(page, {
      "GET /api/v1/orders/order-1": () => ({ order: orderView() }),
      "POST /api/v1/orders/order-1/pickup-ack": (_route, body) => {
        ackBody = body;
        return { __status: 409, body: { code: "CASE_OPEN", message: "An open issue blocks pickup confirmation." } };
      },
      "POST /api/v1/orders/order-1/issues": (_route, body) => {
        issueBody = body as Record<string, unknown>;
        return { case: openCase() };
      },
      "POST /api/v1/orders/order-1/notes": (_route, body) => {
        noteBody = body as Record<string, unknown>;
        return { note: { id: "note-1" } };
      },
    });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(page.getByRole("button", { name: "Confirm handoff" })).toBeEnabled({ timeout: 30_000 });
    await page.getByRole("button", { name: "Confirm handoff" }).click();
    await expect(page.getByText("An open issue blocks pickup confirmation.")).toBeVisible();
    await expect.poll(() => ackBody).toEqual({});

    await page.locator('select[name="reason"]').selectOption("DAMAGED");
    await page.getByRole("checkbox", { name: "Oak chair" }).check();
    await page.locator('textarea[name="issueDescription"]').pressSequentially("The chair leg is cracked.");
    await page.getByRole("button", { name: "Report issue" }).click();
    await expect.poll(() => issueBody).toEqual({
      reason: "DAMAGED",
      affectedItemIds: ["item-1"],
      description: "The chair leg is cracked.",
    });

    await page.locator('textarea[name="note"]').fill("See you Saturday at 10.");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect.poll(() => noteBody).toEqual({ body: "See you Saturday at 10." });
    await expect(page.locator("body")).not.toContainText(/released|escrow/i);
  });

  test("seller resolves cases, refunds and relists", async ({ page }) => {
    let resolveBody: Record<string, unknown> | null = null;
    let refundBody: Record<string, unknown> | null = null;
    let relistBody: Record<string, unknown> | null = null;
    let refunded = false;
    await mockApi(page, {
      "GET /api/v1/orders/order-1": () => ({
        order: orderView({
          role: "SELLER",
          placementGuide: null,
          cases: refunded ? [] : [openCase()],
          status: refunded ? "REFUNDED" : "PAID",
          refundedCents: refunded ? 4500 : 0,
          refund: refunded ? { status: "COMPLETED", providerRefundId: "REFUND1", amountCents: 4500 } : null,
          nextAction: refunded ? "REFUNDED" : "SUPPORT",
        }),
      }),
      "POST /api/v1/orders/order-1/issues/case-1/resolve": (_route, body) => {
        resolveBody = body as Record<string, unknown>;
        return { case: { ...openCase(), status: "RESOLVED" } };
      },
      "POST /api/v1/orders/order-1/refund": (_route, body) => {
        refundBody = body as Record<string, unknown>;
        refunded = true;
        return { refund: { status: "PENDING" } };
      },
      "POST /api/v1/items/item-1/relist": (_route, body) => {
        relistBody = body as Record<string, unknown>;
        return { item: { id: "item-1" } };
      },
    });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(page.getByRole("button", { name: "Resolve" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("placement-guide")).toHaveCount(0);
    await page.locator('input[name="resolve-case-1"]').fill("Returned the deposit in person.");
    await page.getByRole("button", { name: "Resolve" }).click();
    await expect.poll(() => resolveBody).toEqual({ resolutionNote: "Returned the deposit in person." });

    await page.locator('input[name="refundReason"]').fill("Item was damaged");
    await page.getByRole("button", { name: "Refund in full" }).click();
    await expect.poll(() => refundBody).not.toBeNull();
    expect(refundBody!.reason).toBe("Item was damaged");
    expect(typeof refundBody!.requestKey).toBe("string");
    expect(String(refundBody!.requestKey).length).toBeGreaterThan(0);

    await expect(page.getByText(/Refunded in full/)).toBeVisible();
    const relist = page.getByRole("button", { name: "Relist item (I have it back)" }).first();
    await expect(relist).toBeDisabled();
    await page.getByRole("checkbox", { name: /I have Oak chair back/ }).check();
    await expect(relist).toBeEnabled();
    await relist.click();
    await expect.poll(() => relistBody).toEqual({ possessionConfirmed: true });
    await expect(page.locator("body")).not.toContainText(/released|escrow/i);
  });

  test("relist shows draft status then publish makes the listing public", async ({ page }) => {
    let publishBody: Record<string, unknown> | null = null;
    await mockApi(page, {
      "GET /api/v1/orders/order-1": () => ({
        order: orderView({
          role: "SELLER",
          placementGuide: null,
          status: "REFUNDED",
          refundedCents: 4500,
          refund: { status: "COMPLETED", providerRefundId: "REFUND1", amountCents: 4500 },
          nextAction: "REFUNDED",
        }),
      }),
      "POST /api/v1/items/item-1/relist": { item: { id: "item-1" } },
      "GET /api/v1/items/item-1": { id: "item-1", version: 5 },
      "POST /api/v1/items/item-1/publish": (_route, body) => {
        publishBody = body as Record<string, unknown>;
        return { item: { id: "item-1" }, publishedVersion: 2 };
      },
    });
    await page.goto(`/orders/${ORDER_ID}`);
    await page.getByRole("checkbox", { name: /I have Oak chair back/ }).check();
    await page.getByRole("button", { name: "Relist item (I have it back)" }).first().click();
    await expect(page.getByText("Oak chair was relisted as a draft and isn't public yet.")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Publish listing" }).click();
    await expect.poll(() => publishBody).toEqual({ expectedVersion: 5 });
    await expect(page.getByText("Oak chair is public again.")).toBeVisible({ timeout: 30_000 });
  });

  test("unpaid order shows no-payment copy and no Assumptions heading when empty", async ({ page }) => {
    const view = orderView({
      status: "CREATED",
      paidAt: null,
      providerOrderId: "PAYPALORDER1",
      providerCaptureId: null,
      capturedCents: 0,
    });
    view.placementGuide!.assumptions = [];
    await mockApi(page, {
      "GET /api/v1/orders/order-1": { order: view },
    });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(page.getByText("No payment has been taken for this order yet.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/PayPal Sandbox processed this payment/)).toHaveCount(0);
    await expect(page.getByTestId("placement-guide")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Assumptions" })).toHaveCount(0);
  });
});

test("sell page lists incoming quotes needing approval", async ({ page }) => {
  await mockApi(page, {
    "GET /api/v1/items": [],
    "GET /api/v1/quotes": { quotes: [quoteSummary()] },
  });
  await page.goto("/sell");
  await expect(page.getByRole("heading", { name: "Incoming quotes" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Needs your approval")).toBeVisible();
  await expect(page.getByText("Oak chair")).toBeVisible();
  await expect(page.getByRole("link", { name: "Review v1" })).toHaveAttribute("href", `/quotes/${QUOTE_ID}`);
});

const SHOTS = "C:/Users/Administrator/t008-screens";
test.describe("journey screenshots", () => {
  test.skip(process.env.T008_SCREENSHOTS !== "1", "set T008_SCREENSHOTS=1 to record screenshots");
  for (const viewport of [
    { tag: "desktop", width: 1280, height: 900 },
    { tag: "390", width: 390, height: 844 },
  ]) {
    test(`rooms page at ${viewport.tag}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockApi(page, {
        "GET /api/v1/rooms": roomsResponse,
        "POST /api/v1/rooms/room-1/candidates": candidatesResponse(),
        "POST /api/v1/layouts": layoutCreated,
        "POST /api/v1/layouts/layout-1/quotable": layoutQuotable,
      });
      await page.goto("/rooms");
      await page.getByRole("radio", { name: /Bedroom/ }).check();
      await page.locator('input[name="budget"]').fill("800");
      await page.getByRole("button", { name: "Find furniture" }).click();
      await page.getByRole("button", { name: "Choose Oak chair" }).click();
      await expect(page.getByText("PASS — server confirmed this layout is quotable")).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${SHOTS}/rooms-${viewport.tag}.png`, fullPage: true });
    });

    test(`quote page at ${viewport.tag}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockApi(page, { "GET /api/v1/quotes/quote-1": { quote: quoteView() } });
      await page.goto(`/quotes/${QUOTE_ID}`);
      await expect(page.getByText("Seller approved — waiting for buyer approval")).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${SHOTS}/quote-${viewport.tag}.png`, fullPage: true });
    });

    test(`checkout page at ${viewport.tag}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockApi(page, { "GET /api/v1/checkouts/order-1": { checkout: checkoutView() } });
      await page.goto(`/checkout/${ORDER_ID}`);
      await expect(page.getByTestId("hold-countdown")).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${SHOTS}/checkout-${viewport.tag}.png`, fullPage: true });
    });

    test(`order page at ${viewport.tag}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockApi(page, {
        "GET /api/v1/orders/order-1": { order: orderView({ cases: [openCase()], nextAction: "SUPPORT" }) },
      });
      await page.goto(`/orders/${ORDER_ID}`);
      await expect(page.getByTestId("placement-guide")).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${SHOTS}/order-${viewport.tag}.png`, fullPage: true });
    });
  }
});
