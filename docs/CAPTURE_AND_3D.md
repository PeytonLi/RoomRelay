# Capture, AI vision, spatial fit and realistic rendering

Authority: [PRD.md](PRD.md), FR-04..22. This document owns spatial/asset contracts. Every performance number is a proposed validation target. No handset capture or rendering benchmark has been run.

## C-01: distinct responsibilities

| Layer | Input -> output | Correctness boundary |
| --- | --- | --- |
| Detection | Camera image -> category/confidence/2D box | Does not measure or reconstruct the object. |
| Association | Repeated views -> proposed item identity | IDs are local hypotheses until confirmed; occlusion can break tracking. |
| Segmentation | Image/views -> object mask | Box is not a precise mask; missing back remains missing. |
| Spatial tracking | Camera/motion -> pose, planes and supported depth | Metric estimates require confidence and real measurement checks. |
| Reconstruction | Overlapping multi-view evidence -> mesh/textures or splat | Cannot guarantee unobserved surfaces or scale from an arbitrary clip. |
| Layout validation | Confirmed footprints and constraints -> findings | Separate from model prose and visual realism. |
| Rendering | Approved geometry/appearance/transforms -> views | A convincing image is not physical measurement evidence. |

Never replace an item with a generic or AI-generated model without its provenance label. Never call a whole-room scan an automatically separated set of editable furniture assets.

## C-02: Galaxy S24 capture design

Google lists the S24 as ARCore/Depth API supported. Depth does not require LiDAR and is mainly estimated using camera movement. It is best roughly 0.5–5m away and can be weak on blank walls. ARCore planes/depth are building blocks; its outdoor Scene Semantics API is not an indoor furniture parser. Sources are indexed in REFERENCES_AND_DECISIONS.md.

On each native capture start:

1. Verify session/auth and chosen ROOM or ITEM draft.
2. Check camera permission, ARCore installation/support, depth runtime support, available memory/storage and recording configuration.
3. Show consent and capture instructions, then tracking state and nonmisleading coverage cues.
4. Use one ARCore camera session; acquire CPU images for inference rather than competing camera sessions. Respect image rotation, intrinsics, timestamp alignment and resource release.
5. Keep UI responsive; allow only one detector inference in flight, drop old frames and throttle. Proposed start is five inference updates/sec, tuned on the actual S24. Do not promise a universal frame rate.
6. Pause spatial recording on lost tracking; record the break and re-establish/verify the coordinate frame rather than pretending discontinuous poses are aligned.
7. User reviews selected item/room facts before upload. Offline drafts can queue upload; server state never claims an unuploaded session is processed.

Capture records device model/Android/app/model versions and capability results for debugging, without public device identifiers. Exact S24 variant, browser version and sustained thermal behavior must be measured in M0/M4.

### Live furniture recognition

Default: MediaPipe Object Detector with an officially compatible EfficientDet-Lite0 model. Standard COCO categories include chair, couch, bed and dining table; desk, wardrobe and door are not distinct classes in that vocabulary. User can manually correct/add categories. A category allowlist cannot create a category the model was not trained to detect.

Return candidate records `{frameTimeNs,classLabel,score,boxPx}`. These are not masks, dimensions, 3D poses or persistent object IDs. Proposed score threshold starts at 0.5 and is tuned using a labeled, consented test set; record false positives/negatives, not just a curated successful frame.

P0 association uses user-confirmed item selection and conservative session-local association (overlap/time/spatial evidence where available). Ask the user when multiple similar chairs or occlusion make identity ambiguous. Do not claim a stable cross-view identity solely from a detector label. ML Kit's default tracking has coarse classes; do not substitute it as a chair/sofa classifier without checking the actual model.

The live UI may label and guide capture immediately. Final detailed reconstruction can occur after capture. No prerecorded box overlay counts as live inference.

## C-03: capture subjects and ordinary uploads

### Incoming room

The buyer captures the actual room or usable empty area, identifies kept objects, and confirms its measured boundary. P0 supports a simple floor polygon <=12 vertices without holes, doors/openings, relevant windows, <=20 obstacle/free-zone polygons and known ceiling height when needed. Manual boundary/obstacle entry is always available. Estimated features require review, not blind automatic confirmation.

Room appearance and geometry are separate records. A backdrop can finish processing later while a valid measured plan is usable. A cluttered scene may require extra empty-area photos; existing furniture removal and unseen-wall reconstruction are not automatic P0 capabilities.

### Outgoing item

Capture each item independently, retaining original condition photos. Guide slow movement around visible sides, multiple heights, front orientation and a scale reference. Record inaccessible backs/undersides and missing parts. A video panned from one stationary position does not show other sides. Reflective/transparent surfaces, blank textures and thin legs may fail reconstruction and require review.

### Ordinary photo/video upload

Support the app's intake limits from ARCHITECTURE.md. A proposed video pipeline selects sharp overlapping frames, runs detection/association and optional segmentation, asks for item confirmation and reconstructs the selected subject. Do not promise that these stages exist merely because a video was uploaded.

Ordinary MP4 generally does not supply the ARCore pose/intrinsics/depth sidecar this app needs. Its spatial scale must be established separately. Guided still-photo capture can yield sharper texture evidence. P0 can import externally reconstructed items from RealityScan/Scaniverse after export/format/scale verification; neither external capture app is assumed to provide an embedded processing API.

## C-04: spatial coordinate and measurement contract

Canonical room frame is right-handed, meters, Y up, floor Y=0. X and Z lie in the floor plane; room origin/orientation is selected during confirmation and is not geographic north. Positive yaw is the right-handed rotation about Y, stored in radians. Viewer/control labels must be tested against a known orientation fixture.

Each item has a normalized local frame: bottom-footprint center at origin, width along X, height along Y, depth along Z; declared front points +Z. Placements use xM/zM/yawRad, with floor attachment at Y=0. Preserve the transform from source coordinates to canonical coordinates. Matrices are 16-number column-major homogeneous transforms when serialized; quaternions use x,y,z,w. Do not mix centimeters, millimeters and meters silently.

Room geometry schema:

```json
{
  "schemaVersion":1,
  "units":"m",
  "frameId":"room-frame-reference",
  "boundaryXZ":[[0,0],[3,0],[3,4],[0,4]],
  "ceilingHeightM":2.4,
  "doors":[{"id":"door-ref","openingXZ":[[0,0],[0.8,0]],"swingPolygonXZ":[],"confirmed":false}],
  "obstacles":[],
  "captureToRoomMatrix":null,
  "measurementRevision":1
}
```

Illustrative values only. A missing door sweep represented by an empty polygon stays unknown; it is not a zero-size safe door. Geometry validation rejects nonfinite/negative dimensions, self-intersecting polygons, inconsistent units, degenerate transforms and unsupported shape topology. Bound plausible sizes explicitly and ask for correction instead of coercing suspicious values.

Capture manifest, when spatial data exists: schema version; owner/session/frame IDs; image IDs/hashes/dimensions/orientation; capture timestamps; camera intrinsics `(fx,fy,cx,cy)` in matching pixel coordinates; camera-to-capture transforms; tracking state; depth/confidence asset references and their resolution/unit/endian convention; reconstruction/export provenance and source-to-room normalization. Do not copy raw depth into an unspecified byte array: document the exact format before implementation, including whether depth is camera-axis depth and how image pixels map to depth pixels. Optional data is explicitly absent, not filled with identity matrices as fabricated evidence.

Measurement evidence records source, value, actor, confirmation time and revision. A checkbox confirms user-reviewed numbers, not certified accuracy. Scan confidence does not equal a centimeter error interval. A known tape-measured length detects a scale mismatch but cannot fix all local drift or hidden obstructions.

## C-05: asset/provenance contract and processing

Appearance provenance enum: SCANNED_ACTUAL, CATALOG_EXACT_MATCH, APPROXIMATE_PROXY, ILLUSTRATIVE_GENERATED. Original item condition photos are always accessible from its listing. Catalog assets need exact model/variant matching and recorded license/source; otherwise classify as approximate. Generative hidden surfaces are never physical evidence.

Default render format: self-contained GLB with embedded permitted textures. Manifest includes hash/bytes, mesh bounds, axis/origin convention, normalization transform, dimensions/evidence reference, provenance, triangle/texture counts and processing version. Public asset responses expose only seller-approved item derivatives; private room assets require owner authorization.

Initial worker stages: validate file/signature/ownership -> inspect glTF and embedded resources -> strip unsafe/external references -> normalize orientation/scale -> crop/repair only with review -> optimize -> compute bounds -> generate thumbnail/manifest -> human review -> READY. Separate imported-asset conversion from automatic reconstruction; record which path was actually used.

Scale is calibrated from recorded source units/known measurements, not a language-model guess. Prefer uniform scale preserving shape. A proposed mismatch greater than max(0.02m, 5% of the confirmed axis length) on any axis triggers NEEDS_REVIEW; this threshold is a review heuristic, not an accuracy guarantee. Do not silently nonuniformly stretch the furniture until it fits the room.

Processing statuses: UPLOADED, QUEUED, PROCESSING, NEEDS_REVIEW, READY, FAILED, DELETING, DELETED. Queue jobs have their own lease/attempt state. Late outputs for deleted/replaced versions cannot become ready. Failed assets can be replaced with a labeled proxy/photo workflow, but exact scanned-preview acceptance requires actual usable assets.

Proposed budgets: intake GLB <=50MB; optimized item <=20MB; total curated viewer transfer <=30MB; default texture max2K. Use measured simplification/compression and preserve readable condition photos. Raise/revise budgets explicitly if scanning evidence warrants it. Do not simplify an item into a materially different silhouette without its provenance update.

## C-06: layout generation and fit

Hard constraints: actual item identity/version, one eligible seller, availability, total budget, compatible pickup/move-in dates, room boundary, kept-object/free-zone conflicts, known door sweep, height if relevant and confirmed critical dimensions. Transport path beyond recorded room entrances is UNKNOWN until separately measured; user must see that limitation.

Proposed initial geometry:

- Quantity-one rectangular conservative item footprints from confirmed width/depth, rotated by yaw; optional richer footprint later.
- Polygon containment and collision checks, with proposed 0.05m boundary/collision margin. Margin is a configurable prototype conservatism, not a verified sensor error bound.
- Door swing/free zones are protected polygons. Kept bed etc. have conservative footprints.
- Buyer-declared circulation preference (proposed default 0.75m) becomes an explicit clearance constraint if selected. It is not an accessibility/code certification.
- Height is checked when ceiling/overhang or item height is a critical limit; unknown critical height yields UNKNOWN.
- Soft preferences rank feasible layouts: useful-category coverage, contiguous work area, style/color preference and free-space preference. Soft preference cannot overcome hard constraints.

First candidate search is bounded: <=30 available candidate items, <=10 selected per layout; deterministic wall/corner anchors plus a 0.05m position grid in bounded regions and four right-angle orientations, then a capped search returning at most three validated alternatives. Do not exhaustively enumerate every subset/position. The text model can suggest additional placements, but every output passes the same independent validator. Record algorithm version, constraints and source item versions.

Findings use `{code,status,itemIds,geometryRefs,measuredValue?,threshold?,evidenceIds,message}` with status PASS/WARN/FAIL/UNKNOWN. Critical FAIL or UNKNOWN prevents a fit-approved quote; WARN requires acknowledgment and must not conceal a violated hard constraint. A valid layout says Fits provided measurements. The validator never asserts guaranteed delivery fit or structural suitability.

Transport outside the recorded room is explicitly unverified in P0 and shown as a disclosed noncritical assumption when the buyer handles pickup. If a buyer makes a transport path/doorway a hard requirement, missing measurements become critical UNKNOWN and block that quote. Do not silently label an unknown transport route as PASS.

Required tests: unit conversion; yaw/front orientation; boundary edge/tolerance; rotated overlaps; door sweep; kept-object exclusion; missing dimensions; budget/date conflict; no feasible layout; stale item/room version; adversarial model ID/position and repeated edits. Compare the same transform in 2D and 3D using a known fixture.

## C-07: viewer contract

Three.js loads independently optimized GLBs with physically based materials, environment lighting, tone mapping and appropriate shadows. The room model and top-down geometry share canonical transforms. Camera/orbit controls must avoid unusable clipping and expose reset/fit-to-room. Item selection opens its actual listing/provenance/photos, not a generated shopping link.

Support drag/rotation plus keyboard/numeric controls, clear selection/focus, undo/redo and asynchronous save with version conflict handling. Large scenes load progressively. Dispose materials/textures/geometries/controls/listeners on replacement/unmount; do not leak GPU memory across repeated room sessions. Unsupported WebGL or asset failure falls back to measured 2D and photos. Do not silently swap an unavailable purchased item for another model.

P0 realism is judged using actual source-photo/model comparison, recognizable item shapes, stable scale and coherent light/placement; there is no promise of indistinguishable photography. Review mobile texture/shadow settings against measured frame times. A synthetic fixture proves renderer behavior, not real reconstruction quality.

## C-08: optional splats, live AR and TwelveLabs

Spark can render room splats alongside conventional meshes in Three.js, including SPZ/PLY assets. For P1, align a splat backdrop and separate geometry proxy to the room frame. Fit and shadow/occlusion logic use verified geometry, not raw visual density. A room scan with existing furniture contains their appearance; removing it requires segmentation/editing plus handling missing surfaces. Relighting is additional work, not a normal mesh-lighting toggle.

Live buyer AR uses actual model dimensions, tested anchors and depth/plane hits. Instant Placement can start from an estimated distance and changing scale, so it is not the basis for fit measurement. Occlusion improves appearance but does not prove collision clearance. Phone/browser support is checked at runtime; native is the first target, WebXR optional.

TwelveLabs can optionally analyze uploaded video into inventory descriptions/timestamps/structured metadata. Its streamed generated text is not evidence of a continuous low-latency camera tracker, 3D measurements or mesh reconstruction. Add it only if a measured task improvement justifies the extra provider and cost.

## C-09: feasibility evidence required

Record the S24 model/runtime, 60-second room/item captures, a known-length comparison, weak-texture behavior, scan export format/bytes/scale, three source-photo/model comparisons, detector category/association failures, sustained inference/renderer timing and the exact browser used. Inputs require consent and remain private; public evidence is sanitized/synthetic/expressly consented.

If any experiment fails, state the fallback and what claim is deferred. Never demonstrate a preprocessed scene as an automatic live reconstruction without saying how it was made.
