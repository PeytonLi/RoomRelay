import { NextResponse } from "next/server";
import { sellerApprovalBody } from "@/lib/payments/http-schemas";
import { parseBody, withPaymentPrincipal } from "@/lib/payments/http";
import { sellerApproveQuote } from "@/lib/payments/quotes";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withPaymentPrincipal(request, async ({ deps, principal }) => {
    const parsed = await parseBody(request, sellerApprovalBody);
    if (!parsed.ok) return parsed.response;
    const { id } = await context.params;
    const quote = await sellerApproveQuote({
      quoteId: id,
      sellerId: principal.userId,
      contentHash: parsed.data.contentHash,
    }, deps);
    return NextResponse.json({ quote });
  });
}
