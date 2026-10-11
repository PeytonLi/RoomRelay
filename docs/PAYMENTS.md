# Inventory, PayPal and handoff contract

Authority: [PRD.md](PRD.md), FR-23..30. This document owns transactional behavior. Implementation is absent. Use sandbox for the first build; no live charge, marketplace approval, seller protection guarantee or escrow arrangement has been established.

## P-01: who receives money

P0 has **one configured sandbox merchant representing the demo seller**, one seller per approved bundle, one purchase unit, USD and quantity-one used items. Buyer payment goes to that merchant through PayPal Checkout. Credentials represent that merchant, not arbitrary student accounts. UI shows the actual payee and sandbox state; a seed seller is not an independently onboarded public merchant.

Production RoomRelay needs approved marketplace/multiparty access and actual seller onboarding before routing payments among unrelated sellers. Do not collect everything into a platform merchant account and call a later Payouts transfer a compliant marketplace shortcut. Payouts production access is separate. Multi-seller purchases are not P0 and are not assumed atomic.

Use Orders v2 with CAPTURE intent and explicit buyer approval. The app does not hold escrow. Payment occurs at approved checkout; physical pickup is a separate order milestone. Authorization horizons or handoff acknowledgments must never be described as unlimited escrow. The app does not promise PayPal protection covers pickup; verify/disclose the relevant terms before production.

Sources: [standard Orders flow](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard.md), [platform onboarding/approval](https://developer.paypal.com/platforms/overview), [Payouts requirements](https://developer.paypal.com/docs/payouts/standard/), [Payments reference](https://developer.paypal.com/docs/api/payments/v2/).

## P-02: immutable quotes and money

A quote snapshots buyer, seller/merchant/environment, exact item IDs and content versions, item dimensions/condition disclosures, layout/room revision, line prices, optional explicit seller-approved bundle discount, total, selected pickup slot, terms version, seller approval, buyer approval and expiry.

Proposed quote lifetime: 24 hours after seller approval, capped by pickup availability; any critical content/room/layout/price/date/merchant change invalidates it earlier. Seller approval is not a stock hold. Checkout revalidates all facts. An expired/stale quote needs a new approved snapshot.

Server stores cents as integers. P0 total is item subtotal minus approved discount; shipping/tax/platform fees are zero in the sandbox demonstration and clearly not a production tax policy. A discount cannot make the amount nonpositive. Format PayPal decimal USD strings from integer cents; never trust browser totals or use binary floats as the money source. Provider gross/currency must match exactly. Any fees/retained fees come from provider facts, not hardcoded percentages or invented promises.

An approved layout is required for fit-qualified purchase. Critical FAIL/UNKNOWN findings block this prototype's quote. A warned assumption is visible and acknowledged, never silently cleared. Layout and quote snapshots remain inspectable after listing edits; they cannot change after payment.

## P-03: state axes

Use separate state axes instead of one ambiguous paid-and-delivered status.

| Domain | States |
| --- | --- |
| Quote | REQUESTED, SELLER_APPROVED, BUYER_APPROVED, SUPERSEDED, EXPIRED, REJECTED |
| Inventory | AVAILABLE, HELD, PAYMENT_PENDING, SOLD |
| Reservation | ACTIVE, CAPTURE_PENDING, CONSUMED, RELEASED, EXPIRED, EXCEPTION |
| Checkout/payment | CREATED, PROVIDER_CREATED, APPROVED, CAPTURE_SUBMITTING, PENDING, RECONCILING, PAID, CANCELED, EXPIRED, FAILED, PARTIALLY_REFUNDED, REFUNDED, REVERSED, EXCEPTION |
| Refund operation | STAGED, SUBMITTED, PENDING, COMPLETED, FAILED, RECONCILING |
| Handoff | UNSCHEDULED, SCHEDULED, READY, BUYER_ACKNOWLEDGED, SELLER_ACKNOWLEDGED, COMPLETED, ISSUE_OPEN |

Order transitions are auditable and monotonic with respect to confirmed financial facts. A late APPROVED event cannot regress PAID; a verified refund/reversal updates the financial axis without pretending handoff did/did not occur. Display clear actions for pending/exception states.

## P-04: atomic checkout reservation

1. Authenticate buyer; load their current approved quote and exact versions.
2. Start a short PostgreSQL transaction. Lock inventory rows in sorted item-ID order or use equivalent conditional versioned updates under appropriate isolation.
3. Require all items AVAILABLE, current price/version/merchant match, dates feasible and quote unexpired. Reserve **all or none**.
4. Persist checkout/order reference and one reservation with a 15-minute approval deadline. Commit before any PayPal request.
5. A conflicting buyer gets 409 with a replan action; partial holds are rolled back. Bound transaction-conflict retries and reread facts.

Inventory/active reservation uniqueness is enforced in DB, not just the UI. Idempotently retrying the same buyer request returns the existing checkout; it does not create a second active reservation. Requote/reapproval does not silently transfer someone else's held item.

The expiration job releases only ACTIVE reservations with no capture operation staged/submitted/pending/unknown. CAPTURE_PENDING inventory has **no blind time-based release**; it remains protected through reconciliation.

## P-05: provider create, approval and capture

### Create

Persist a CREATE payment operation and unique `PayPal-Request-Id` before the network call. Build provider amount/items/merchant/environment/reference from the quote snapshot. Store provider order ID and bind it to this checkout/buyer/reservation. Return only data needed for buyer approval. A provider create timeout is retried with the same stored key; creating an unpaid order does not establish payment.

### Approval

Buyer uses PayPal's approval UI. Returned order ID is checked against the stored binding. Approval callback or `CHECKOUT.ORDER.APPROVED` notification can record APPROVED/reconcile state but cannot alone mark PAID. P0 captures through the controlled checkout endpoint; an approval webhook does not automatically capture an expired/unapproved app quote.

### Capture

1. Authenticate the same buyer and validate stored provider-order binding.
2. In a short DB transaction recheck deadline, quote/hold eligibility and inventory ownership. Stage the persistent CAPTURE operation/key, change reservation to CAPTURE_PENDING and inventory to PAYMENT_PENDING. Commit.
3. Submit provider capture **outside the transaction**, using that same operation key on retry. Once submission might have happened, uncertainty cannot release inventory.
4. Validate authoritative capture/order facts: expected provider order/reference, merchant/environment, currency, gross amount, capture identity and COMPLETED capture status. Order approval/completion prose alone is insufficient.
5. In a new transaction apply the result once, mark PAID and SOLD/CONSUMED, and create the minimal receipt. If DB write fails after successful provider capture, persist/recover through reconciliation; do not pay again.

The operation record deliberately exists before the network request. A crash between staging and submission is conservative: reconcile or safely resume the same operation; never start an unrelated fresh charge. Approved-but-expired browser flow cannot bypass the eligibility check. A new provider create request cannot override an existing pending capture.

## P-06: webhook authenticity and durable processing

Subscribe only the required events for the configured app/environment. Suggested set includes order approval and capture completed/pending/denied/refunded/reversed; verify actual current event names and sample payloads before implementation. Add provider dispute events only if operational handling is implemented. Never infer financial truth from the event name alone.

The HTTPS listener preserves required transmission headers/raw event body and verifies the signature using PayPal's documented procedure and the configured webhook ID. Do not treat simulator payloads as verified real events. A fake body or failed verification has no business effect.

Persist a verified inbox record keyed by `(environment,eventId)` before acknowledging successful durable receipt. Reject failed verification; return a retriable failure if durable persistence fails. Process asynchronously/idempotently. Deduplication includes semantic operation/capture identity, because repeated state can arrive through API and different events. If a payload lacks expected facts, retrieve the authoritative order/capture. Match merchant, amount/currency and internal/provider references before changing state.

Do not dump sensitive full event bodies into general logs. Restrict any minimally required event data to the inbox. Handle out-of-order delivery by reconciling current facts rather than sorting event types into assumed order. [Webhook verification/delivery guide](https://developer.paypal.com/api/rest/webhooks/rest/), [idempotency](https://developer.paypal.com/api/rest/reference/idempotency/).

## P-07: pending, unknown and cancellation

| Situation | Required behavior |
| --- | --- |
| PayPal approval canceled before capture | Mark unpaid/canceled and release ACTIVE hold safely. |
| Hold expires before capture is staged | Disable capture, expire/release; late client approval requires new eligible checkout. |
| Create request timeout | Retry/reconcile same create key; no paid state. Release is allowed only when no capture could have been started. |
| Capture HTTP timeout or process crash | RECONCILING; keep inventory PAYMENT_PENDING; retrieve provider facts/retry same key as appropriate. |
| Provider capture PENDING | Display pending and keep inventory protected until terminal/provider-confirmed resolution. |
| Authoritative denial/failure with no outstanding uncertain attempt | Mark failed and release under the documented terminal fact. |
| Provider success but database failure | Reconcile to one paid order; no fresh charge. |
| Unexpected capture after invalid/expired reservation | Quarantine as EXCEPTION, notify operator, reconcile/refund as warranted; never overwrite a later buyer's inventory. |
| Browser refresh/new tab | Read persistent checkout state and resume; no duplicate order/capture. |
| Buyer requests cancel while capture pending | Record request; do not pretend canceled or release. If payment completes, merchant refund handles cancellation. |

Proposed reconciliation backoff: 5s, 15s, 60s, 5min, 15min, then operator-visible exception while keeping inventory protected. These are app scheduling defaults, not provider SLA. One retrieved APPROVED order is not proof that an outstanding network request can never complete. If terminal state cannot be established, escalate and retain protection; do not resolve ambiguity with a timer or a manual paid flag. PayPal key-retention details vary by endpoint; do not assume idempotency storage lasts indefinitely. Store local operation identity permanently and verify the current provider retention before retrying a very old operation.

## P-08: refunds, reversals and relisting

P0 supports one full refund initiated by the actual seller/operator against an actual completed capture. Verify requester, refundable remaining gross, order/environment/capture identity and operation uniqueness. Persist refund intent/key before requesting the provider; network retries reuse it. Provider confirmation drives COMPLETED/REFUNDED. A pending/unknown/failed refund remains visible and reconciles without duplicate independent requests.

Partial refunds are planned: store item allocation plus amount and enforce cumulative refunded cents <= captured cents under concurrency. They are not required in P0; a client cannot request an arbitrary partial amount through a hidden endpoint.

Refunding money does not prove physical return or recover condition. Sold inventory is not auto-released. Seller inspects/acknowledges possession and explicitly republishes a reviewed new version. Provider reversal/dispute becomes a support/operator case with reconciled financial state, not an app judgment about fault/protection.

Financial snapshots are minimal restricted records under a separate production retention policy. Deleted room captures do not destroy provider IDs/totals and acknowledgment facts required to explain a purchase. Never claim a particular statutory retention period before choosing jurisdiction/policy.

## P-09: physical handoff and privacy

The quote has an agreed feasible pickup slot. After authoritative payment, participants receive protected pickup address/contact information and a placement guide tied to the purchased layout. Exact address is absent from public listing/search data. A seller slot/address change requires participant acknowledgment. P0 provides authenticated in-app coordination, not unsolicited external email/SMS or automatic movers.

Both buyer and seller acknowledge pickup. One acknowledgment remains visible without claiming both agree. Missing/damaged goods open a case; substitutions require explicit new agreement and supported financial adjustment. Handoff cannot trigger a fictional release of app-held money.

## P-10: required checks

- Two buyers race for overlapping items; only one atomic hold succeeds and loser has no charge.
- Duplicate create/capture/refund requests reuse operation identity; same user key with altered body is rejected.
- Amount/currency/merchant/order ID tampering fails server validation.
- Expired approval cannot capture; expiration does not release CAPTURE_PENDING.
- Simulated network/DB crashes before/after provider capture converge to one paid order.
- Valid duplicate/out-of-order events are harmless; invalid signature/unrelated merchant cannot mutate state.
- Provider pending, denied, completed and refund states remain distinct.
- Concurrent refunds cannot exceed captured gross; refunded item stays unavailable until deliberate relisting.
- A private order/pickup address is inaccessible to nonparticipants.

Use mocked provider contract cases for difficult faults plus an actual sandbox create/approve/capture/refund and webhook delivery. Mock success alone cannot satisfy PayPal integration acceptance.
