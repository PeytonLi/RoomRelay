import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";

/**
 * T-008 integrated sandbox journey. Opt-in only (never in CI):
 *   PAYPAL_SANDBOX_* env vars are required; the browser drives the real UI and
 *   real API; PayPal approval uses the sandbox buyer account from env.
 */

const RUN_TS = process.env.SANDBOX_RUN_TS ?? new Date().toISOString().replace(/[:.]/g, "-");
const EVIDENCE_DIR = `C:/Users/Administrator/t008-evidence/${RUN_TS}`;
const evidence: Record<string, unknown> = { runTs: RUN_TS, steps: {} };
const step = (name: string, data: unknown) => {
  (evidence.steps as Record<string, unknown>)[name] = data;
  console.log(`JOURNEY_STEP ${name} ${new Date().toISOString()} ${JSON.stringify(data).slice(0, 300)}`);
};

const BUYER_EMAIL = process.env.PAYPAL_SANDBOX_BUYER_EMAIL ?? "";
const BUYER_PASSWORD = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD ?? "";
const MERCHANT_ID = process.env.PAYPAL_SANDBOX_MERCHANT_ID ?? "";
const runId = `${Date.now()}`;
const SUBJECTS = { seller: `t008-seller-${runId}`, buyer: `t008-buyer-${runId}`, outsider: `t008-outsider-${runId}` };
const ADDRESS = `42 Sandbox Lane Apt ${runId.slice(-4)}`;
const ITEM_TITLE = `Sandbox desk ${runId}`;

const png = () =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

async function shot(page: Page, name: string, mobile = false) {
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}${mobile ? "-mobile390" : ""}.png`, fullPage: true });
}

async function contextFor(browser: Browser, subject: string) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL as string });
  await context.addCookies([{ name: "rr_test_user", value: subject, url: test.info().project.use.baseURL as string }]);
  return context;
}

async function api(request: APIRequestContext, method: string, path: string, subject: string, body?: unknown) {
  const response = await request.fetch(`http://localhost:${new URL(test.info().project.use.baseURL as string).port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: `rr_test_user=${subject}` },
    data: body,
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

test.describe.configure({ mode: "serial" });
test.skip(!BUYER_EMAIL || !BUYER_PASSWORD || !MERCHANT_ID, "PAYPAL_SANDBOX_* env vars required");

test("T-008 real sandbox journey", async ({ browser, request }) => {
  test.setTimeout(600_000);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  // Earlier runs leave their relisted item ACTIVE; candidates are ordered by id
  // and the UI shows only the top three, so stale items can crowd this run's
  // item out. Withdraw leftover "Sandbox desk" items before publishing ours.
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:roomrelay-dev@localhost:5432/roomrelay" });
  await db.connect();
  await db.query("update items set status='WITHDRAWN' where status='ACTIVE' and id in (select item_id from listing_versions where title like 'Sandbox desk %')");
  await db.end();
  const sellerCtx = await contextFor(browser, SUBJECTS.seller);
  const buyerCtx = await contextFor(browser, SUBJECTS.buyer);
  const outsiderCtx = await contextFor(browser, SUBJECTS.outsider);
  const seller = await sellerCtx.newPage();
  const buyer = await buyerCtx.newPage();
  const outsider = await outsiderCtx.newPage();

  // ---------- (a) seller creates + publishes an item ----------
  await seller.goto("/sell");
  await seller.locator("#title").fill(ITEM_TITLE);
  await seller.locator("#category").fill("Desk");
  await seller.locator("#widthM").fill("1.20");
  await seller.locator("#depthM").fill("0.60");
  await seller.locator("#heightM").fill("0.75");
  await seller.locator('input[name="dimsConfirmed"]').check();
  await seller.locator("#conditionNotes").fill("Minor scratches");
  await seller.locator("#conditionPhoto").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png() });
  await seller.locator("#priceCents").fill("4500");
  await seller.locator("#coarseArea").fill("Sandbox district");
  await seller.locator("#exactPickupAddress").fill(ADDRESS);
  await seller.getByRole("button", { name: "Create draft and publish" }).click();
  await expect(seller.getByText(/Published listing v1/)).toBeVisible({ timeout: 60_000 });
  await shot(seller, "01-seller-published");

  // The exact address must not be public before payment.
  const listingsPublic = await api(request, "GET", "/api/v1/listings", SUBJECTS.outsider);
  const listingText = JSON.stringify(listingsPublic.body);
  expect(listingText).toContain(ITEM_TITLE);
  expect(listingText).not.toContain(ADDRESS);
  step("a_publish", { listingStatus: listingsPublic.status, addressPublic: listingText.includes(ADDRESS) });

  // ---------- (b) buyer room, candidates, layout, quote ----------
  await buyer.goto("/rooms");
  await buyer.locator("#roomName").fill(`Synthetic sandbox room ${runId}`);
  await buyer.getByRole("button", { name: "Create room" }).click();
  await expect(buyer.getByText(/measurement revision 1/).first()).toBeVisible({ timeout: 60_000 });
  await buyer.getByRole("radio", { name: /Synthetic sandbox room/ }).check();
  await buyer.locator('input[name="budget"]').fill("500");
  await buyer.getByRole("button", { name: "Find furniture" }).click();
  await expect(buyer.getByRole("button", { name: `Choose ${ITEM_TITLE}` })).toBeVisible({ timeout: 60_000 });
  await shot(buyer, "02-buyer-candidates");
  await buyer.getByRole("button", { name: `Choose ${ITEM_TITLE}` }).click();
  await expect(buyer.locator(".verdict")).toContainText("PASS", { timeout: 60_000 });
  await buyer.getByRole("button", { name: "Request quote" }).click();
  try {
    await buyer.waitForURL("**/quotes/*", { timeout: 60_000 });
  } catch (error) {
    await shot(buyer, "debug-request-quote-failed");
    const notice = await buyer.locator(".notice.fail, [role=alert]").allTextContents().catch(() => []);
    console.log("REQUEST_QUOTE_PAGE_NOTICE:", JSON.stringify(notice));
    throw error;
  }
  const quoteId = buyer.url().split("/quotes/")[1]!;
  step("b_quote", { quoteId });
  await shot(buyer, "03-buyer-quote");

  // ---------- (c) seller approval, buyer approval ----------
  await seller.goto(`/quotes/${quoteId}`);
  await seller.getByRole("button", { name: "Approve exact terms" }).click();
  await expect(seller.getByText(/approved these exact terms\. Waiting for the buyer/i)).toBeVisible({ timeout: 60_000 });

  await buyer.goto(`/quotes/${quoteId}`);
  const acks = buyer.locator(".acks input[type=checkbox]");
  await expect(acks.first()).toBeVisible({ timeout: 60_000 });
  const ackCount = await acks.count();
  for (let i = 0; i < ackCount; i += 1) await acks.nth(i).check();
  await buyer.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(buyer.getByRole("button", { name: "Start checkout" })).toBeVisible({ timeout: 60_000 });
  step("c_approvals", { status: "BUYER_APPROVED" });

  // ---------- (d) checkout with real PayPal sandbox ----------
  await buyer.getByRole("button", { name: "Start checkout" }).click();
  await buyer.waitForURL("**/checkout/*", { timeout: 60_000 });
  const orderId = buyer.url().split("/checkout/")[1]!;
  await expect(buyer.getByText("PayPal Sandbox").first()).toBeVisible({ timeout: 60_000 });
  await expect(buyer.getByTestId("hold-countdown")).toBeVisible();
  await shot(buyer, "04-checkout");

  await buyer.getByRole("button", { name: "Pay with PayPal" }).click();
  await buyer.waitForURL(/paypal\.com/, { timeout: 60_000 });
  expect(new URL(buyer.url()).hostname).toContain("sandbox.paypal.com");
  step("d_approve_host", { host: new URL(buyer.url()).hostname });

  // Log in on PayPal sandbox (password field masked in screenshots).
  const emailField = buyer.locator('input[name="login_email"], #email');
  if (await emailField.count()) await emailField.first().fill(BUYER_EMAIL);
  const nextBtn = buyer.locator('#btnNext, button:has-text("Next")');
  if (await nextBtn.count()) await nextBtn.first().click();
  const pwdField = buyer.locator('input[name="login_password"], #password');
  await pwdField.first().fill(BUYER_PASSWORD);
  await buyer.locator('#btnLogin, button:has-text("Log In")').first().click();
  // Approve / continue on the review page.
  const approveBtn = buyer.locator('#payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Pay Now"), button:has-text("Continue"), input[type="submit"]');
  await approveBtn.first().click({ timeout: 60_000 }).catch(async () => {
    // Some sandbox flows auto-submit; wait for return instead.
    await buyer.waitForURL(/paypal=return/, { timeout: 60_000 });
  });
  await buyer.waitForURL(/paypal=return/, { timeout: 90_000 });
  await buyer.waitForURL(`**/orders/${orderId}`, { timeout: 120_000 });
  await expect(buyer.getByRole("heading", { name: "Receipt" })).toBeVisible({ timeout: 60_000 });
  await shot(buyer, "05-order-buyer");

  const orderView = await api(request, "GET", `/api/v1/orders/${orderId}`, SUBJECTS.buyer);
  const order = orderView.body.order;
  expect(order.status).toBe("PAID");
  expect(order.providerOrderId).toBeTruthy();
  expect(order.providerCaptureId).toBeTruthy();
  expect(order.merchantId).toBe(MERCHANT_ID);
  step("d_paid", { orderId, status: order.status, providerOrderId: order.providerOrderId, providerCaptureId: order.providerCaptureId, merchantId: order.merchantId });

  // ---------- (e) privacy + guide ----------
  expect(order.placementGuide).not.toBeNull();
  expect(order.placementGuide.items[0].title).toBe(ITEM_TITLE);
  const sellerView = await api(request, "GET", `/api/v1/orders/${orderId}`, SUBJECTS.seller);
  expect(sellerView.body.order.placementGuide).toBeNull();
  expect(sellerView.body.order.handoff.pickupLocations[0].exactPickupAddress).toBe(ADDRESS);
  const outsiderOrder = await api(request, "GET", `/api/v1/orders/${orderId}`, SUBJECTS.outsider);
  expect(outsiderOrder.status).toBe(404);
  const outsiderQuote = await api(request, "GET", `/api/v1/quotes/${quoteId}`, SUBJECTS.outsider);
  expect(outsiderQuote.status).toBe(404);
  await seller.goto(`/orders/${orderId}`);
  await expect(seller.getByText("Buyer's room layout is private")).toBeVisible({ timeout: 60_000 });
  await expect(seller.getByTestId("placement-guide")).toHaveCount(0);
  await shot(seller, "06-order-seller");
  await outsider.goto(`/orders/${orderId}`);
  await expect(outsider.getByText("Order not found")).toBeVisible({ timeout: 60_000 });
  await shot(outsider, "07-order-404");
  step("e_privacy", { sellerGuide: null, outsiderOrder404: 404, outsiderQuote404: outsiderQuote.status, pickupAddressVisible: sellerView.body.order.handoff.pickupLocations[0].exactPickupAddress === ADDRESS });

  // ---------- (f) issue (UI), ack states (UI), notes (UI) ----------
  // Buyer opens a DAMAGED issue through the order page form.
  await buyer.reload();
  await buyer.locator('select[name="reason"]').selectOption("DAMAGED");
  await buyer.locator(".issue-form fieldset input[type=checkbox]").first().check();
  await buyer.locator('textarea[name="issueDescription"]').fill("Desk leg cracked on inspection");
  await buyer.getByRole("button", { name: "Report issue" }).click();
  await expect(buyer.getByRole("region", { name: "Issues" }).getByText("Item damaged / not as described").first()).toBeVisible({ timeout: 60_000 });
  // While the case is open the UI disables handoff confirmation.
  await expect(buyer.getByRole("button", { name: "Confirm handoff" })).toBeDisabled();
  await shot(buyer, "09-issue-open");
  const orderWithCase = await api(request, "GET", `/api/v1/orders/${orderId}`, SUBJECTS.buyer);
  const caseId = orderWithCase.body.order.cases[0].id;
  expect(orderWithCase.body.order.handoff.state).toBe("ISSUE_OPEN");
  // API confirms the same block (409 CASE_OPEN) and that a buyer cannot resolve (403).
  const ackBlocked = await api(request, "POST", `/api/v1/orders/${orderId}/pickup-ack`, SUBJECTS.buyer, {});
  expect(ackBlocked.status).toBe(409);
  const buyerResolve = await api(request, "POST", `/api/v1/orders/${orderId}/issues/${caseId}/resolve`, SUBJECTS.buyer, { resolutionNote: "buyer trying" });
  expect(buyerResolve.status).toBe(403);
  // Seller resolves through the order page form.
  await seller.reload();
  await seller.locator(`input[name="resolve-${caseId}"]`).fill("Replaced leg at pickup");
  await seller.getByRole("button", { name: "Resolve" }).click();
  await expect(seller.getByText(/Resolved/).first()).toBeVisible({ timeout: 60_000 });
  // Both participants confirm the handoff through the UI.
  await buyer.reload();
  await buyer.getByRole("button", { name: "Confirm handoff" }).click();
  await expect(buyer.getByText(/You \(Buyer\): confirmed/)).toBeVisible({ timeout: 60_000 });
  const midAck = await api(request, "GET", `/api/v1/orders/${orderId}`, SUBJECTS.buyer);
  expect(midAck.body.order.handoff.state).toBe("BUYER_ACKNOWLEDGED");
  await seller.reload();
  await seller.getByRole("button", { name: "Confirm handoff" }).click();
  await expect(seller.getByText("Both participants confirmed the handoff.")).toBeVisible({ timeout: 60_000 });
  // A note from each side through the UI.
  await buyer.reload();
  await buyer.locator('textarea[name="note"]').fill("Buyer note: brought a van.");
  await buyer.getByRole("button", { name: "Add note" }).click();
  await expect(buyer.getByText("Buyer note: brought a van.")).toBeVisible({ timeout: 60_000 });
  await seller.reload();
  await seller.locator('textarea[name="note"]').fill("Seller note: see you then.");
  await seller.getByRole("button", { name: "Add note" }).click();
  await expect(seller.getByText("Seller note: see you then.")).toBeVisible({ timeout: 60_000 });
  const afterAck = await api(request, "GET", `/api/v1/orders/${orderId}`, SUBJECTS.buyer);
  expect(afterAck.body.order.status).toBe("PAID");
  expect(afterAck.body.order.handoff.state).toBe("COMPLETED");
  await buyer.reload();
  await expect(buyer.getByText("Both participants confirmed the handoff.")).toBeVisible({ timeout: 60_000 });
  await buyer.setViewportSize({ width: 390, height: 844 });
  await shot(buyer, "08-order-completed", true);
  await buyer.setViewportSize({ width: 1280, height: 800 });
  step("f_handoff", { caseId, ackBlocked: 409, buyerResolve: 403, finalState: afterAck.body.order.handoff.state, orderStatus: afterAck.body.order.status });

  // ---------- (g) refund + sandbox verification ----------
  await seller.reload();
  await seller.locator('input[name="refundReason"]').fill("Item returned after pickup inspection");
  await seller.getByRole("button", { name: "Refund in full" }).click();
  await expect(seller.getByText(/Refunded in full|Refund processing/)).toBeVisible({ timeout: 120_000 });
  const refunded = await api(request, "GET", `/api/v1/orders/${orderId}`, SUBJECTS.seller);
  expect(refunded.body.order.status).toBe("REFUNDED");
  step("g_refund", { status: refunded.body.order.status, refundStatus: refunded.body.order.refund?.status, providerRefundId: refunded.body.order.refund?.providerRefundId });

  const listingsAfter = await api(request, "GET", "/api/v1/listings", SUBJECTS.outsider);
  expect(JSON.stringify(listingsAfter.body)).not.toContain(ITEM_TITLE);
  const itemId = order.quote.lines[0].itemId;

  // ---------- (h) relist via order page UI + republish ----------
  await seller.reload();
  await seller.locator(".relist input[type=checkbox]").check();
  await seller.getByRole("button", { name: "Relist item (I have it back)" }).click();
  await expect(seller.getByText(`${ITEM_TITLE} is listed again.`)).toBeVisible({ timeout: 60_000 });
  const relistedItem = await api(request, "GET", `/api/v1/items/${itemId}`, SUBJECTS.seller);
  const publish = await api(request, "POST", `/api/v1/items/${itemId}/publish`, SUBJECTS.seller, { expectedVersion: relistedItem.body.version });
  expect(publish.status).toBe(200);
  const listingsFinal = await api(request, "GET", "/api/v1/listings", SUBJECTS.outsider);
  expect(JSON.stringify(listingsFinal.body)).toContain(ITEM_TITLE);
  step("h_relist", { publishStatus: publish.status, itemVersion: relistedItem.body.version, backInListings: JSON.stringify(listingsFinal.body).includes(ITEM_TITLE) });

  writeFileSync(`${EVIDENCE_DIR}/evidence.json`, JSON.stringify(evidence, null, 2));
});
