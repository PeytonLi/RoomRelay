import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { getQuoteView } from "@/lib/services/quote-views";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const { id } = await context.params;
  const quote = await getQuoteView(prisma, auth.user.id, id);
  if (!quote) return apiError("NOT_FOUND", "quote not found", 404);
  return NextResponse.json({ quote });
}
