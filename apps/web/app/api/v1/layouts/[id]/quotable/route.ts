import { requireUser } from "@/lib/auth";
import { randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { evaluateLayoutForRequest } from "@/lib/services/layouts";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await evaluateLayoutForRequest(prisma, auth.user, id);
  if (result.kind === "not-found") return apiError("NOT_FOUND", "layout not found", 404);
  if (result.kind === "stale") {
    return apiError("STALE_VERSION", "room or listing version changed", 409, {
      fieldErrors: { versions: result.prefilterReasons.map((reason) => reason.code) },
    });
  }
  if (result.kind === "not-quotable") {
    return Response.json({
      code: "LAYOUT_NOT_QUOTABLE",
      message: "layout does not meet quoting requirements",
      retryable: false,
      correlationId: randomUUID(),
      findings: result.findings,
      reasons: result.prefilterReasons,
    }, { status: 422 });
  }
  return Response.json({ quotable: true, findings: result.findings, reasons: result.prefilterReasons });
}
