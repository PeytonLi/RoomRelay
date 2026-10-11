# RoomRelay: agent handoff

## Purpose and present state

Build RoomRelay for the PayPal + AI hackathon: an outgoing person captures furniture for sale; an incoming person captures their room; the system proposes an actual available bundle, shows where its pieces go, and supports an approved PayPal purchase.

This repository begins with documentation only. Read [build_status.md](build_status.md) for the current evidence and next work item. Do not infer that dependencies, accounts, assets, an APK, a website, an AI integration, or payment credentials exist.

## Non-negotiable context

- The user's phone is a **Samsung Galaxy S24**, not an iPhone. Android is the first capture target.
- Realistic visualization is a core feature. Buyers must see the selected used items positioned in their actual room, with a measured layout behind the preview.
- Capture, detection, reconstruction, rendering, and fit checking are separate jobs. A label or a beautiful generated image cannot establish physical fit.
- Scan each sellable item independently. A seller's whole-room scan is not automatically a set of movable item models.
- Preserve confirmed dimensions and condition photos. Approximate appearance must be labeled; it cannot masquerade as the exact item.
- The first transaction has one configured PayPal sandbox seller, USD, pickup, and no platform money pool. Production seller onboarding and multi-seller payments are separate gates.
- Core AI must perform a real inference task; prerecorded overlays and hardcoded recommendations cannot be represented as live AI.
- TwelveLabs is optional uploaded-video understanding. It is not selected as the geometry or live bounding-box engine.
- A new agent should implement a complete small vertical slice before expanding scope, and update the status file using actual evidence.

## Context budget and authority

Do not load every document into the context window. Start with this file, [build_status.md](build_status.md), and the PRD's navigation and scope sections. Then read the relevant specialized document from [README.md](README.md).

Product scope is authoritative in [docs/PRD.md](docs/PRD.md). Detailed contracts are assigned to [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CAPTURE_AND_3D.md](docs/CAPTURE_AND_3D.md), [docs/PAYMENTS.md](docs/PAYMENTS.md), and [docs/USER_JOURNEYS.md](docs/USER_JOURNEYS.md). Build order and definition of done are in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). Sources, defaults, tradeoffs, and open experiments are in [docs/REFERENCES_AND_DECISIONS.md](docs/REFERENCES_AND_DECISIONS.md). Resolve contradictions explicitly; never silently weaken a payment, measurement, or privacy rule.

## First implementation assignment

Follow the next task in `build_status.md`: establish the reproducible web/Android foundation and run the S24 capture feasibility spike. Get one measured incoming room and independently captured item into an interactive browser preview before implementing a full reconstruction service. The complete milestone dependencies are in `docs/IMPLEMENTATION_PLAN.md`.

Honor the prototype/full-product distinction. Deferred features are specified so the vision survives handoff; they are not permission to build everything at once. Record measured results, errors, and unavailable credentials honestly.

## Working protocol

1. Inspect current code, Git state, applicable `AGENTS.md`, and status evidence before editing.
2. Claim one task in `build_status.md`; read its prerequisite contracts.
3. Fetch current API/SDK documentation with Context7 before library-specific work; use primary vendor docs when resolution fails. Do not pin guessed versions.
4. Implement, run meaningful checks, and keep credentials/private media outside Git.
5. Update status with files changed, commands/check results, commit, remaining concerns, and the next concrete task. Failed or unrun checks remain visible.

User authorization for this setup covered writing these specifications and creating/pushing a public GitHub repository. It did not create permission to publish private media, charge real accounts, or deploy live payments. Sandbox implementation is part of the specified build; live commercialization requires its documented gates.

## Suggested skills

- `context7-mcp`: current SDK and API documentation.
- `frontend-design` or `design`: a distinctive usable marketplace and 3D workspace.
- `mobile-design`: guided capture on an actual phone.
- `research`: bounded primary-source checks for uncertain model, device, or payment capabilities.
- `qa` / `playwright`: browser journeys and checkout recovery.
- `diagnose`: reproducible scanner, geometry, inference, or rendering failures.
- `handoff`: compact continuation pointers after a milestone.

Invoke available skills when relevant; inspect their instructions and follow direct user authorization over conflicting skill defaults. Avoid introducing deployment or approval flows merely because a skill is installed.
