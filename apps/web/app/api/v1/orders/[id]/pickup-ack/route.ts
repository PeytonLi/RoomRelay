import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { acknowledgePickup } from "@/lib/services/orders";
import { readJson, zodFieldErrors } from "@/lib/validation";

const bodySchema = z.object({}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value ?? {});
  if (!parsed.success) return apiError("VALIDATION_ERROR", "body is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await acknowledgePickup(prisma, auth.user.id, id);
  if (result.kind === "not-found") return apiError("NOT_FOUND", "order not found", 404);
  if (result.kind === "not-paid") return apiError("ORDER_NOT_PAID", "order is not paid", 409);
  if (result.kind === "case-open") return apiError("CASE_OPEN", "an open support case blocks acknowledgment", 409);
  return Response.json({
    state: result.handoff.state,
    buyerAcknowledgedAt: result.handoff.buyerAcknowledgedAt,
    sellerAcknowledgedAt: result.handoff.sellerAcknowledgedAt,
  });
}
