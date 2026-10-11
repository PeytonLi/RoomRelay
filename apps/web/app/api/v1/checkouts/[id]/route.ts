import { NextResponse } from "next/server";
import { withPaymentPrincipal } from "@/lib/payments/http";
import { getCheckout } from "@/lib/payments/holds";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withPaymentPrincipal(request, async ({ deps, principal }) => {
    const { id } = await context.params;
    const order = await getCheckout({ orderId: id, actorId: principal.userId }, deps);
    return NextResponse.json({
      checkout: {
        id: order.id,
        status: order.status,
        environment: order.environment,
        merchantId: order.merchantId,
        amountCents: order.amountCents,
        currency: order.currency,
        providerOrderId: order.providerOrderId,
        approveUrl: order.approveUrl,
        capturedCents: order.capturedCents,
        refundedCents: order.refundedCents,
        paidAt: order.paidAt?.toISOString() ?? null,
        hold: { state: order.hold.state, expiresAt: order.hold.expiresAt },
        quote: {
          id: order.quote.id,
          lines: order.quote.lines.map((line) => ({
            title: line.title,
            priceCents: line.priceCents,
            conditionDisclosure: line.conditionDisclosure,
          })),
        },
      },
    });
  });
}
