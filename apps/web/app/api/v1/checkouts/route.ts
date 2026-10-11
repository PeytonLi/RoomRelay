import { NextResponse } from "next/server";
import { checkoutBody } from "@/lib/payments/http-schemas";
import { parseBody, withPaymentPrincipal } from "@/lib/payments/http";
import { startCheckout } from "@/lib/payments/holds";

export async function POST(request: Request) {
  return withPaymentPrincipal(request, async ({ deps, principal }) => {
    const parsed = await parseBody(request, checkoutBody);
    if (!parsed.ok) return parsed.response;
    const checkout = await startCheckout({
      buyerId: principal.userId,
      quoteId: parsed.data.quoteId,
      idempotencyKey: parsed.data.idempotencyKey,
    }, deps);
    return NextResponse.json({ checkout }, { status: 201 });
  });
}
