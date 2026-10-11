import { z } from "zod";

/** App limits from ARCHITECTURE.md A-04 (app defaults, not vendor limits). */
export const LIMITS = {
  maxTextChars: 2000,
  maxCandidates: 30,
  maxPlacedItems: 10,
  maxListingCharsInPrompt: 600,
  maxRationaleChars: 600,
} as const;

const itemIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "item IDs are limited to [A-Za-z0-9._-]");

export const confirmedDimsSchema = z.strictObject({
  widthM: z.number().positive().max(20),
  depthM: z.number().positive().max(20),
  heightM: z.number().positive().max(10),
});

/** Inventory facts supplied by the server; never by the model or the browser. */
export const candidateItemSchema = z.strictObject({
  itemId: itemIdSchema,
  title: z.string().min(1).max(120),
  category: z.string().min(1).max(40),
  sellerId: itemIdSchema,
  sellerName: z.string().min(1).max(80),
  priceCents: z.number().int().nonnegative(),
  currency: z.literal("USD"),
  confirmedDimsM: confirmedDimsSchema.nullable(),
  /** Seller-written listing text. Untrusted data: delimited and never obeyed. */
  listingText: z.string().max(LIMITS.maxTextChars).default(""),
});
export type CandidateItem = z.infer<typeof candidateItemSchema>;

const placementInputSchema = z.strictObject({
  itemId: itemIdSchema,
  xM: z.number(),
  zM: z.number(),
  yawDeg: z.number(),
});

export const planningRequestSchema = z.strictObject({
  /** Buyer preferences, budget and dates as free text. */
  preferences: z.string().trim().min(1).max(LIMITS.maxTextChars),
  /** Optional hard budget cap checked server-side. */
  budgetMaxCents: z.number().int().positive().optional(),
  /** Optional current layout, for edit prompts ("move the desk..."). */
  currentLayout: z.array(placementInputSchema).max(LIMITS.maxPlacedItems).optional(),
});
export type PlanningRequest = z.infer<typeof planningRequestSchema>;

export const REASON_CODES = [
  "MEETS_REQUESTED_CATEGORY",
  "WITHIN_BUDGET",
  "FITS_ROOM",
  "SINGLE_SELLER",
  "MATCHES_PREFERENCES",
  "PICKUP_DATES_STATED",
  "EDIT_APPLIED",
] as const;

/** Strict model output contract (A-05). Unknown fields are rejected. */
export const modelProposalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  intent: z.enum(["PROPOSE_LAYOUT", "CLARIFY"]),
  selectedItems: z
    .array(z.strictObject({ itemId: itemIdSchema, priceCents: z.number().int().nonnegative() }))
    .max(LIMITS.maxPlacedItems),
  placements: z
    .array(
      z.strictObject({
        itemId: itemIdSchema,
        xM: z.number().min(-50).max(50),
        zM: z.number().min(-50).max(50),
        yawDeg: z.number().min(-360).max(360),
      }),
    )
    .max(LIMITS.maxPlacedItems),
  totalPriceCents: z.number().int().nonnegative(),
  constraintChanges: z
    .array(z.strictObject({ constraint: z.string().min(1).max(80), requestedChange: z.string().min(1).max(300) }))
    .max(5),
  clarification: z.string().min(1).max(400).nullable(),
  rationale: z.string().max(LIMITS.maxRationaleChars),
  reasonCodes: z.array(z.enum(REASON_CODES)).max(REASON_CODES.length),
});
export type ModelProposal = z.infer<typeof modelProposalSchema>;
