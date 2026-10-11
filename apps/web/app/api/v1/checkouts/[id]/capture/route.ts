import { NextResponse } from "next/server";
import { captureCheckout } from "@/lib/payments/checkout";
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
    const order = await captureCheckout({
      orderId: id,
      buyerId: principal.userId,
      providerOrderId: parsed.data.providerOrderId,
    }, deps);
    const operation = await deps.prisma.paymentOperation.findUnique({
      where: { orderId_type: { orderId: id, type: "CAPTURE" } },
      select: { debugId: true },
    });
    return NextResponse.json({
      checkout: { id: order.id, status: order.status, providerCaptureId: order.providerCaptureId, debugId: operation?.debugId },
    });
  });
}
