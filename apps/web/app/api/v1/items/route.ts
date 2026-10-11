import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { createDraftItem, listOwnItems } from "@/lib/services/inventory";
import { readJson, zodFieldErrors } from "@/lib/validation";

const listingInput = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.string().trim().max(80).optional(),
  widthM: z.number().min(0).max(5).optional(),
  depthM: z.number().min(0).max(5).optional(),
  heightM: z.number().min(0).max(5).optional(),
  dimsConfirmed: z.boolean().optional(),
  conditionNotes: z.string().max(2000).optional(),
  conditionPhotoAssetIds: z.array(z.string().uuid()).optional(),
  priceCents: z.number().int().min(0).max(1_000_000).optional(),
  currency: z.literal("USD").optional(),
  pickupWindowStart: z.string().datetime().transform((value) => new Date(value)).optional(),
  pickupWindowEnd: z.string().datetime().transform((value) => new Date(value)).optional(),
  coarseArea: z.string().trim().max(120).optional(),
  exactPickupAddress: z.string().trim().max(500).optional(),
  provenance: z.enum(["SCANNED_ACTUAL", "CATALOG_EXACT_MATCH", "APPROXIMATE_PROXY", "ILLUSTRATIVE_GENERATED"]).optional(),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = listingInput.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "listing is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await createDraftItem(prisma, auth.user, parsed.data);
  return Response.json({ ...result.item, currentListing: result.listingVersion }, { status: 201 });
}

export async function GET(): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  return Response.json(await listOwnItems(prisma, auth.user));
}
