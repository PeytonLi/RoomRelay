import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { finalizeUpload } from "@/lib/services/uploads";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await finalizeUpload(prisma, auth.user, id);
  if (result.kind === "not-found") return apiError("NOT_FOUND", "upload not found", 404);
  if (result.kind === "invalid-state") return apiError("UPLOAD_NOT_READY", "upload is not ready to finalize", 409);
  return Response.json({ assetId: result.assetId, visibility: "PRIVATE" }, { status: 201 });
}
