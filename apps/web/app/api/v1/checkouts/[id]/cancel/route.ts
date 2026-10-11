import { NextResponse } from "next/server";
import { cancelCheckout } from "@/lib/payments/holds";
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
    const order = await cancelCheckout({ orderId: id, buyerId: principal.userId }, deps);
    return NextResponse.json({ checkout: { id: order.id, status: order.status } });
  });
}
