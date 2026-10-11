import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getConfig } from "@/lib/env";
import { PaymentError } from "@/lib/payments/errors";
import { paymentErrorResponse, withPaymentCapability } from "@/lib/payments/http";
import { receivePayPalWebhook } from "@/lib/payments/webhooks";

const requiredHeaders = [
  "paypal-transmission-id",
  "paypal-transmission-time",
  "paypal-transmission-sig",
  "paypal-cert-url",
  "paypal-auth-algo",
] as const;

export async function POST(request: Request) {
  const correlationId = randomUUID();
  try {
    const { capabilities } = getConfig();
    if (capabilities.paypal.status !== "available") {
      return NextResponse.json({
        error: {
          code: "PAYMENTS_UNAVAILABLE",
          message: `PayPal payments are unavailable; missing: ${capabilities.paypal.missing.join(", ")}`,
          retryable: false,
          correlationId,
        },
      }, { status: 503 });
    }
    return withPaymentCapability(async (deps) => {
      const headers = {} as Record<(typeof requiredHeaders)[number], string>;
      for (const header of requiredHeaders) {
        const value = request.headers.get(header);
        if (!value) throw new PaymentError("VALIDATION", "Required PayPal transmission headers are missing");
        headers[header] = value;
      }
      const rawBody = await request.text();
      const result = await receivePayPalWebhook({
        headers,
        rawBody,
      }, deps);
      return NextResponse.json(result);
    });
  } catch (error) {
    return paymentErrorResponse(error, correlationId);
  }
}
