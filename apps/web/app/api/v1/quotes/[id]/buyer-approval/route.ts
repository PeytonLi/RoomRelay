import { NextResponse } from "next/server";
import { buyerApprovalBody } from "@/lib/payments/http-schemas";
import { parseBody, withPaymentPrincipal } from "@/lib/payments/http";
import { buyerApproveQuote } from "@/lib/payments/quotes";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withPaymentPrincipal(request, async ({ deps, principal }) => {
    const parsed = await parseBody(request, buyerApprovalBody);
    if (!parsed.ok) return parsed.response;
    const { id } = await context.params;
    const quote = await buyerApproveQuote({
      quoteId: id,
      buyerId: principal.userId,
      contentHash: parsed.data.contentHash,
      acknowledgedWarnings: parsed.data.acknowledgedWarnings,
    }, deps);
    return NextResponse.json({ quote });
  });
}
