import { NextResponse } from "next/server";
import { requestQuote } from "@/lib/payments/quotes";
import { parseBody, withPaymentPrincipal } from "@/lib/payments/http";
import { quoteBody } from "@/lib/payments/http-schemas";

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
        ...(line.conditionDisclosure === undefined ? {} : { conditionDisclosure: line.conditionDisclosure }),
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
