# RoomRelay product requirements

Version: 1.0 specification baseline. Date: 2026-10-10. Implementation status: see [build_status.md](../build_status.md). Requirements marked P0 are required for the complete hackathon prototype, not claims that they already work. Numeric budgets below are proposed engineering targets, not measured results.

## 1. Product definition

RoomRelay transfers a useful room setup between people at different stages of moving. An outgoing seller captures actual used furniture, confirms its dimensions and condition, and publishes available items. An incoming buyer captures their room, states what they already own and need, and receives a bundle of available pieces positioned inside their own space. They can inspect and edit the arrangement, approve the exact contents and handoff, and buy through PayPal.

The central promise is: **see which real secondhand items can work in your room, where each goes, what the setup costs, and whether the moving dates work before buying.** Fit is conditional on recorded measurements; the product never promises infallible measurement from arbitrary photographs.

### Document ownership

| Contract | Canonical document |
| --- | --- |
| Problem, priorities, scope, and product acceptance | This PRD |
| Screen behavior and journeys, including failures | [USER_JOURNEYS.md](USER_JOURNEYS.md) |
| Components, schema, API, auth, storage, deployment | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Capture, inference, geometry, asset formats and rendering | [CAPTURE_AND_3D.md](CAPTURE_AND_3D.md) |
| Seller routing, quotes, reservations, capture, reconciliation and refund | [PAYMENTS.md](PAYMENTS.md) |
| Milestones, concrete tests and release gates | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |
| Evidence, decisions, optional vendors, unresolved experiments | [REFERENCES_AND_DECISIONS.md](REFERENCES_AND_DECISIONS.md) |

Read these task-by-task. Specialized contracts elaborate this scope; conflicting changes must update both affected contracts. Status must not silently become a second PRD.

## 2. Problem and users

### Seller problem

An outgoing student/renter has several pieces to sell, a fixed departure date, and limited patience for separate negotiations. Photographs do not communicate dimensions well. Buyers reserve items they later discover do not fit. A seller wants fewer conversations, clear bundle contents and payment evidence, and an agreed pickup.

### Buyer problem

An incoming student/renter has an empty or partly furnished room, limited money, and a move-in window. Searching disconnected listings creates uncertainty about size, layout, compatibility, condition and logistics. A buyer wants to see a coherent, affordable arrangement using actual nearby items, including the furniture they are keeping.

### Primary personas and authority

- Buyer: owns their room capture, needs and layouts; can approve quotes and purchases for themselves.
- Seller: owns listings and captured item assets; can publish/withdraw, confirm bundle terms and manage orders for their configured seller profile.
- A person can be both buyer and seller. Ownership and merchant connection are checked per resource, not inferred from a single global role.
- Operator: manages the configured demo seller, failed jobs and payment reconciliation; accesses private media only for a consented support need, with an audit record.
- Worker service: processes approved jobs with limited storage/database access; cannot authorize payments or publish a listing by itself.

The first prototype demonstrates one buyer, one seller, one measured room and at least three independently captured sellable items. Additional seeded sellers may be shown for comparison only if checkout eligibility is explicit; they must not pretend to be payable merchants.

## 3. Goals, differentiation, and success

### Goals

1. Make the selected secondhand items recognizable inside the buyer's actual space.
2. Make dimensions, fit assumptions, price and handoff constraints inspectable before purchase.
3. Reduce seller/buyer work by assembling a coherent, available bundle.
4. Use actual AI inference in capture/inventory and preference-to-layout interaction.
5. Use PayPal for the core bundle purchase, with correct inventory and recovery behavior.
6. Work with a Galaxy S24 and an ordinary browser without depending on Apple RoomPlan.

### Differentiation hypothesis

Room design, used-furniture marketplaces, room packages and scanning already exist. The proposed differentiation is the complete link between an outgoing person's actual items and an incoming person's measured room, budget and moving dates. This is a hypothesis to test, not a claim of being the first room planner or scanner.

### Proposed product metrics

Track capture completion, listings reaching seller review, buyer layouts produced, layout edits, fit failures, quote acceptance, checkout completion, abandoned/expired reservations, refunds, handoff completion and user-reported fit issues. Capture event IDs and coarse timing, never raw room imagery in analytics.

For initial usability tests, measure time to produce an understandable purchasable setup, whether users correctly identify the purchased pieces, and whether they understand what has/has not been physically measured. Record sample size and baseline. No conversion or waste-reduction claims exist yet.

## 4. Scope and priority

### P0: complete hackathon prototype

- Responsive web app, authenticated buyer/seller workspaces and a native Android capture companion.
- One active incoming room per planning session; simple floor polygon without holes, existing-item obstacles, doors/windows and confirmed critical dimensions.
- Independent item capture/import with actual photos, dimensions, condition and a separately movable appearance asset.
- Guided photo/video capture, real live labels for supported furniture categories, manual confirmation/correction and failure recovery.
- Imported 3D assets are an acceptable first milestone. The complete prototype must visibly include actual inference and actual measured scene assets, not imply its entire reconstruction pipeline is automatic.
- At least one real structured preference/layout-model call, constrained to actual inventory and validated geometry. A model-disabled fallback stays usable but is not proof of the AI requirement.
- Three.js interactive room/item preview and synchronized measured top-down layout; placement, rotation, undo/redo and saved revisions.
- Budget/date/ownership/availability filtering and a coherent single-seller bundle.
- Seller-approved quote, buyer approval, PayPal sandbox create/capture, inventory reservation, authoritative payment state, receipt and recoverable cancellation/refund.
- Pickup coordination and buyer/seller acknowledgment; a placement guide accompanies the purchased bundle.
- Private source media, honest provenance labels, meaningful access control, accessible non-WebGL alternatives, tests and a reproducible demo.

### P1: planned extensions after P0 evidence

- Gaussian-splat room backdrop with aligned geometry proxies and mixed rendering.
- Live buyer AR placement with depth-based occlusion on the S24.
- Custom/open-vocabulary recognition beyond the standard detector vocabulary.
- More room shapes, richer item footprints and layouts, public comparison/sharing with consent, better transport matching and scene quality automation.
- Video semantic inventory using TwelveLabs if it improves the measured workflow.

### Production gates / P2

- Public multi-seller marketplace with approved merchant onboarding, production PayPal routing, currencies/taxes/policies and operational dispute handling.
- Multi-seller orders, platform commissions, shipping/logistics marketplaces, live money, public native app distribution, automatic reconstruction infrastructure at scale.
- iOS capture, arbitrary retailer inventory, autonomous purchasing and continuously editable room-wide splats.

These extensions are recorded to preserve the vision, not required parallel work. The first release uses USD, quantity-one used items and pickup. It does not hold escrow, fund a shared wallet, send Payouts to arbitrary student accounts, or certify accessibility/engineering safety.

## 5. Functional requirements

### Identity, privacy and navigation

| ID | Priority | Requirement and acceptance |
| --- | --- | --- |
| FR-01 | P0 | Web and Android authenticate against one managed identity provider. Server validates identity and ownership on every protected request. Signing in never grants operator or merchant authority. |
| FR-02 | P0 | Users see a concise capture/storage/AI-processing consent before uploading. Raw media is private by default. Public listings disclose only selected item photos, coarse location and pickup dates; no buyer room or exact address. |
| FR-03 | P0 | Home routes to Buy for my room or Sell my furniture. A user can switch modes without losing drafts. Errors preserve completed work and provide a specific next action. |

### Seller capture and inventory

| ID | Priority | Requirement and acceptance |
| --- | --- | --- |
| FR-04 | P0 | Seller can create a draft using photos, a guided video/photo session, or an imported reconstruction. Each sellable item has its own stable identity and appearance asset; no whole-scene automatic disassembly claim. |
| FR-05 | P0 | Live Android inference suggests supported labels and 2D boxes. User confirms, edits or ignores a suggestion. Unknown classes remain manually selectable. Inference never publishes or prices an item automatically. |
| FR-06 | P0 | Cross-frame suggestions are merged conservatively within a capture session; low-confidence association requires user confirmation. Five views of one chair cannot silently create five listings. |
| FR-07 | P0 | Seller confirms width/depth/height, front direction, measurement source, condition notes/photos, included parts and quantity one. Missing critical measurements block fit-qualified publication. |
| FR-08 | P0 | Processing exposes queued/processing/review/ready/failed state, actionable failure and retry. Imported assets have size/type/content validation and an explicit metric transform. A failed reconstruction does not fabricate a successful model. |
| FR-09 | P0 | Listing has server-stored price in integer USD cents, pickup window, coarse area, merchant eligibility and content version. Changes that affect an approved quote invalidate that quote; held/sold items cannot be silently edited into a different purchase. |

### Buyer room and requirements

| ID | Priority | Requirement and acceptance |
| --- | --- | --- |
| FR-10 | P0 | Buyer can capture/import a room or enter/correct its measured boundary. The guided S24 flow checks runtime support and allows manual entry when depth/permissions fail. |
| FR-11 | P0 | Buyer identifies kept furniture, fixed obstacles, door openings/swing, windows and preferred free areas. ARCore estimates are distinguishable from confirmed measurements. |
| FR-12 | P0 | Buyer sets budget, needed categories, preferences, move-in window, pickup availability and coarse search area. Money/dates/ranges are validated before matching. They can skip optional style preferences. |

### Matching, AI and measured layout

| ID | Priority | Requirement and acceptance |
| --- | --- | --- |
| FR-13 | P0 | Candidate items must be actually available, geographically/date compatible, within budget, from an eligible single seller, and have required dimensions. No invented SKU, image, merchant or price can enter checkout. |
| FR-14 | P0 | AI interprets bounded preferences and proposes item IDs and placement edits using structured output. The server checks schema, ownership, version, availability and geometry. Model prose cannot override a hard constraint. |
| FR-15 | P0 | Show up to three valid candidate arrangements with actual contents, total, fit findings, pickup terms and rejected-item explanations. If none is feasible, ask for the specific constraint the user can change; do not display a fake success. |
| FR-16 | P0 | Geometry checks operate in meters using confirmed footprint/height assumptions, room boundaries, kept objects and declared clearances. Separate PASS/WARN/FAIL/UNKNOWN findings; uncertainty is never styled as proven fit. |
| FR-17 | P0 | Dragging/rotating or a text instruction creates a new saved layout revision and reruns geometry/budget checks. Invalid drafts may be inspected, but cannot become a fit-approved quote. |

### Visual preview

| ID | Priority | Requirement and acceptance |
| --- | --- | --- |
| FR-18 | P0 | Browser preview displays the incoming room and independent selected item assets at recorded scale/orientation. Selecting an object opens the actual listing, photos, condition and price. |
| FR-19 | P0 | Top-down measured view and 3D view share one layout record. Numeric position/rotation controls and a keyboard/list alternative provide equivalent decisions without drag-only/WebGL-only interaction. |
| FR-20 | P0 | Appearance provenance is visible: scanned item, manufacturer/catalog asset, approximate proxy or illustrative render. Source photos remain accessible; a model's hidden surfaces are not inspection evidence. |
| FR-21 | P0 | Viewer handles loading, unsupported graphics, missing/corrupt assets and low-memory devices. It disposes GPU resources and switches to photos/top-down view without losing the user's layout. |
| FR-22 | P1 | Optional splat background and live AR preview use the same layout/scale record. Real-time rendering does not imply real-time final reconstruction or dimensional certification. |

### Quote, payment and handoff

| ID | Priority | Requirement and acceptance |
| --- | --- | --- |
| FR-23 | P0 | Seller approves exact item versions, total, agreed pickup slot and disclosed terms before a payable quote. Buyer approves that snapshot and layout revision; changes require a new quote. |
| FR-24 | P0 | Checkout atomically holds all quantity-one items for one buyer. A second buyer cannot pay for any overlapping item. Expiry and capture-unknown rules are governed by PAYMENTS.md. |
| FR-25 | P0 | Server creates/captures a PayPal sandbox order for the configured merchant using the approved snapshot. Browser amounts, merchant IDs and approval messages are untrusted. |
| FR-26 | P0 | Only authoritative completed capture with matching amount/currency/merchant/order identity produces PAID/SOLD. Timeouts, pending capture, verified webhook duplication and out-of-order delivery reconcile without double charge or premature release. |
| FR-27 | P0 | Buyer can resume checkout, cancel before capture, view processing status, and receive a receipt with purchased IDs and placement guide. A browser refresh preserves state. |
| FR-28 | P0 | Seller/operator can initiate a full sandbox refund of an actual capture. A request is not a completed refund; provider status drives it. Partial refunds are specified but deferred from P0. |
| FR-29 | P0 | Exact pickup information is revealed only to transaction participants at the documented stage. Paid items remain sold through pickup; handoff is acknowledged independently and does not masquerade as PayPal escrow release. |
| FR-30 | P0 | Buyer/seller can report unavailable/damaged/missing pieces and open a support case. No automatic claim that local pickup is covered by buyer/seller protection. Refunded items require seller inspection/explicit relisting. |

### Operations and lifecycle

| ID | Priority | Requirement and acceptance |
| --- | --- | --- |
| FR-31 | P0 | User can delete unneeded captures and room drafts; derivative assets follow retention/deletion rules. Financial records use separate restricted retention and minimal media links. |
| FR-32 | P0 | Operator can inspect processing/payment state and retry safe jobs with audit records. An operator action cannot forge paid state or bypass critical quote/measurement checks. |
| FR-33 | P0 | Analytics, logs and error reports exclude source frames, tokens, addresses and payment credentials. State changes have correlation IDs and redacted reasons. |

## 6. Product defaults and policy

- One seller per bundle, USD cents, no bidding, financing, escrow or platform fee in P0.
- Recommendations honor hard constraints first. Style is a soft preference. If budget/date/geometry conflict, the app asks; it never silently changes a hard constraint.
- Buyer sees fit relative to provided measurements, not an unqualified guarantee. Confirmed fields record source, actor, time and revision.
- Exact addresses and room media are private; listing search uses coarse area. A capture must not be silently added to public maps or used to train a third-party model.
- AI-generated condition claims, dimensions, prices, seller approval or payment status are prohibited.
- An operator/configured sandbox seller may seed demo listings. Fixtures and sandbox accounts must be labeled; a seed is not a real public marketplace participant.
- Checkout holds expire after 15 minutes while waiting for approval, subject to the non-releasable capture/reconciliation states in PAYMENTS.md. Seller-approved quotes expire after 24 hours or a listed item/version/date change, whichever occurs first.
- Prototype cancellations: buyer can abandon unpaid checkout; seller can withdraw unreserved inventory. Paid cancellations require a merchant-controlled refund workflow. Production cancellation/fee policies require separate selection and disclosure.

## 7. Nonfunctional requirements and proposed budgets

| ID | Target / requirement | Evidence needed |
| --- | --- | --- |
| NFR-01 | Responsive web at 360px and above, desktop viewer, landscape/portrait phone capture; no horizontal page overflow outside an intentional canvas. | Browser and S24 journeys. |
| NFR-02 | Keyboard navigation, readable contrast, labeled controls, status announcements and a photo/list/2D alternative to WebGL; no color-only fit findings. | Focus/keyboard and accessibility review. |
| NFR-03 | Initial demo scene targets <=30MB transferred, <=20MB per furniture GLB, <=2K textures by default; progressive load and compression budget measured. | Actual bytes and scene manifest. |
| NFR-04 | Target >=30fps median for the curated browser scene on tested S24/desktop, and live labels >=5 updates/sec with bounded inference queue; camera UI remains responsive. | Timings, device/browser versions and thermal run. Not promises. |
| NFR-05 | Normal authenticated metadata API requests target p95 <1 second under ten concurrent demo users; asynchronous jobs never block page requests. | Small documented load run. |
| NFR-06 | All private uploads/downloads require authorization and short-lived signed URLs; uploaded content is validated and external model resources are prohibited in P0. | Access-control and malicious-file cases. |
| NFR-07 | Payments survive process crash, retries and repeated events; no long database transaction around network calls; DB is source of reservation truth. | Race/crash/reconciliation tests. |
| NFR-08 | Runtime config and credential absence fail clearly; production payments remain disabled by default; sandbox labels are persistent. | Missing-config and live-mode gate tests. |
| NFR-09 | Resume drafts and interrupted uploads/jobs where feasible; canceled work stays canceled even after a worker finishes late. | Lifecycle recovery tests. |
| NFR-10 | Private raw media retention defaults to 30 days after the related draft/job is inactive, user deletion supported; originals linked to an active listing are retained with seller consent. | Retention job and asset lineage tests. |

Targets are adjustable after a measured feasibility result. Record any change and its user impact; do not relabel a failed target as already passed.

## 8. End-to-end acceptance

- AC-01: A seller scans/imports three real permitted items, reviews dimensions/condition and publishes eligible listings. An unsupported detector label can be corrected without losing capture.
- AC-02: A buyer records a room and kept bed, confirms a known length, enters needs/budget/date and obtains at least one feasible actual bundle.
- AC-03: One visually attractive but incompatible item is rejected for an inspectable geometry/date/budget reason. A corrected layout preserves identity, scale and price.
- AC-04: The buyer can select an item in both views, see original photos, move/rotate it, undo, reload and recover the same revision.
- AC-05: A real AI response is schema-validated; an invented item ID or infeasible edit is rejected. Actual live ML inference is demonstrated on the S24 with supported categories.
- AC-06: Seller and buyer approve an immutable single-seller quote; two concurrent checkout attempts for the same item produce at most one eligible active purchase.
- AC-07: PayPal sandbox capture changes the order to paid and purchased items to sold only after provider facts match the snapshot. Duplicate/replayed events do not duplicate effects.
- AC-08: A simulated capture timeout remains pending/reconciling without releasing inventory; an actual retrieved completed capture restores success after a restart.
- AC-09: Cancellation, failed payment and full refund have correct persistent states; a refunded item is not silently resold.
- AC-10: Buyer receives the placement guide and pickup details; both acknowledge handoff separately from payment. A private buyer room is inaccessible to another user and absent from public listing responses.
- AC-11: Graphics/capture permission failures have a usable alternative, and the principal journey is keyboard/list operable.
- AC-12: A clean clone has accurate setup instructions, configuration placeholders, curated fixture provenance and reproducible checks/demo. No credential/private capture is committed.

## 9. Open questions and ownership

Every open item is a bounded validation task, not a silent implementation choice: actual S24 depth/thermal behavior; scan exports and coordinate scale; accuracy against tape measurements; item reconstruction on thin/reflective surfaces; authentication account setup; available structured-output model ID/cost; private storage/hosting credentials; seller merchant readiness; hackathon submission dates/rules; and user demand. Owners, triggers, defaults and outcomes are maintained in REFERENCES_AND_DECISIONS.md and build_status.md.

This specification does not assert user interviews, worldwide novelty, actual scan quality, an accepted marketplace account, a tested model, or a deployed application. It gives the next agent concrete contracts and a build order with explicit evidence gates.
