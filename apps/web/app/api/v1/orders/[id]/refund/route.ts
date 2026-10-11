import { NextResponse } from "next/server";
import { refundFull } from "@/lib/payments/refunds";
import { refundBody } from "@/lib/payments/http-schemas";
import { parseBody, withPaymentPrincipal } from "@/lib/payments/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withPaymentPrincipal(request, async ({ deps, principal }) => {
    const parsed = await parseBody(request, refundBody);
    if (!parsed.ok) return parsed.response;
    const { id } = await context.params;
    const actorRole = principal.userId === deps.config.operatorIds.find((operatorId) => operatorId === principal.userId)
      ? "operator"
      : "seller";
    const result = await refundFull({
      orderId: id,
      actorId: principal.userId,
      actorRole,
      requestKey: parsed.data.requestKey,
      reason: parsed.data.reason,
    }, deps);
    return NextResponse.json({
      checkout: { id: result.order.id, status: result.order.status },
      refund: {
        id: result.refund.id,
        status: result.refund.status,
        providerRefundId: result.refund.providerRefundId,
        debugId: result.refund.debugId,
      },
    });
  });
}
