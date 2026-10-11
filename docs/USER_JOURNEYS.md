# User journeys and interface contract

Authority: product requirements in [PRD.md](PRD.md). This document owns screen behavior. IDs J-01 through J-12 can be cited from implementation tasks. All examples are illustrative; no fixtures or screens are implemented yet. Detailed server rules live in ARCHITECTURE.md, CAPTURE_AND_3D.md and PAYMENTS.md.

## Screen map

| Route/surface | Main content | Primary action |
| --- | --- | --- |
| `/` | Product explanation, truthful sandbox/prototype status, Buy / Sell | Choose goal |
| `/sign-in`, `/sign-up` | Managed authentication and return route | Authenticate |
| `/dashboard` | Buyer rooms/layouts, seller listings/orders, recoverable tasks | Resume work |
| `/sell/new` | Consent, item capture/import/manual draft | Add actual furniture |
| `/sell/items/[id]` | Capture state, original photos, measurements, condition, price, dates, eligibility | Review / Publish |
| `/rooms/new` | Capture/import/manual room and consent | Create room |
| `/rooms/[id]/edit` | Boundary, doors/windows, kept objects, measurement evidence | Confirm geometry |
| `/rooms/[id]/plan` | Requirements, candidate bundles, synchronized 3D/2D/list workspace | Compare / Arrange |
| `/listings/[id]` | Public selected photos, dimensions/source, condition, coarse location, dates | Add to plan |
| `/quotes/[id]` | Immutable contents, layout revision, total, pickup slot, expiry, approval | Approve / Request change |
| `/checkout/[id]` | Held items, countdown, merchant identity, PayPal sandbox UI, persistent state | Approve payment |
| `/orders/[id]` | Authoritative payment, receipt, placement guide, pickup, support/refund state | Coordinate handoff |
| `/settings/privacy` | Captures, room visibility, retention, deletion | Manage data |
| `/operator` | Authorized jobs, reviews, payment exceptions, support audit | Resolve specific case |
| Android: Home / Capture / Review / Upload | Auth, capability check, guided camera, selected items or room, measurement review, upload state | Capture and sync |

Navigation must not show a false success if a user arrives directly at a URL. Missing/unauthorized resources yield a neutral not-found state without leaking ownership. Operator route requires separate operator authorization.

## J-01: first visit and cross-device start

1. Visitor chooses Buy for my room or Sell my furniture; receives the same user account, not separate buyer/seller registrations.
2. Authentication uses managed email-code or configured social login. Return to the intended route after authentication.
3. Dashboard offers browser upload/import/manual entry and Android capture. Explain camera, private storage and any external AI processing before use.
4. Signed-in Android companion lists that account's server-side drafts; web and mobile share IDs/revisions, not an implicit public device folder.
5. If configuration is unavailable, preserve a truthful demo/explanation page; do not provide an insecure public role-switch shortcut.

Acceptance: J-01 fulfils FR-01..03; unrelated users cannot see one another's drafts. Native authentication smoke test must use the registered callback and validate the issued token server-side.

## J-02: seller captures an item with live assistance

1. Seller chooses one item. Consent screen explains private source media and selected public listing photos. The app checks ARCore/depth support and camera permission.
2. In the camera view, on-device detection suggests supported categories. User taps/creates an item, corrects category and front orientation if necessary. Boxes are suggestions, not measured outlines.
3. Capture guidance asks for slow translation around accessible sides and multiple heights; shows tracking/coverage/blur cues without claiming complete geometry from a label.
4. User can mark inaccessible surfaces, pause, discard a frame, stop or retake. Duplicate suggestions merge only after safe association/user review.
5. Item review asks for actual width/depth/height, source and a known-length check, damage/condition photos, missing/included parts, and front-facing direction.
6. Submit starts a resumable upload and background processing. Review remains editable while processing, but publication requires validated content and dimensions.

Failures: permission denied -> retry/settings or browser import/manual entry; tracking lost -> pause spatial capture and guide rescan; unsupported class -> manual category; model unavailable -> manual capture with clear inference status; low coverage -> request views; overheating -> reduce inference rate/pause; network loss -> resumable upload; reconstruction failure -> retry/import reviewed asset or publish a clearly approximate photo-first listing if fit evidence remains valid. Approximate assets are excluded from the exact-model demo acceptance.

## J-03: seller imports and publishes existing scan assets

1. Upload permitted item photos plus GLB/exported scan, or an approved format-conversion job. Multiple items must have independent assets and identities.
2. Server verifies content/size, isolates unsafe external references, queues normalization and reports job state.
3. Review shows source photo alongside model; seller confirms orientation, dimension mapping, appearance provenance and condition. Mesh repair must not alter recorded condition claims without review.
4. Seller enters fixed price, pickup dates, coarse area and proposed logistics. Exact address is stored privately. Merchant status is shown accurately.
5. Publish validates required fields and creates an ACTIVE listing. Checkout requires the configured eligible seller. Publication/editing is versioned.
6. Seller can withdraw available inventory. Held/paid contents cannot be edited or withdrawn through an ordinary listing toggle; use order/support workflow.

Acceptance: no amount or item can be invented by imported metadata; publication is a human decision. Model source, dimensions and date limits remain inspectable.

## J-04: buyer captures and verifies their room

1. Buyer creates a private room and chooses guided Android scan, imported scan or measured manual boundary.
2. Guided capture gathers spatial evidence while the buyer identifies room corners/boundaries, doors/windows and kept furniture. No assumption of a full automatic indoor semantic scan.
3. Buyer reviews the floor polygon, wall height where relevant, door positions/swing, existing-item footprints and explicit free zones. Manual edits are available.
4. Buyer enters/checks a tape-measured reference and confirms critical dimensions. Unknown boundaries stay unknown and prevent a confident fit conclusion.
5. Save produces a new room version. Geometry changes mark dependent layouts/quotes stale; the buyer sees why recalculation is needed.
6. Appearance processing may continue separately. Buyer can plan in measured 2D/photo view while the 3D backdrop loads.

Failures: room too cluttered -> mark kept objects and capture an empty usable area; blank walls/depth holes -> manual boundary; corrupt upload -> retry; invalid/self-crossing floor polygon -> explain which boundary needs correction; scale mismatch -> review normalization; declined permission -> measured entry. Original room media never becomes a public listing image by default.

## J-05: buyer defines requirements and compares bundles

1. Buyer enters maximum total, required categories, style preferences, move-in/pickup range and coarse search area; confirms which objects already satisfy a need.
2. Candidate generation filters actual inventory by hard constraints before model-assisted proposal. One purchasable bundle belongs to one eligible seller in P0.
3. Show up to three valid arrangements, each with item IDs/photos, placement preview, total, seller, fit status and possible pickup slot.
4. Explain a concrete rejection: item too wide, date not overlapping, item held, budget exceeded or missing dimensions. Do not use invented supply to fill a gap.
5. Buyer selects one option or changes a constraint. Changes are explicit: increasing budget or accepting a different pickup day requires the buyer's choice.

No-results state offers specific alternatives such as remove optional item, broaden date range, change category or save draft. It does not automatically loosen safety/fit/payment rules. Style similarity is never represented as condition or fit evidence.

## J-06: interactive placement and conversational edits

Workspace: large 3D/2D canvas, synchronized item list, current budget, fit findings, and room/item measurement panel. On small screens, use tabs/sheets rather than squeezing all panels onto the canvas.

1. Click/tap a placed object to highlight it and show listing/photos/price/condition/provenance.
2. Drag on the floor or enter numeric x/z/yaw; rotate using a labeled control. Snap/grid can be toggled. Users can undo/redo.
3. Both views update from the same layout revision. The app reruns geometry and shows which boundary/obstacle causes a conflict.
4. A request such as Move the desk away from the window becomes a proposed structured edit. Ambiguous relative directions prompt clarification; a failed model leaves numeric controls available.
5. A request such as Find a cheaper setup proposes changes to actual items/bundles. Changes affecting contents/price are previewed for approval and invalidate an old quote.
6. Invalid placement remains an editable draft, with visible FAIL/UNKNOWN findings. Request quote is disabled until required facts and hard constraints pass.
7. Save and reload recover the same accepted revision. Collaborative/conflicting writes use a version-conflict screen, not last-write-wins data loss.

Accessibility: keyboard selection, numeric position/rotation and a list/table of fit results support the same decisions without dragging. Color has accompanying text/icon labels. Graphics failure offers photos and the measured plan. Approximate proxies carry their label in every view.

## J-07: seller approval and immutable quote

1. Buyer requests a quote for the selected layout/items and a feasible pickup slot. Server validates current versions and availability.
2. Seller sees selected contents, condition disclosures, price, pickup terms and requested slot; does not receive the buyer's private room media. A layout may be shared only by explicit buyer consent.
3. Seller accepts exact terms or proposes a change. A changed price/content/date creates a new quote revision; it is never silently accepted for the buyer.
4. Buyer reviews the seller identity, actual item versions, total, selected pickup and expiry. Buyer acknowledges measured-fit assumptions and terms once, with a retained record.
5. Approved quote is immutable. An item/room/layout/price change or expiry requires a replacement quote, with the old quote visibly stale.

Quotes do not reserve stock forever. The buyer sees that checkout may fail if availability changes before the atomic hold. The seller's approval does not authorize payment on the buyer's behalf.

## J-08: PayPal checkout, cancellation and recovery

1. Start checkout atomically holds all quoted items for 15 minutes, after revalidation. Show the countdown, actual merchant identity, sandbox status and total.
2. PayPal approval occurs in the PayPal UI. Server create/capture endpoints use only the quote snapshot and configured merchant, with distinct persistent idempotency keys.
3. Browser displays Processing while provider status is pending/unknown. A click, redirect or approval callback is not payment success.
4. Completed verified capture -> paid order, sold items, receipt and next handoff step.
5. Buyer cancellation before capture -> abandoned/unpaid status and safe hold release. Back/refresh returns to the persistent checkout state.
6. Timer expiry before capture -> disabled payment and a revalidation/requote path. Late approval cannot bypass expiry.
7. Capture timeout/provider-pending -> Rechecking payment status. Inventory remains protected until authoritative reconciliation; user must not be instructed to pay a second time.

Failure details and retry rules are exclusively governed by PAYMENTS.md. Client cannot bypass them through navigation or a new session. Verified duplicate/out-of-order webhooks are handled idempotently and cannot regress paid state.

## J-09: receipt, placement guide and pickup

1. Paid order shows immutable purchased items, totals, merchant, receipt IDs, acknowledged terms and the purchased layout revision.
2. Placement guide contains numbered item names/photos, top-down positions, orientation, dimensions and unresolved assumptions. It can be viewed/printed without WebGL; generating a PDF is optional.
3. Buyer/seller see the agreed slot and private pickup details. Address changes are participant-visible and require acknowledgment; seller cannot substitute goods by editing the listing.
4. User supplies private contact/coordination notes through an authenticated order thread. Prototype notifications are in-app; external messaging/email is a later supported integration.
5. Both parties acknowledge physical handoff. If they disagree or an item is missing/damaged, the order becomes a support case rather than falsely completed delivery.
6. Payment remains paid while handoff is scheduled/in-progress. Handoff acknowledgment is not release of escrow.

P0 uses pickup; there is no automatic mover booking. Load-in/transport measurements beyond the captured room are UNKNOWN until explicitly recorded; a room fit does not promise it fits every stairwell or doorway en route.

## J-10: unavailable item, cancellation after payment, refund or dispute

1. Buyer/seller opens a case tied to an order and affected item IDs, with limited evidence shared only with participants/support.
2. Seller/operator reviews. P0 supports full merchant refund of the actual capture. Initiating it displays Refund processing.
3. Provider confirms full refund -> REFUNDED. Failed/pending/unknown refund remains visible with safe reconciliation; do not issue repeated independent refund requests.
4. Inventory does not return to available automatically. Seller verifies physical return/condition where relevant and explicitly creates/reviews a new listing version.
5. Provider dispute/reversal notifications are recorded and routed to an operator; they are not app-made decisions about eligibility or fault.

Partial item refunds, restocking fees and production marketplace policies are deferred. A sandbox example must not claim PayPal protection automatically applies to in-person pickup.

## J-11: privacy, deletion and support operations

1. User can see and delete unneeded captures/room drafts, select listing photos for public use, and revoke a room share.
2. Deletion queues derivative cleanup and removes signed-link access; active order financial snapshots are retained minimally under the separate policy.
3. Active listing asset deletion first withdraws available inventory or preserves the order-required minimal asset with visible explanation; no orphaned live listing can point to a silently missing file.
4. Support agent can view an exception, request consent for media access, retry a safe job or reconcile provider status. Every privileged action is audited.
5. User receives a clear retained-data summary; retention schedules do not imply backups vanish instantly. Logs and public repo never hold source imagery or exact addresses.

## J-12: optional future AR and splat experience

After P0, the buyer can launch native AR placement of the same item model/layout, using tested anchors/depth. An optional photorealistic splat backdrop provides navigable appearance, with a separate aligned geometry model for fit. Existing furniture removal, hidden-wall filling and relighting are explicit processing tasks; no generic erase button may silently invent accurate geometry.

These screens retain ordinary photos, measurement controls and provenance labels. Unsupported device/browser features fall back to the normal viewer. They cannot change what the buyer is purchasing.

## Shared behavior and copy rules

- Use concrete labels: Confirm dimensions, Review item, Waiting for seller, Fits provided measurements, Needs measurement, Rechecking payment, Paid, Refund processing.
- Avoid exposing SDK/model/provider names in ordinary consumer flows unless explaining consent, capability or a meaningful limitation. Technical diagnostics belong in support/dev views.
- Preserve drafts on refresh/navigation. Empty, loading, disabled, stale, retry, not-found and permission states are first-class UI.
- Never show confident progress percentages or an ETA if a worker/provider does not report them. Show the current stage and last update.
- Do not show exact addresses, a private room, another user's captures or payment tokens through analytics, URLs or public previews.
- Structured intent/price/measurement changes require explicit approval and update all affected revisions. Human approval remains separate from AI suggestions and provider financial state.
