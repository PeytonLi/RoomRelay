# Implementation plan, gates and validation

Authority: [PRD.md](PRD.md). Actual progress is exclusively in [build_status.md](../build_status.md). This is a dependency-ordered plan, not a schedule commitment. The user's team size, deadline, provider accounts and budget have not been supplied. Build small complete slices; do not create every proposed package before it has code.

## Milestones

| Milestone | Depends on | Deliverable / exit gate |
| --- | --- | --- |
| M0: foundation and feasibility | Documentation | Reproducible web/database/Android toolchain; actual S24 capability and scan-export results; credential/account checklist; current versions locked. |
| M1: actual item in actual room | M0 | One confirmed room plus independent real item asset, interactive Three.js/2D preview, correct unit/origin/orientation, actual photos and provenance. |
| M2: seller/buyer data and AI planning | M1 | Private authenticated drafts, published inventory, candidate/intent model, hard constraints, saved layouts and versioned quote approvals. |
| M3: correct sandbox commerce | M2 | Atomic holds, PayPal create/approve/capture, authoritative receipt, real refund and replay/crash/race handling. |
| M4: live Android capture | M0; sync with M2 | Real live model labels on S24, guided room/item capture, manual corrections, ownership-safe upload/sync and measured device timing. |
| M5: complete prototype | M1..M4 | Seller-to-buyer-to-payment-to-pickup demo, accessible alternatives, privacy checks, setup/docs and truthful limits. |
| M6: enhanced realism / AR | M5 | Optional aligned splat backdrop, live buyer AR, improved categories and tested quality. |
| M7: production marketplace | Separate authorization/access | Approved seller onboarding/routing, real policies/operations, production money and rollout evidence. |

M4 live inference is required before calling the complete prototype real-time AI. It may run alongside M1/M2 development if resources permit, but the documents do not assume multiple agents or a team exists. M6 must not consume the time needed for correct inventory/payment behavior.

## Next concrete tasks

### T-001: bootstrap and evidence ledger

Read the compact handoff, status, PRD scope, ARCHITECTURE.md A-01/A-07 and AUTH_REFERENCE.md. Inspect local Node/package manager, Android Studio/SDK/JDK and Git state. Fetch current dependency docs, choose compatible stable versions and record them; do not silently install global tools or change unrelated projects.

Create the minimum web project, PostgreSQL schema/migration baseline, local configuration placeholders and a health/startup path. Add Android capture skeleton only with an actual compatible SDK/toolchain. Validate missing settings fail clearly. No invented credentials. Exit: clean setup instructions and a clean-clone startup proof, or an explicit missing prerequisite recorded in status.

### T-002: S24 capture/export spike

Test Google Play Services for AR/depth and a 60-second known-length scene. Try an Android capture tool for one room and one item; record exported format, bytes, axis/scale, processing time and provenance. Imported external-tool assets are fine, but no automatic app reconstruction claim. Required output is a reproducible comparison against tape measurements and a verified import path. If access to the phone/assets is unavailable, implement the measured/synthetic fixture path and record the device task as unrun.

### T-003: viewer vertical slice

Implement canonical units/frame and one independent item in the room. Add model loading, selection/photo inspection, floor-constrained movement, numeric rotation/position, synchronized top-down view, reset and explicit loading/error fallback. Test a known fixture for identical 2D/3D transforms and GPU disposal. Exit: real permitted asset recognizably placed at confirmed scale, with bytes/frame timing recorded.

### T-004: authenticated inventory and geometry

Implement Clerk ownership, private upload manifests/jobs, room measurement revisions, seller-reviewed listings and inventory persistence. Add deterministic fit/date/budget checks before AI. Implement optimistic conflict/version invalidation. Exit: cross-user reads fail, an invalid layout cannot quote, and listing/room edits cannot mutate approved facts.

### T-005: actual AI proposal

Select/configure the supported structured-output model and log its identifier/config/version and actual use. Implement bounded context and output schemas, clarification, invented-ID rejection and manual fallback. Test at least ten representative preference/edit prompts including adversarial seller text and impossible geometry. Exit: real provider inference changes a validated proposal; hard constraints remain authoritative.

### T-006: quote and payment

Implement PAYMENTS.md in its stated order: quote approvals -> atomic inventory hold -> provider create -> approval -> staged capture -> durable outcome -> verified webhooks/reconciliation -> refund. No shortcuts that mark paid in browser memory. Exit: actual sandbox capture/refund plus concurrency/replay/crash tests.

### T-007: native live inference and sync

Use one ARCore camera session and MediaPipe inference; support known categories and manual labels, conservative association, capability/permission errors and interrupted uploads. Confirm room/item geometry instead of assuming it from boxes. Test real Android session token against the API. Exit: live inference on S24 with recorded runtime/timing and successful ownership-safe capture sync; no prerecorded overlays.

### T-008: full flow and demo

Integrate approved quote, pickup slot, receipt/placement guide, participant acknowledgments and support/full refund. Run the complete journeys and minimum accessibility/privacy/recovery checks. Update status with evidence, exact checks, commits and deferred limitations. Publish a reproducible demo only with permitted assets and explicit sandbox status.

## Required test matrix

| ID | Layer | Case / invariant |
| --- | --- | --- |
| TEST-01 | Spatial | Meters/cm/mm normalization; Y-up/source axis; known yaw and front; unit mismatch rejected. |
| TEST-02 | Spatial | Rotated footprint containment, overlap, kept bed, door sweep, 0.05m margin and missing critical geometry. |
| TEST-03 | Planning | Budget/date/area constraints, no candidate, stale versions and one-seller rule. |
| TEST-04 | AI | Invalid JSON, invented item, hallucinated price, forbidden constraint change, refusal/timeout and malicious listing instruction. |
| TEST-05 | Auth/media | Native/web same identity, invalid token, cross-user room/order/asset request and exact-address exclusion. |
| TEST-06 | Assets | Corrupt/oversized model/video, external glTF references, missing texture, deleted/canceled late output and worker retry. |
| TEST-07 | Web/viewer | Reload saved revision; numeric/keyboard equivalence; WebGL failure; selection links to correct item; repeated scene disposal. |
| TEST-08 | Payments | Two buyers overlap; all-or-none hold; retry identity; client amount/merchant tampering; deadline/capture race. |
| TEST-09 | Payments | Timeout/crash before/after capture, pending state, DB failure after paid, verified duplicate/out-of-order events, bad signature. |
| TEST-10 | Refund/handoff | Full refund pending/completed/failed; no automatic restock; asymmetric pickup acknowledgments; support case. |
| TEST-11 | Device | S24 actual detection classes, association errors, lost tracking, denied permission, sustained inference/thermal behavior. |
| TEST-12 | Demo | Clean clone/setup, public media provenance, no secret/private captures and actual sandbox provider evidence. |

Use unit tests for geometry/money/schema invariants, PostgreSQL integration for transactions, provider contract mocks for faults, and Playwright/browser checks for user paths. Native instrumentation/manual device evidence complements host tests. Mock APIs do not replace actual sandbox/live-inference acceptance. Do not write tests that merely duplicate a static document or generated UI markup.

## Curated demonstration

Scenario: outgoing seller offers an actual desk, chair and shelf; incoming buyer has a measured room and kept bed, a fixed budget and compatible pickup dates. Prices and names are clearly illustrative until seed fixtures exist.

1. Show live S24 supported-category detection and a user correction for an unsupported category.
2. Review seller item dimensions/condition and actual assets. Disclose any external capture/import step.
3. Capture/import buyer room, confirm known length and kept bed.
4. Produce an actual AI-assisted bundle/layout. Reject one tempting incompatible option for a concrete reason.
5. Inspect/move an item; show matching 3D/top-down dimensions and source photo.
6. Seller and buyer approve the exact quote/slot. Complete PayPal sandbox approval/capture.
7. Show authoritative paid/sold state, placement guide and private pickup details.
8. Demonstrate refresh/reconciliation or duplicate-event safety, then a real sandbox full refund.

A short walkthrough can use preprocessed permitted scans, but must identify them as imported assets. Do not claim a full automatic reconstruction was performed live when it was not.

## Definition of done for each implementation task

- Relevant user behavior and callers work, with meaningful validation/errors and ownership.
- Contracts/schemas/migrations and fixtures affected by the change are updated together.
- Checks appropriate to the change run once successfully, or failures/unrun checks are explicitly recorded.
- Money/geometry/security/nontrivial pipeline logic has a meaningful test covering an important edge, not an implementation mirror.
- No real credentials, raw room media or unrelated research files are committed.
- `build_status.md` records files, evidence, commit, blockers and the next exact task. Requirements met are mapped by ID; partial work is not marked done.

## Release gates

M5 requires PRD AC-01..12 and the corresponding tests/evidence. Any exception is a documented scope change with user impact, not a silent downgrade. Before a production rollout, separately resolve seller approvals, production merchant setup, account permissions, local policies/tax/returns/disputes, privacy/retention/backups, asset/model licensing and operating cost. No live deployment or real money is authorized by the docs-only repository publication.
