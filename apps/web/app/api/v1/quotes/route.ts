import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { requestQuote } from "@/lib/payments/quotes";
import { listQuoteViews } from "@/lib/services/quote-views";
import { parseBody, withPaymentPrincipal } from "@/lib/payments/http";
import { quoteBody } from "@/lib/payments/http-schemas";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const role = new URL(request.url).searchParams.get("role");
  if (role !== "buyer" && role !== "seller") {
    return apiError("VALIDATION_ERROR", "role must be buyer or seller", 422, {
      fieldErrors: { role: ["must be buyer or seller"] },
    });
  }
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const quotes = await listQuoteViews(prisma, auth.user.id, role);
  return NextResponse.json({ quotes });
}

export async function POST(request: Request) {
  return withPaymentPrincipal(request, async ({ deps, principal }) => {
    const parsed = await parseBody(request, quoteBody);
    if (!parsed.ok) return parsed.response;
    const quote = await requestQuote({
      buyerId: principal.userId,
      sellerId: parsed.data.sellerId,
      lines: parsed.data.lines.map((line) => ({
        itemId: line.itemId,
        priceCents: line.priceCents,
      })),
      discountCents: parsed.data.discountCents,
      pickupSlot: {
        start: new Date(parsed.data.pickupSlot.start),
        end: new Date(parsed.data.pickupSlot.end),
      },
      ...(parsed.data.roomId === undefined ? {} : { roomId: parsed.data.roomId }),
      ...(parsed.data.layoutRevisionId === undefined
        ? {}
        : { layoutRevisionId: parsed.data.layoutRevisionId }),
      termsVersion: parsed.data.termsVersion,
    }, deps);
    return NextResponse.json({ quote }, { status: 201 });
  });
}
