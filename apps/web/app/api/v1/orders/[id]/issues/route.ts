import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { openIssue } from "@/lib/services/orders";
import { readJson, zodFieldErrors } from "@/lib/validation";

const bodySchema = z.object({
  reason: z.enum(["UNAVAILABLE", "DAMAGED", "MISSING", "OTHER"]),
  affectedItemIds: z.array(z.string()).min(1).max(100),
  description: z.string().trim().min(1).max(2000),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "issue is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await openIssue(prisma, auth.user.id, id, parsed.data);
  if (result.kind === "not-found") return apiError("NOT_FOUND", "order not found", 404);
  if (result.kind === "not-paid") return apiError("ORDER_NOT_PAID", "order is not paid", 409);
  if (result.kind === "invalid-items") return apiError("INVALID_ITEMS", "affectedItemIds must be a subset of the order's items", 400);
  return Response.json({
    id: result.case.id,
    status: result.case.status,
    reason: result.case.reason,
    affectedItemIds: result.case.affectedItemIds,
    createdAt: result.case.createdAt,
  }, { status: 201 });
}
