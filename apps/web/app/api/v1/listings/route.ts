import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { listPublishedListings } from "@/lib/services/inventory";

export async function GET(): Promise<Response> {
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  return Response.json(await listPublishedListings(prisma));
}
