import { validateLayout, type LayoutFinding, type LayoutResult, type PlacedItem } from "@roomrelay/spatial";
import type { PlanningContext } from "./context";
import { modelProposalSchema, type CandidateItem, type ModelProposal } from "./schema";

export type RejectionCode =
  | "INVALID_JSON"
  | "SCHEMA_INVALID"
  | "INVENTED_ITEM"
  | "DUPLICATE_ITEM"
  | "PLACEMENT_MISMATCH"
  | "HALLUCINATED_PRICE"
  | "MULTIPLE_SELLERS"
  | "OVER_BUDGET"
  | "MISSING_DIMENSIONS"
  | "NO_ITEMS"
  | "SPATIAL_FAIL";

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export interface ValidatedPlacement {
  itemId: string;
  xM: number;
  zM: number;
  yawDeg: number;
  yawRad: number;
}

export interface ValidatedProposal {
  sellerId: string;
  sellerName: string;
  /** Item facts and prices come from inventory, never from model output. */
  items: Array<Pick<CandidateItem, "itemId" | "title" | "category" | "priceCents" | "currency" | "confirmedDimsM">>;
  totalPriceCents: number;
  placements: ValidatedPlacement[];
  layout: LayoutResult;
  /** Requested hard-constraint changes: never applied; need explicit user approval. */
  unappliedConstraintChanges: ModelProposal["constraintChanges"];
  reasonCodes: ModelProposal["reasonCodes"];
  /** Server-derived statements built only from validated facts. */
  facts: string[];
  /** Model prose; display only as labeled AI text, never as fact. */
  modelRationale: string;
}

export type OutputCheck =
  | { kind: "PROPOSAL"; proposal: ValidatedProposal }
  | { kind: "CLARIFICATION"; question: string; unappliedConstraintChanges: ModelProposal["constraintChanges"] }
  | { kind: "REJECTED"; rejections: Rejection[]; spatialFindings?: LayoutFinding[] };

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function parseModelJson(content: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return { ok: false, message: "output is not a JSON object" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, message: `output is not valid JSON (${(err as Error).message.slice(0, 120)})` };
  }
}

/** Server-side authority over the model's structured output (FR-14, A-05). */
export function checkModelOutput(content: string, ctx: PlanningContext): OutputCheck {
  const parsed = parseModelJson(content);
  if (!parsed.ok) return { kind: "REJECTED", rejections: [{ code: "INVALID_JSON", message: parsed.message }] };

  const schema = modelProposalSchema.safeParse(parsed.value);
  if (!schema.success) {
    return {
      kind: "REJECTED",
      rejections: schema.error.issues.slice(0, 10).map((i) => ({
        code: "SCHEMA_INVALID" as const,
        message: `${i.path.join(".") || "(root)"}: ${i.message}`,
      })),
    };
  }
  const out = schema.data;

  if (out.intent === "CLARIFY") {
    if (!out.clarification) {
      return { kind: "REJECTED", rejections: [{ code: "SCHEMA_INVALID", message: "intent CLARIFY requires a clarification question" }] };
    }
    if (out.selectedItems.length > 0 || out.placements.length > 0) {
      return { kind: "REJECTED", rejections: [{ code: "SCHEMA_INVALID", message: "intent CLARIFY must not select or place items" }] };
    }
    return { kind: "CLARIFICATION", question: out.clarification, unappliedConstraintChanges: out.constraintChanges };
  }

  const rejections: Rejection[] = [];
  const byId = new Map(ctx.candidates.map((c) => [c.itemId, c]));
  if (out.selectedItems.length === 0) rejections.push({ code: "NO_ITEMS", message: "PROPOSE_LAYOUT selected no items; use CLARIFY instead" });

  const selectedIds = new Set<string>();
  for (const sel of out.selectedItems) {
    if (selectedIds.has(sel.itemId)) rejections.push({ code: "DUPLICATE_ITEM", message: `item ${sel.itemId} selected twice` });
    selectedIds.add(sel.itemId);
    const inv = byId.get(sel.itemId);
    if (!inv) {
      rejections.push({ code: "INVENTED_ITEM", message: `item ${sel.itemId} is not in the candidate inventory` });
      continue;
    }
    if (sel.priceCents !== inv.priceCents) {
      rejections.push({
        code: "HALLUCINATED_PRICE",
        message: `item ${sel.itemId} price ${sel.priceCents} != inventory price ${inv.priceCents} cents`,
      });
    }
    if (!inv.confirmedDimsM) rejections.push({ code: "MISSING_DIMENSIONS", message: `item ${sel.itemId} has no confirmed dimensions; it cannot be placed` });
  }

  const placedIds = new Set<string>();
  for (const p of out.placements) {
    if (placedIds.has(p.itemId)) rejections.push({ code: "DUPLICATE_ITEM", message: `item ${p.itemId} placed twice` });
    placedIds.add(p.itemId);
    if (!byId.has(p.itemId)) rejections.push({ code: "INVENTED_ITEM", message: `placement for ${p.itemId}, which is not in the candidate inventory` });
    else if (!selectedIds.has(p.itemId)) rejections.push({ code: "PLACEMENT_MISMATCH", message: `item ${p.itemId} is placed but not selected` });
  }
  for (const id of selectedIds) {
    if (byId.has(id) && !placedIds.has(id)) rejections.push({ code: "PLACEMENT_MISMATCH", message: `item ${id} is selected but has no placement` });
  }

  const known = [...selectedIds].map((id) => byId.get(id)).filter((c): c is CandidateItem => c !== undefined);
  const inventoryTotal = known.reduce((s, c) => s + c.priceCents, 0);
  if (known.length === selectedIds.size && out.totalPriceCents !== inventoryTotal) {
    rejections.push({ code: "HALLUCINATED_PRICE", message: `totalPriceCents ${out.totalPriceCents} != inventory sum ${inventoryTotal}` });
  }
  const sellers = new Set(known.map((c) => c.sellerId));
  if (sellers.size > 1) {
    rejections.push({ code: "MULTIPLE_SELLERS", message: `items come from ${sellers.size} sellers (${[...sellers].join(", ")}); one seller per order` });
  }
  const budget = ctx.request.budgetMaxCents;
  if (budget !== undefined && inventoryTotal > budget) {
    rejections.push({ code: "OVER_BUDGET", message: `inventory total ${inventoryTotal} exceeds budget ${budget} cents` });
  }
  if (rejections.length > 0) return { kind: "REJECTED", rejections };

  const placements: ValidatedPlacement[] = out.placements.map((p) => ({ ...p, yawRad: (p.yawDeg * Math.PI) / 180 }));
  const placed: PlacedItem[] = placements.map((p) => {
    const inv = byId.get(p.itemId)!;
    return { id: inv.itemId, title: inv.title, dimsM: inv.confirmedDimsM!, placement: { xM: p.xM, zM: p.zM, yawRad: p.yawRad } };
  });
  // Spatial validation is the authority; the model's claim of fit is ignored.
  const layout = validateLayout(ctx.room, placed, { marginM: ctx.marginM });
  if (!layout.fitsProvidedMeasurements) {
    const bad = layout.findings.filter((f) => f.status !== "PASS");
    return {
      kind: "REJECTED",
      rejections: bad.map((f) => ({ code: "SPATIAL_FAIL" as const, message: `${f.status} ${f.code}: ${f.message}` })),
      spatialFindings: bad,
    };
  }

  const seller = known[0]!;
  const facts = [
    `${known.length} item${known.length === 1 ? "" : "s"} from one seller (${seller.sellerName}), total ${usd(inventoryTotal)} from listed prices.`,
    `${layout.verdict}: wall clearance, kept obstacles, door swing and item overlap checked by the spatial validator.`,
  ];
  if (budget !== undefined) facts.push(`Within the ${usd(budget)} budget cap.`);
  if (out.constraintChanges.length > 0) facts.push(`${out.constraintChanges.length} requested constraint change(s) were not applied.`);

  return {
    kind: "PROPOSAL",
    proposal: {
      sellerId: seller.sellerId,
      sellerName: seller.sellerName,
      items: known.map(({ itemId, title, category, priceCents, currency, confirmedDimsM }) => ({ itemId, title, category, priceCents, currency, confirmedDimsM })),
      totalPriceCents: inventoryTotal,
      placements,
      layout,
      unappliedConstraintChanges: out.constraintChanges,
      reasonCodes: out.reasonCodes,
      facts,
      modelRationale: out.rationale,
    },
  };
}
