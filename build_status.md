# RoomRelay build status

Updated: 2026-10-11. Phase: **M0 in progress: web foundation and synthetic viewer slice in review ([PR #1](https://github.com/PeytonLi/RoomRelay/pull/1)); Android S24 probe in progress**. This file is the source of truth for actual progress, not a restatement of the PRD. The documentation is published in the verified public [PeytonLi/RoomRelay repository](https://github.com/PeytonLi/RoomRelay) on `main`; no application is deployed.

## Current evidence

| Work | State | Evidence / limit |
| --- | --- | --- |
| Product baseline and scope | Complete | [docs/PRD.md](docs/PRD.md), FR-01..33 / AC-01..12. |
| Journeys and UI states | Complete | [docs/USER_JOURNEYS.md](docs/USER_JOURNEYS.md), J-01..12. |
| Architecture, schema and API | Complete as specification | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); no code/schema migrations yet. |
| Capture, spatial/model/rendering contract | Complete as specification | [docs/CAPTURE_AND_3D.md](docs/CAPTURE_AND_3D.md); no real scan/phone benchmark yet. |
| Payment/recovery/hand-off contract | Complete as specification | [docs/PAYMENTS.md](docs/PAYMENTS.md); no sandbox credentials or transaction yet. |
| Authentication source check | Complete as research | [docs/AUTH_REFERENCE.md](docs/AUTH_REFERENCE.md); actual project and tokens untested. |
| Implementation sequence and test matrix | Complete as specification | [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). |
| Sources, defaults and open questions | Complete as research/planning | [docs/REFERENCES_AND_DECISIONS.md](docs/REFERENCES_AND_DECISIONS.md). |
| Documentation integrity | Complete | 12 Markdown files, 42 internal links and the 655-word handoff checked; required IDs, UTF-8, code fences, credential/private-path patterns and Git whitespace checks passed. |
| Public repository publication | Complete | GitHub reports PUBLIC / main; all 14 intended files are present remotely. Initial specification commit `bf4d759e539d435f0201657da5d876c8c5580738` matched the remote branch. |
| Web app / database / worker | IN_PROGRESS (PR #1) | Next.js 16 web app, Prisma 7 baseline migration, capability-aware env config, `/api/health`. Verified locally against native PostgreSQL 18 on a Windows VM; not deployed. No worker yet. |
| Android scanner / real ML inference | Not started | No APK, phone test, model benchmark or inference evidence exists. |
| 3D assets / reconstruction | IN_PROGRESS (PR #1) | Synthetic measured room fixture plus the public Khronos SheenChair (CC0, `APPROXIMATE_PROXY`, pinned SHA-256) in an interactive Three.js + 2D viewer with live fit checks and local GLB import. No real room or item scan has been imported yet. No reconstruction service exists. |
| Asset validation / job queue | IN_PROGRESS (in review) | CPU slice only: `validateGlb` + `buildAssetManifest` (packages/assets), Postgres leased `Job` queue (packages/jobs), `asset.validate` local-filesystem worker (workers/assets). Not wired to uploads or the Asset model; no S3, thumbnails, conversion or optimization. |
| PayPal / identity / cloud accounts | Not configured | Provider access is future implementation work. |
| Runtime tests / deployment | Partial (local) | PR #1: typecheck pass; vitest 35/35; Playwright 5/5 (Chromium, SwiftShader WebGL). No CI workflow and no deployment. |

## Next assignment

**T-002: S24 capture/export feasibility.** An ARCore capability and two-point tape-measurement probe APK is being built in a separate PR. It needs a physical Galaxy S24 run to produce evidence. After that, **import one tape-measured RealityScan/Scaniverse room and one item** through the viewer's local GLB path to complete M1 with real assets.

Owner: Devin (sessions https://app.devin.ai/sessions/a547e324f36d44d2ab61b3dd8d5494b9 and https://app.devin.ai/sessions/4a04b75b08da42f4b39555ced7549560 for Android).

## Session log

```text
Date / task / owner: 2026-10-11 / T-001 + T-003 / Devin
State and user-visible result: IN_PROGRESS (in review, PR #1). `pnpm dev` serves a measured-room preview: synthetic 3.4x4.0x2.5 m room (door swing, kept bed), approximate-proxy chair, drag/numeric/keyboard placement, synced SVG plan, live PASS/FAIL/UNKNOWN fit findings, local-only GLB import with dimension/units check, and a no-WebGL 2D fallback.
Files and commit: pnpm workspace (apps/web, packages/spatial, packages/assets), Prisma baseline 20261011035038_baseline, scripts/fetch-fixtures.mjs; branch devin/1791690062-m0-foundation-viewer, first reviewed tip 1e8f457/cea53d3.
Checks actually run and results: pnpm typecheck pass; vitest 35/35 (spatial 19, assets 6, web 10); Playwright 5/5 (default fit, bed collision, no-WebGL, 390px, selection-helper alignment); clean-clone setup verified on Windows + native PostgreSQL 18.
Requirements satisfied / remaining: TEST-01/02 geometry and transform equivalence covered with synthetic data. Remaining: real room/item capture, ESLint config (next lint was removed in Next 16), Clerk/PayPal/AI/storage stay `unavailable` placeholders.
Blocker or risk (if any): Docker Linux engine unavailable on the build VM (compose file is untested here). Fixture chair front direction (+Z) is assumed from visual inspection only.
Next task: T-002 S24 run of the probe APK; then a real scan import.
```

```text
Date / task / owner: 2026-10-11 / T-005 + TEST-04 / Devin (session https://app.devin.ai/sessions/fd9362af0cea4b77a3a133144d9a058a)
State and user-visible result: IN_PROGRESS (in review). POST /api/planning/proposal returns a real DeepSeek proposal for the synthetic fixture room + synthetic inventory: server-validated item IDs/placements/rationale, a clarification question, or a manual-placement fallback. Returns 503 `unavailable` (never a canned recommendation) when the AI capability is missing. Proposals live in the response only (no Prisma/schema change).
Files and commit: packages/planning (schema, provider, prompt, validate, propose, tests, eval/), apps/web/lib/planning.ts, apps/web/app/api/planning/proposal/route.ts, apps/web/fixtures/inventory.synthetic.json; branch devin/1791692441-t005-ai-proposal.
Checks actually run and results: pnpm typecheck pass (4 projects); vitest 72/72 (spatial 19, assets 6, planning 32, web 15); next build pass. LIVE eval `pnpm --filter @roomrelay/planning eval:live` against model id `deepseek-flash` (response model `deepseek-flash`, json_object, thinking disabled, temperature 0.2, 20s timeout): run 1 passed 10/13 cases, validated-proposal rate 5/7, 22 calls, 0 unsafe outputs accepted (failures: two spatial-FAIL repairs that fell back to manual placement, one malformed constraintChanges); after adding server-derived center-range hints and the constraintChanges shape to the prompt, run 2 passed 13/13, validated-proposal rate 7/7, first-call acceptance 11/13, 15 real calls, median latency 1.4s, 36,917 tokens, 0 unsafe outputs accepted. One real request through `next start` returned state `proposal`.
Requirements satisfied / remaining: FR-14 / A-05 structured contract with invented-ID, price, one-seller, budget and spatial (validateLayout) authority, one bounded repair, timeout/refusal/invalid-JSON handling, delimited untrusted listing text, per-call model/config/latency/token logs. Remaining: real inventory/room from the DB (route uses synthetic fixtures), UI for proposals, OPEN-05 provider choice is only exercised with DeepSeek, eval is 13 cases on one room and is not a statistical quality measure.
Blocker or risk (if any): Model output varies run to run (run 1 vs run 2). Spatial BOUNDARY_MARGIN uses a strict `<` with no float epsilon, so a placement exactly at the 0.05 m margin fails; prompt hints keep a 0.02 m buffer instead of changing packages/spatial. `rtk` is not installed on the Windows VM, so commands ran without it.
Next task: persist proposals once the schema owners land the layout tables; wire the proposal into the viewer.
```

```text
Date / task / owner: 2026-10-11 / TEST-06 asset worker (CPU slice) / Devin (session https://app.devin.ai/sessions/a420e29fb1b449cdb6d6237ac00c1304)
State and user-visible result: IN_PROGRESS (in review). No UI change. `validateGlb(bytes, limits)` returns OK/NEEDS_REVIEW/REJECTED with coded issues + stats (50 MiB cap before parsing, JSON size cap, prototype-pollution keys, external/traversal/oversized data URIs, dangling indices, accessor/bufferView/BIN ranges, PNG/JPEG header-only texture dims, >2K and required Draco/meshopt/basisu as NEEDS_REVIEW, bounded texture memory). `buildAssetManifest` emits hash/bytes, inspectGlb bounds, +Y up/+Z front/floor-center convention, uniform normalization transform, dimension check, evidenceRef, provenance, counts, processingVersion assets-cpu-1. `pnpm --filter @roomrelay/asset-worker start` processes `asset.validate` jobs from a local object root; it refuses to start unless ASSET_WORKER_DEV_ACCEPT_ALL_SUBJECTS=1 because no real SubjectVersionGuard exists yet.
Files and commit: packages/assets (validateGlb.ts, imageHeaders.ts, manifest.ts, testing/glbFixtures.ts, inspectGlb opt-in allowDataUris), packages/jobs (queue.ts, worker.ts, guard.ts, README), workers/assets (assetValidation.ts, objectReader.ts, main.ts), pnpm-workspace.yaml (+workers/*), apps/web/prisma/schema.prisma (Job + JobStatus block at EOF only, no relations), migration 20261011050955_jobs_queue; branch devin/1791694973-asset-worker, commits 6359241, 7266027, 0900e3c, eb90cc5.
Checks actually run and results: pnpm -r typecheck pass (6 projects). pnpm -r test with DATABASE_URL (local PostgreSQL 18.6): 146/146 (spatial 24, assets 50, planning 32, web 16, jobs 14, asset-worker 10). Without DATABASE_URL: 134 passed, 12 integration tests skipped with a message (jobs 10, asset-worker 2). Postgres integration covers concurrent leasing (no double lease), expired-lease reclaim, retry/backoff then FAILED, idempotent enqueue, cancelled/superseded/deleted late output discarded, crash-mid-job retry, heartbeat. prisma migrate dev against a fresh DB and the existing DB pass. pnpm --filter @roomrelay/web build pass. Worker smoke: refuses without dev guard; processes a synthetic GLB with it.
Requirements satisfied / remaining: TEST-06 corrupt/oversized model, external glTF refs, missing texture, deleted/cancelled late output and worker retry covered with programmatic synthetic fixtures (no binary blobs, no real scans). Remaining: upload finalization wiring to T-004's Asset model (enqueue on finalize, Asset-backed SubjectVersionGuard, publishing READY/NEEDS_REVIEW), S3 object reader, thumbnails, conversion/optimization, video validation, operator retry API.
Blocker or risk (if any): schema.prisma EOF block can conflict textually with T-004/T-006 appends (keep both). Financial jobs must never reuse this generic retry with a new idempotency key (packages/jobs/README.md).
Next task: after T-004's Asset model lands, implement the Asset-backed guard and enqueue asset.validate on upload finalization.
```

## Milestone ledger

| Milestone | State | Exit evidence |
| --- | --- | --- |
| M0 foundation/feasibility | IN_PROGRESS | Toolchain/config/known-length device and scan-export results. |
| M1 actual item in room | IN_PROGRESS (synthetic only) | Independent permitted asset, scale/orientation and interactive preview. |
| M2 data/AI planning | IN_PROGRESS (T-005 in review) | Real constrained DeepSeek call validated against synthetic fixtures; auth/private inventory/layout/quotes remain. |
| M3 sandbox commerce | TODO | Actual capture/refund plus race/recovery checks. |
| M4 live Android capture | TODO | Actual S24 live inference, guided capture and API sync. |
| M5 complete prototype | TODO | AC-01..12 with evidence and full demo. |
| M6 splat/AR enhancements | DEFERRED | Starts after M5 core evidence. |
| M7 production marketplace | GATED | Separate access, policy and authorization. |

## Open prerequisites and limits

- No exact S24 variant/runtime, permitted room/item assets or device performance result is available.
- No Clerk, PayPal sandbox or private storage configuration was created. AI: a DeepSeek key is used only from local ignored env (`apps/web/.env`) for T-005.
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
