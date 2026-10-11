# RoomRelay build status

Updated: 2026-10-11. Phase: **M0 in progress: web foundation and synthetic viewer slice in review ([PR #1](https://github.com/PeytonLi/RoomRelay/pull/1)); Android S24 probe in progress; T-006 sandbox implementation on its feature branch pending buyer approval**. This file is the source of truth for actual progress, not a restatement of the PRD. The documentation is published in the verified public [PeytonLi/RoomRelay repository](https://github.com/PeytonLi/RoomRelay) on `main`; no application is deployed.

## Current evidence

| Work | State | Evidence / limit |
| --- | --- | --- |
| Product baseline and scope | Complete | [docs/PRD.md](docs/PRD.md), FR-01..33 / AC-01..12. |
| Journeys and UI states | Complete | [docs/USER_JOURNEYS.md](docs/USER_JOURNEYS.md), J-01..12. |
| Architecture, schema and API | Complete as specification; T-006 implemented on feature branch | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); T-006 schema, migration and API routes are in `devin/1791692691-t006-payments`, not merged. |
| Capture, spatial/model/rendering contract | Complete as specification | [docs/CAPTURE_AND_3D.md](docs/CAPTURE_AND_3D.md); no real scan/phone benchmark yet. |
| Payment/recovery/hand-off contract | T-006 implementation and local tests complete; real capture/refund pending | [docs/PAYMENTS.md](docs/PAYMENTS.md), T-006 sandbox code and contract-mock tests; PayPal webhook delivery and real capture/refund are not yet evidenced. |
| Authentication source check | Complete as research | [docs/AUTH_REFERENCE.md](docs/AUTH_REFERENCE.md); actual project and tokens untested. |
| Implementation sequence and test matrix | Complete as specification | [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). |
| Sources, defaults and open questions | Complete as research/planning | [docs/REFERENCES_AND_DECISIONS.md](docs/REFERENCES_AND_DECISIONS.md). |
| Documentation integrity | Complete | 12 Markdown files, 42 internal links and the 655-word handoff checked; required IDs, UTF-8, code fences, credential/private-path patterns and Git whitespace checks passed. |
| Public repository publication | Complete | GitHub reports PUBLIC / main; all 14 intended files are present remotely. Initial specification commit `bf4d759e539d435f0201657da5d876c8c5580738` matched the remote branch. |
| Web app / database / worker | IN_PROGRESS (PR #1) | Next.js 16 web app, Prisma 7 baseline migration, capability-aware env config, `/api/health`. Verified locally against native PostgreSQL 18 on a Windows VM; not deployed. No worker yet. |
| Android scanner / real ML inference | Not started | No APK, phone test, model benchmark or inference evidence exists. |
| 3D assets / reconstruction | IN_PROGRESS (PR #1) | Synthetic measured room fixture plus the public Khronos SheenChair (CC0, `APPROXIMATE_PROXY`, pinned SHA-256) in an interactive Three.js + 2D viewer with live fit checks and local GLB import. No real room or item scan has been imported yet. No reconstruction service exists. |
| PayPal / identity / cloud accounts | Not configured | Provider access is future implementation work. |
| Runtime tests / deployment | T-006 local checks pass; no deployment | T-006 branch: typecheck pass; `pnpm test` 52/52; DB suite 12/12 on each of three consecutive runs against `roomrelay_test`; Playwright 9/9. `pnpm lint` exits 0 but is skipped because no ESLint flat config exists. No CI workflow or deployment. |

## Next assignment

**Immediate T-006 handoff:** Peyton to approve the created sandbox PayPal order in a browser, then run `pnpm paypal:sandbox-smoke --resume <paymentOrderId>` within the 15-minute inventory hold. Record actual capture/refund evidence before closing T-006; do not expire or delete the held checkout. After this handoff, continue **T-002: S24 capture/export feasibility**. An ARCore capability and two-point tape-measurement probe APK is being built in a separate PR. It needs a physical Galaxy S24 run to produce evidence. After that, **import one tape-measured RealityScan/Scaniverse room and one item** through the viewer's local GLB path to complete M1 with real assets.

Owner: Devin (sessions https://app.devin.ai/sessions/a547e324f36d44d2ab61b3dd8d5494b9 and https://app.devin.ai/sessions/4a04b75b08da42f4b39555ced7549560 for Android).

## Session log

```text
Date / task / owner: 2026-10-11 / T-006 / Devin
State and user-visible result: IN_PROGRESS pending buyer approval. Sandbox-only quote approvals, atomic inventory holds, PayPal order/capture/refund recovery, verified-webhook handling, reconciliation, capability-gated routes and unavailable-checkout UI are implemented on `devin/1791692691-t006-payments`. Real sandbox capture/refund evidence is PENDING buyer approval; webhook delivery is untested against PayPal.
Files and commit: implementation commit `e9cd124`; `apps/web/prisma/schema.prisma`, `apps/web/prisma/migrations/20261011120000_t006_payments/migration.sql`, `apps/web/lib/payments/`, `apps/web/lib/auth/principal.ts`, `apps/web/app/api/v1/`, `apps/web/app/checkout/[id]/page.tsx`, `apps/web/scripts/`, `apps/web/test/`, `apps/web/e2e/checkout-unavailable.spec.ts`, `apps/web/playwright.config.ts`, `apps/web/vitest.config.ts`, `.env.example`, `README.md`, `docs/PAYMENTS.md`, package manifests and lockfile.
Checks actually run and results: `pnpm typecheck` passed (assets, spatial, web); `pnpm test` passed 52/52 (assets 6, spatial 21, web 25; DB project used `roomrelay_test`); DB-only project passed 12/12 three consecutive times; `pnpm test:e2e` passed 9/9; `pnpm lint` exited 0 but skipped by design because ESLint flat config is absent. No-credentials sandbox smoke skipped as expected with PayPal credential variables blank; evidence: `C:\Users\Administrator\work\evidence\smoke-skip.txt`. Create-only smoke evidence: `C:\Users\Administrator\work\evidence\smoke-create-only.txt`. Test evidence: `C:\Users\Administrator\work\evidence\typecheck.txt`, `test.txt`, `db-run-1.txt`, `db-run-2.txt`, `db-run-3.txt`, `test-e2e.txt`, and `lint.txt`.
Requirements satisfied / remaining: T-006 schema, services, routes/UI, reconciliation, refund and contract-mock tests are implemented. Create-only sandbox result: PaymentOrder `51846069-af69-4cd2-b920-ebc101a4482d`, PayPal order `2XV818269K834882E`, PaymentOrder status `PROVIDER_CREATED`, PayPal status `PAYER_ACTION_REQUIRED`, debug ID `f47306434a47c`, approval URL host `www.sandbox.paypal.com`. The checkout and 15-minute hold are intact; capture/refund were not run. The sandbox REST app (app `APP-5KY29302BG101064V`) and business merchant ID `N23HW6TR93LLA` are configured locally; `PAYPAL_WEBHOOK_ID` remains unset. Peyton has sandbox PERSONAL buyer credentials and will perform approval; the buyer account is not an outstanding gap. Real sandbox capture/refund evidence is PENDING buyer approval. `<<CAPTURE_EVIDENCE>>` and `<<REFUND_EVIDENCE>>` remain placeholders until the lead's `--resume` run.
Blocker or risk (if any): A public HTTPS webhook URL, subscribed PayPal webhook and `PAYPAL_WEBHOOK_ID` are still needed; webhook delivery has not been tested against PayPal. Clerk identity is also still needed for authenticated API principals. Context7 was unavailable, so the already-verified current primary `developer.paypal.com` docs/OpenAPI contracts were used as the fallback.
Next task: Peyton to approve the pending sandbox order and run `pnpm paypal:sandbox-smoke --resume 51846069-af69-4cd2-b920-ebc101a4482d` within the 15-minute hold, then fill the capture/refund evidence placeholders; afterward complete the public webhook and Clerk setup.

Date / task / owner: 2026-10-11 / T-001 + T-003 / Devin
State and user-visible result: IN_PROGRESS (in review, PR #1). `pnpm dev` serves a measured-room preview: synthetic 3.4x4.0x2.5 m room (door swing, kept bed), approximate-proxy chair, drag/numeric/keyboard placement, synced SVG plan, live PASS/FAIL/UNKNOWN fit findings, local-only GLB import with dimension/units check, and a no-WebGL 2D fallback.
Files and commit: pnpm workspace (apps/web, packages/spatial, packages/assets), Prisma baseline 20261011035038_baseline, scripts/fetch-fixtures.mjs; branch devin/1791690062-m0-foundation-viewer, first reviewed tip 1e8f457/cea53d3.
Checks actually run and results: pnpm typecheck pass; vitest 35/35 (spatial 19, assets 6, web 10); Playwright 5/5 (default fit, bed collision, no-WebGL, 390px, selection-helper alignment); clean-clone setup verified on Windows + native PostgreSQL 18.
Requirements satisfied / remaining: TEST-01/02 geometry and transform equivalence covered with synthetic data. Remaining: real room/item capture, ESLint config (next lint was removed in Next 16), Clerk/PayPal/AI/storage stay `unavailable` placeholders.
Blocker or risk (if any): Docker Linux engine unavailable on the build VM (compose file is untested here). Fixture chair front direction (+Z) is assumed from visual inspection only.
Next task: T-002 S24 run of the probe APK; then a real scan import.
```

## Milestone ledger

| Milestone | State | Exit evidence |
| --- | --- | --- |
| M0 foundation/feasibility | IN_PROGRESS | Toolchain/config/known-length device and scan-export results. |
| M1 actual item in room | IN_PROGRESS (synthetic only) | Independent permitted asset, scale/orientation and interactive preview. |
| M2 data/AI planning | TODO | Auth/private inventory/layout/quotes and real constrained model call. |
| M3 sandbox commerce | IN_PROGRESS | T-006 code and local race/recovery tests pass; real capture/refund and PayPal webhook delivery evidence remain pending. |
| M4 live Android capture | TODO | Actual S24 live inference, guided capture and API sync. |
| M5 complete prototype | TODO | AC-01..12 with evidence and full demo. |
| M6 splat/AR enhancements | DEFERRED | Starts after M5 core evidence. |
| M7 production marketplace | GATED | Separate access, policy and authorization. |

## Open prerequisites and limits

- No exact S24 variant/runtime, permitted room/item assets or device performance result is available.
- T-006 sandbox app and business merchant configuration are present only in ignored local `apps/web/.env`; the sandbox personal account is available to Peyton for approval. No webhook endpoint/ID, Clerk, AI model or private storage configuration exists.
- No provider credentials belong in this file or Git. Use configuration placeholders and secret storage.
- No marketplace production approval, protection claim, live money or public app deployment exists.
- Model category limits, scan fidelity, geometry error, costs and user demand remain validation tasks. See OPEN-01..10 in REFERENCES_AND_DECISIONS.md.

## Session update protocol

At task start, record task ID/owner/state. At completion or interruption, record files changed, commit, actual checks and results, unmet requirements, blocking dependency if any, and next exact step. Use TODO, IN_PROGRESS, DONE, BLOCKED, DEFERRED or GATED. DONE requires the milestone's exit evidence.

Suggested entry format:

```text
Date / task / owner:
State and user-visible result:
Files and commit:
Checks actually run and results:
Requirements satisfied / remaining:
Blocker or risk (if any):
Next task:
```

Initial setup produced and published the specifications and compact handoff only. Documentation integrity and publication were checked on 2026-10-10. No feature or application test is marked successful based on a document. The next implementation task remains T-001, followed by T-002.
