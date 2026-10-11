import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { evaluateLayout } from "@/lib/prefilter";
import { candidateRoomContext, candidateListingFacts, findCandidatePlacement } from "@/lib/services/layouts";
import { readJson, zodFieldErrors } from "@/lib/validation";

const candidatesSchema = z.object({
  budgetCents: z.number().int().nonnegative().max(100_000_000),
  pickupFrom: z.string().datetime().transform((value) => new Date(value)),
  pickupTo: z.string().datetime().transform((value) => new Date(value)),
}).refine((value) => value.pickupFrom < value.pickupTo, {
  path: ["pickupTo"],
  message: "pickupTo must be after pickupFrom",
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = candidatesSchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "candidate request is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const room = await candidateRoomContext(prisma, auth.user, id);
  if (!room) return apiError("NOT_FOUND", "room not found", 404);
  const candidates = await candidateListingFacts(prisma);
  const result = candidates.map((facts) => {
    const listing = {
      itemId: facts.itemId,
      listingVersion: facts.listingVersion,
      title: facts.title,
      sellerId: facts.sellerId,
      priceCents: facts.priceCents,
      widthM: facts.widthM,
      depthM: facts.depthM,
      heightM: facts.heightM,
      pickupWindowStart: facts.pickupWindowStart.toISOString(),
      pickupWindowEnd: facts.pickupWindowEnd.toISOString(),
    };
    if (facts.priceCents > parsed.data.budgetCents) {
      return { ...listing, rejectionReason: "BUDGET_EXCEEDED" };
    }
    const overlaps = facts.pickupWindowStart <= parsed.data.pickupTo && facts.pickupWindowEnd >= parsed.data.pickupFrom;
    if (!overlaps) {
      return { ...listing, rejectionReason: "PICKUP_WINDOW_MISMATCH" };
    }
    const placement = findCandidatePlacement(room.geometry, facts);
    if (!placement) return { ...listing, rejectionReason: "NO_GEOMETRIC_FIT" };
    const evaluation = evaluateLayout({
      room: room.geometry,
      roomRevision: room.room.measurementRevision,
      currentRoomRevision: room.room.measurementRevision,
      placements: [placement],
      listingFacts: [facts],
      requirements: {
        budgetCents: parsed.data.budgetCents,
        pickupFrom: parsed.data.pickupFrom,
        pickupTo: parsed.data.pickupTo,
      },
    });
    return { ...listing, placement, findings: evaluation.findings };
  });
  return Response.json({ candidates: result });
}
