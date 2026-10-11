import { NextResponse } from "next/server";
import { createPayPalOrder } from "@/lib/payments/checkout";
import { emptyBody } from "@/lib/payments/http-schemas";
import { parseBody, withPaymentPrincipal } from "@/lib/payments/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withPaymentPrincipal(request, async ({ deps, principal }) => {
    const parsed = await parseBody(request, emptyBody);
    if (!parsed.ok) return parsed.response;
    const { id } = await context.params;
    const order = await createPayPalOrder({ orderId: id, buyerId: principal.userId }, deps);
    const operation = await deps.prisma.paymentOperation.findUnique({
      where: { orderId_type: { orderId: id, type: "CREATE" } },
      select: { debugId: true },
    });
    return NextResponse.json({
      checkout: {
        id: order.id,
        status: order.status,
        providerOrderId: order.providerOrderId,
        approveUrl: order.approveUrl,
        debugId: operation?.debugId,
      },
    });
  });
}
