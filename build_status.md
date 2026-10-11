# RoomRelay build status

Updated: 2026-10-10. Phase: **specification complete; application not started**. This file is the source of truth for actual progress, not a restatement of the PRD. The documentation is published in the verified public [PeytonLi/RoomRelay repository](https://github.com/PeytonLi/RoomRelay) on `main`; no application is deployed.

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
| Web app / database / worker | Not started | No application dependencies, running service or schema exists. |
| Android scanner / real ML inference | Not started | No APK, phone test, model benchmark or inference evidence exists. |
| 3D assets / reconstruction | Not started | No private or public scan assets were supplied/imported. |
| PayPal / identity / cloud accounts | Not configured | Provider access is future implementation work. |
| Runtime tests / deployment | Not run | Documentation checks cannot satisfy application acceptance. |

## Next assignment

**T-001: bootstrap and evidence ledger**, then **T-002: S24 capture/export feasibility**. Read the task definitions in IMPLEMENTATION_PLAN.md and the relevant architecture/capture sections only. Establish compatible versions and a reproducible minimum web/database project; check actual Android tooling. Get a measured room/item import path and Three.js vertical slice before building a generalized reconstruction service.

Owner: unassigned until an implementation agent/user claims the task. Do not mark a task blocked merely because later credentials or phone evidence are missing; work on independent setup/fixtures and identify the exact dependency. No estimate/deadline is promised without team/time information.

## Milestone ledger

| Milestone | State | Exit evidence |
| --- | --- | --- |
| M0 foundation/feasibility | TODO | Toolchain/config/known-length device and scan-export results. |
| M1 actual item in room | TODO | Independent permitted asset, scale/orientation and interactive preview. |
| M2 data/AI planning | TODO | Auth/private inventory/layout/quotes and real constrained model call. |
| M3 sandbox commerce | TODO | Actual capture/refund plus race/recovery checks. |
| M4 live Android capture | TODO | Actual S24 live inference, guided capture and API sync. |
| M5 complete prototype | TODO | AC-01..12 with evidence and full demo. |
| M6 splat/AR enhancements | DEFERRED | Starts after M5 core evidence. |
| M7 production marketplace | GATED | Separate access, policy and authorization. |

## Open prerequisites and limits

- No exact S24 variant/runtime, permitted room/item assets or device performance result is available.
- No Clerk, PayPal sandbox, AI model or private storage configuration was created.
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
