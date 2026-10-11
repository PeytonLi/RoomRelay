import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { getConfig } from "@/lib/env";
import { apiError } from "@/lib/http";
import { resolveIssue } from "@/lib/services/orders";
import { readJson, zodFieldErrors } from "@/lib/validation";

const bodySchema = z.object({
  resolutionNote: z.string().trim().min(1).max(2000),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; caseId: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "resolution is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  const { id, caseId } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const operatorIds = (getConfig().env.ROOMRELAY_OPERATOR_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const result = await resolveIssue(
    prisma,
    { id: auth.user.id, isOperator: operatorIds.includes(auth.user.id) },
    id,
    caseId,
    parsed.data.resolutionNote,
  );
  if (result.kind === "not-found") return apiError("NOT_FOUND", "order or case not found", 404);
  if (result.kind === "forbidden") return apiError("FORBIDDEN", "only the seller or an operator can resolve a case", 403);
  if (result.kind === "already-resolved") return apiError("CASE_CLOSED", "case is already resolved", 409);
  return Response.json({ id: result.case.id, status: result.case.status, resolvedAt: result.case.resolvedAt, handoffState: result.handoff.state });
}
