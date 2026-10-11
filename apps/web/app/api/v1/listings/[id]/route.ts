import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { getPublishedListing } from "@/lib/services/inventory";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const listing = await getPublishedListing(prisma, id);
  if (!listing) return apiError("NOT_FOUND", "listing not found", 404);
  return Response.json(listing);
}
