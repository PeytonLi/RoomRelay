import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { getPrincipal, type Principal } from "@/lib/auth/principal";
import { getConfig } from "@/lib/env";
import { getPaymentDeps, type PaymentDeps } from "@/lib/payments/deps";
import { PaymentError } from "@/lib/payments/errors";

export type PaymentContext = { deps: PaymentDeps; principal: Principal };

export async function withPaymentPrincipal(
  request: Request,
  run: (context: PaymentContext) => Promise<Response>,
): Promise<Response> {
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
    const deps = getPaymentDeps();
    if (!deps) {
      const { capabilities: current } = getConfig();
      const missing = [
        ...current.paypal.missing,
        ...current.database.missing,
      ];
      return NextResponse.json({
        error: {
          code: "PAYMENTS_UNAVAILABLE",
          message: `PayPal payments are unavailable${missing.length ? `; missing: ${[...new Set(missing)].join(", ")}` : ""}`,
          retryable: false,
          correlationId,
        },
      }, { status: 503 });
    }
    const principal = await getPrincipal(request);
    if (!principal) {
      return NextResponse.json({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
          retryable: false,
          correlationId,
        },
      }, { status: 401 });
    }
    return await run({ deps, principal });
  } catch (error) {
    return paymentErrorResponse(error, correlationId);
  }
}

export async function withPaymentCapability(
  run: (deps: PaymentDeps) => Promise<Response>,
): Promise<Response> {
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
    const deps = getPaymentDeps();
    if (!deps) {
      return NextResponse.json({
        error: {
          code: "PAYMENTS_UNAVAILABLE",
          message: "PayPal payments are unavailable",
          retryable: false,
          correlationId,
        },
      }, { status: 503 });
    }
    return await run(deps);
  } catch (error) {
    return paymentErrorResponse(error, correlationId);
  }
}

export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const correlationId = randomUUID();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({
        error: {
          code: "VALIDATION",
          message: "Request body must be valid JSON",
          retryable: false,
          correlationId,
        },
      }, { status: 400 }),
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json({
        error: {
          code: "VALIDATION",
          message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
          retryable: false,
          correlationId,
        },
      }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}

export function paymentErrorResponse(error: unknown, correlationId = randomUUID()): Response {
  if (error instanceof PaymentError) {
    return NextResponse.json({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        correlationId,
      },
    }, { status: error.httpStatus });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({
      error: {
        code: "VALIDATION",
        message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
        retryable: false,
        correlationId,
      },
    }, { status: 400 });
  }
  return NextResponse.json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Payment request could not be completed",
      retryable: false,
      correlationId,
    },
  }, { status: 500 });
}
