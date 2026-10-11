import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { getOwnItem, patchItem } from "@/lib/services/inventory";
import { readJson, zodFieldErrors } from "@/lib/validation";

const patchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().max(80).nullable().optional(),
  widthM: z.number().min(0).max(5).optional(),
  depthM: z.number().min(0).max(5).optional(),
  heightM: z.number().min(0).max(5).optional(),
  dimsConfirmed: z.boolean().optional(),
  conditionNotes: z.string().max(2000).nullable().optional(),
  conditionPhotoAssetIds: z.array(z.string().uuid()).optional(),
  priceCents: z.number().int().min(0).max(1_000_000).optional(),
  currency: z.literal("USD").optional(),
  pickupWindowStart: z.string().datetime().transform((value) => new Date(value)).optional(),
  pickupWindowEnd: z.string().datetime().transform((value) => new Date(value)).optional(),
  coarseArea: z.string().trim().max(120).optional(),
  exactPickupAddress: z.string().trim().max(500).optional(),
  provenance: z.enum(["SCANNED_ACTUAL", "CATALOG_EXACT_MATCH", "APPROXIMATE_PROXY", "ILLUSTRATIVE_GENERATED"]).optional(),
}).strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const item = await getOwnItem(prisma, auth.user, id);
  if (!item) return apiError("NOT_FOUND", "item not found", 404);
  return Response.json(item);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = patchSchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "listing is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const { expectedVersion, ...input } = parsed.data;
  const result = await patchItem(prisma, auth.user, id, expectedVersion, input);
  if (result.kind === "not-found") return apiError("NOT_FOUND", "item not found", 404);
  if (result.kind === "locked") return apiError("ITEM_LOCKED", "item is locked", 409);
  if (result.kind === "stale") return apiError("STALE_VERSION", "item version is stale", 409);
  return Response.json({ item: result.item, currentListing: result.listingVersion });
}
