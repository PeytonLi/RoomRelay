import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { getOwnLayout } from "@/lib/services/layouts";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const layout = await getOwnLayout(prisma, auth.user, id);
  if (!layout) return apiError("NOT_FOUND", "layout not found", 404);
  return Response.json(layout);
}
