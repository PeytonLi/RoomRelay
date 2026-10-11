import { NextResponse } from "next/server";
import { recordApproval } from "@/lib/payments/checkout";
import { providerOrderBody } from "@/lib/payments/http-schemas";
import { parseBody, withPaymentPrincipal } from "@/lib/payments/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withPaymentPrincipal(request, async ({ deps, principal }) => {
    const parsed = await parseBody(request, providerOrderBody);
    if (!parsed.ok) return parsed.response;
    const { id } = await context.params;
    const order = await recordApproval({
      orderId: id,
      buyerId: principal.userId,
      providerOrderId: parsed.data.providerOrderId,
    }, deps);
    return NextResponse.json({ checkout: { id: order.id, status: order.status } });
  });
}
