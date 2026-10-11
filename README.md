# RoomRelay

RoomRelay connects someone moving out with someone moving in: capture actual secondhand furniture, preview it in the incoming person's measured room, approve a usable bundle, and purchase it through PayPal.

**Status: specification only. No application, trained model, deployed service, or working payment integration exists in this repository yet.** The intended first device is a Samsung Galaxy S24. The prototype uses PayPal sandbox and one configured seller.

## Start here

1. [agent_handoff.md](agent_handoff.md): compact entry point for a new implementation agent.
2. [build_status.md](build_status.md): current evidence, next task, milestones, and blockers.
3. [Product requirements](docs/PRD.md): product contract, priorities, scope, and acceptance criteria.

## Read only what your task needs

| Work | Specification |
| --- | --- |
| Screens, behavior, and complete journeys | [User journeys](docs/USER_JOURNEYS.md) |
| Runtime components, hosting, data, API, and trust boundaries | [Architecture](docs/ARCHITECTURE.md) |
| Samsung capture, recognition, reconstruction, rendering, and spatial fit | [Capture and 3D](docs/CAPTURE_AND_3D.md) |
| Quotes, inventory reservations, PayPal, refunds, and handoff | [Payments](docs/PAYMENTS.md) |
| Build sequence, quality gates, test cases, and demo | [Implementation plan](docs/IMPLEMENTATION_PLAN.md) |
| Primary sources, optional sponsors, decision log, and unresolved experiments | [References and decisions](docs/REFERENCES_AND_DECISIONS.md) |

Requirements use stable IDs so build updates can cite a specific contract. `docs/PRD.md` owns product scope; the specialized files own their detailed contracts. `build_status.md` owns actual implementation progress. A planned feature is not evidence of an implemented feature.

No private room media, credentials, merchant identities, or customer information belongs in the public Git repository. Runtime assets live in private object storage; public demo assets must be synthetic or expressly licensed/consented.

## Development setup (M0)

Requirements: Node 20.19+, pnpm via `corepack enable`, PostgreSQL 18 (see `docker-compose.yml`, or a native install).

```sh
cp .env.example .env          # fill in DATABASE_URL at minimum
pnpm install
pnpm fixtures:fetch           # downloads the pinned public SheenChair.glb
pnpm db:migrate               # prisma migrate deploy + generate
pnpm dev                      # http://localhost:3000 (viewer) and /api/health
pnpm test                     # vitest across packages
pnpm test:e2e                 # playwright (chromium, software GL flags)
```

The Prisma schema and `prisma.config.ts` live in `apps/web/`; generated client
output goes to `apps/web/lib/generated/prisma` (gitignored).
