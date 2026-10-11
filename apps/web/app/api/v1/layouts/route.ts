import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { createLayout } from "@/lib/services/layouts";
import { readJson, zodFieldErrors } from "@/lib/validation";

const layoutSchema = z.object({
  roomId: z.string().uuid(),
  roomRevision: z.number().int().positive(),
  parentId: z.string().uuid().optional(),
  placements: z.array(z.object({
    itemId: z.string().uuid(),
    listingVersion: z.number().int().positive(),
    xM: z.number().finite(),
    zM: z.number().finite(),
    yawRad: z.number().finite(),
  }).strict()).min(1).max(10),
  requirements: z.object({
    budgetCents: z.number().int().nonnegative().max(100_000_000),
    pickupFrom: z.string().datetime().transform((value) => new Date(value)),
    pickupTo: z.string().datetime().transform((value) => new Date(value)),
  }).refine((value) => value.pickupFrom < value.pickupTo, {
    path: ["pickupTo"],
    message: "pickupTo must be after pickupFrom",
  }).strict(),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = layoutSchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "layout is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await createLayout(prisma, auth.user, parsed.data);
  if (result.kind === "not-found") return apiError("NOT_FOUND", "room not found", 404);
  return Response.json(result, { status: 201 });
}
