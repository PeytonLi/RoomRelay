# Primary references, decisions and open experiments

Checked 2026-10-10. Capabilities are documentation-backed; runtime quality/performance and user demand remain untested. Re-fetch current APIs/versions during implementation. These links are technical references, not connected retailer inventory or permission to upload private media.

## Source index

| ID | Primary source | What it supports |
| --- | --- | --- |
| SRC-01 | [ARCore supported devices](https://developers.google.com/ar/devices) | Galaxy S24 and Depth API support. |
| SRC-02 | [Samsung S24 camera specifications](https://www.samsung.com/us/explore/mobile/buying-guide/samsung-galaxy-s24-camera-specs-explained/) | Actual camera family; no advertised LiDAR assumption. |
| SRC-03 | [ARCore Depth](https://developers.google.com/ar/develop/java/depth/overview), [Raw Depth](https://developers.google.com/ar/develop/java/depth/raw-depth) | Motion depth, accuracy limitations and confidence/full-versus-raw distinctions. |
| SRC-04 | [ARCore fundamentals](https://developers.google.com/ar/develop/fundamentals), [anchors](https://developers.google.com/ar/develop/anchors), [hit tests](https://developers.google.com/ar/develop/hit-test) | Planes, scale/poses, stable-placement limits. |
| SRC-05 | [ARCore input for ML](https://developers.google.com/ar/develop/java/machine-learning) | CPU camera images in a native AR session. |
| SRC-06 | [ARCore/WebXR comparison](https://developers.google.com/ar/develop/webxr/arcore-comparison), [Instant Placement](https://developers.google.com/ar/develop/java/instant-placement/developer-guide) | Browser/native tradeoffs; initial estimated-distance limits. |
| SRC-07 | [Scene Semantics](https://developers.google.com/ar/develop/java/scene-semantics) | Outdoor semantics is not an indoor furniture detector. |
| SRC-08 | [MediaPipe detector](https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector), [Android](https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector/android), [COCO labels](https://raw.githubusercontent.com/tensorflow/models/master/research/object_detection/data/mscoco_label_map.pbtxt) | Live inference and actual trained categories/output boundaries. |
| SRC-09 | [ML Kit object detection](https://developers.google.com/ml-kit/vision/object-detection) | Tracking versus coarse standard labels. |
| SRC-10 | [Three.js glTF loader](https://threejs.org/docs/pages/GLTFLoader.html), [PBR materials](https://threejs.org/docs/pages/MeshStandardMaterial.html) | Rendering supplied geometry/assets. |
| SRC-11 | [Spark overview](https://sparkjs.dev/docs/overview/), [SplatMesh](https://sparkjs.dev/docs/splat-mesh/) | Splat/mesh coexistence and supported assets. |
| SRC-12 | [RealityScan Mobile](https://www.realityscan.com/mobile) | Android capture/coverage and external 3D export; not an assumed embedded API. |
| SRC-13 | [Niantic Capture](https://www.nianticspatial.com/products/capture), [Scaniverse FAQ](https://www.nianticspatial.com/faq/scaniverse), [cloud quickstart](https://www.nianticspatial.com/docs/scaniverse/quickstart/) | Android scanning and Classic/cloud workflow differences; processing is not always instant. |
| SRC-14 | [TwelveLabs video analysis](https://docs.twelvelabs.io/docs/guides/analyze-videos-and-images/videos), [quickstart](https://docs.twelvelabs.io/docs/get-started/quickstart) | Uploaded-video semantics/structured output; text streaming is not verified live spatial reconstruction. |
| SRC-15 | [PayPal standard Orders](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard.md), [Payments](https://developer.paypal.com/docs/api/payments/v2/) | Buyer approval, capture/refund records. |
| SRC-16 | [PayPal webhooks](https://developer.paypal.com/api/rest/webhooks/rest/), [idempotency](https://developer.paypal.com/api/rest/reference/idempotency/) | Authentication, retries and duplicate-safe operations. |
| SRC-17 | [PayPal platform overview](https://developer.paypal.com/platforms/overview), [Payouts](https://developer.paypal.com/docs/payouts/standard/) | Production approval/seller routing boundaries. |
| SRC-18 | [Next.js browser-only loading](https://nextjs.org/docs/app/guides/lazy-loading), [authentication](https://nextjs.org/docs/app/guides/authentication) | Client-only viewer and server authorization. |
| SRC-19 | [Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions) | Transactions/isolation and bounded conflict handling; verify selected-version API. |
| SRC-20 | [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) | Schema-constrained output is useful; app facts/geometry still need validation. |
| SRC-21 | [Clerk Android](https://clerk.com/docs/android/getting-started/quickstart), [SDK](https://github.com/clerk/clerk-android), [Next.js](https://clerk.com/docs/nextjs/getting-started/quickstart) | One managed identity for web/native; exact guidance in AUTH_REFERENCE.md. |
| SRC-22 | [IKEA room design controls](https://support.home-design.ikea.com/hc/en-us/articles/360038999793-What-can-I-design-in-my-space), [Redar packages](https://redar.com/student-furniture-packages), [FurnishUp](https://furnishup.ai/) | Adjacent competitors; room placement/packages are not globally new. |

Context7 was used for Three.js, Spark, ARCore, MediaPipe, ML Kit, Next.js, Prisma, PayPal and Clerk in the preceding/current research. TwelveLabs resolution returned unrelated libraries; official docs were used. No code or SDK was installed to validate these facts.

## Decision log

| ID | Decision / reason | Status / revisit trigger |
| --- | --- | --- |
| DEC-01 | Android/S24 first; user has Samsung, and official ARCore Depth support exists. | Accepted; revisit only for another requested platform. |
| DEC-02 | Separate actual room and independent item captures; whole-scene appearance is not movable inventory. | Accepted spatial invariant. |
| DEC-03 | Three.js textured mesh viewer first; maximize useful interactive fidelity before splat complexity. | Proposed default; validate real scans in M1. |
| DEC-04 | Spark/splat room backdrop and live buyer AR are P1. | Deferred until M5 core works. |
| DEC-05 | MediaPipe actual inference plus user confirmation; unknown category manual fallback. | Proposed default; validate S24/device/model licensing in M0/M4. |
| DEC-06 | Structured preference model proposes, deterministic app constraints decide. | Proposed default; evaluate current model ID/cost in M2. |
| DEC-07 | TwelveLabs optional for uploaded-video metadata, not geometry/tracking. | Deferred unless measured incremental value. |
| DEC-08 | Next.js/TypeScript, PostgreSQL/Prisma, private storage, low-volume DB-backed jobs. | Proposed defaults; lock compatible versions in M0. |
| DEC-09 | Clerk shared web/native identity; no homemade password/session service. | Docs verified, account/runtime test pending. |
| DEC-10 | One configured sandbox seller, single-seller USD bundles and pickup. | Accepted prototype boundary; production partner approval required to expand. |
| DEC-11 | Provider-completed facts, atomic stock holds and reconciliation are mandatory. | Accepted payment invariant. |
| DEC-12 | No publication of private scans, addresses, credentials or unrelated brainstorming. | Accepted public-repository boundary. |

## Bounded unresolved work

| ID / owner | Question and default | Resolving evidence / consequence |
| --- | --- | --- |
| OPEN-01 / implementation agent | Exact S24 runtime, depth and thermal behavior. Android guided/manual fallback is default. | M0/M4 known-length capture, capability logs and timing. Poor depth defers automatic geometry claims. |
| OPEN-02 / capture agent | RealityScan/Scaniverse actual export, item isolation/scale, asset quality. Import reviewed independent meshes first. | One room + three items with source-photo comparison and format/normalization proof. |
| OPEN-03 / spatial agent | Review tolerances and mobile rendering budgets. Defaults are explicit in CAPTURE_AND_3D.md. | Measure known fixtures/real room and document any budget revision; no silent guarantee. |
| OPEN-04 / implementation agent | Clerk project keys/Native API/callback and server token acceptance. Default stack verified. | Actual web/native same-user auth and cross-user negative test. No credentials presently exist. |
| OPEN-05 / AI agent | Available structured-output model, measured cost/latency and proposal validity. OpenAI provider adapter proposed. | Ten bounded tasks, refusal/adversarial cases, recorded model ID and actual usage. |
| OPEN-06 / backend agent | Host, DB/storage account, region and processing compute budget. One web + CPU worker proposed. | Real setup/cost/capability evidence; GPU reconstruction stays unimplemented until supplied. |
| OPEN-07 / payment agent | Sandbox seller/app/webhook credentials. Single controlled merchant default. | Actual create/capture/refund and verified webhook; mock-only flow cannot mark complete. |
| OPEN-08 / product owner | Current hackathon dates, full rules, team/time budget and submission format. Meaningful AI+PayPal requirements are supplied. | Verify official event rules before submission; do not invent deadline/prize eligibility. |
| OPEN-09 / product owner | Buyer/seller demand and distinction from existing room planners/resale services. | Interviews/usability measures and comparable workflow test; no global novelty claim. |
| OPEN-10 / product owner + backend | Live seller onboarding, policies, local pickup protection/taxes/operations, retention. Sandbox remains default. | Approved production access and disclosed reviewed policies before live commercialization. |

Unknowns are not all blocking the docs or initial viewer. Status should identify which specific next task actually needs user/device/account input and continue independent work.

## Sponsors: optional, justified by a task

Sponsor use is not a product requirement. The event's supplied sponsor list includes AG Grid, APIMatic, Astropods, Bryntum, Channel3, Elastic, Kernel, Postman, Render and Zapier. Their event references are on [the hackathon resource page](https://paypalaihackathon.devpost.com/resources); verify access/terms before use.

| Sponsor | Meaningful contribution / condition |
| --- | --- |
| Render | Web/API and CPU worker hosting; do not claim GPU reconstruction availability. |
| Elastic | Hybrid retrieval of a genuinely large image/metadata inventory; PostgreSQL filters suffice for the demo. |
| Bryntum | Actual shared pickup/mover/resource scheduling after logistics are implemented; unnecessary for one slot. |
| AG Grid | Operator reconciliation/review of enough jobs/orders to require a data grid. |
| APIMatic / Postman | API context/tooling or reproducible payment contract tests; not the product's AI proof. |
| Astropods | Agent runtime/observability if a deployed model workflow genuinely needs it. |
| Channel3 | Optional new-item alternatives later; catalog discovery does not imply used inventory or universal PayPal checkout. |
| Kernel | Authorized browser workflow only if a supported provider lacks an API; not permission bypass or automatic merchant access. |
| Zapier | Supported consented coordination/notifications after implemented core states; no assumed silent messaging bot. |

Keep all these out of P0 dependency requirements unless a concrete task benefits. A smaller functional prototype with real AI and correct PayPal integration is preferable to unused sponsor logos.
