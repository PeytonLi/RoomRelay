import { createHmac } from "node:crypto";
import type { PayPalWebhookHeaders } from "../../lib/payments/paypal/types";

type CallType = "createOrder" | "getOrder" | "captureOrder" | "getCapture" | "refundCapture" | "getRefund" | "verifyWebhookSignature";
type Fault = { mode: "network-before" | "network-after" | "http"; status?: number; issue?: string };
type MockAmount = { currency_code: string; value: string };
type MockPurchaseUnit = {
  amount?: MockAmount;
  payee?: { merchant_id?: string };
  reference_id?: string;
  custom_id?: string;
  invoice_id?: string;
  payments?: { captures?: MockCapture[] };
};
type MockRequestBody = {
  purchase_units?: MockPurchaseUnit[];
  amount?: MockAmount;
};

type MockCapture = {
  id: string;
  status: "COMPLETED" | "PENDING" | "DECLINED" | "FAILED";
  amount: { currency_code: string; value: string };
  custom_id: string;
  invoice_id: string;
};

type MockOrder = {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  purchase_units: MockPurchaseUnit[];
  links: Array<{ rel: string; href: string }>;
  debugId: string;
};

type MockRefund = {
  id: string;
  status: "COMPLETED" | "PENDING" | "FAILED" | "CANCELLED";
  amount: { currency_code: string; value: string };
  debugId: string;
};

function response(payload: unknown, status = 200, debugId = "MOCK-DEBUG"): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": debugId },
  });
}

export class PayPalContractMock {
  readonly callLog: Array<{ type: CallType; requestId?: string; path: string }> = [];
  readonly verifiedBodies: string[] = [];
  private readonly orders = new Map<string, MockOrder>();
  private readonly captures = new Map<string, MockCapture>();
  private readonly refunds = new Map<string, MockRefund>();
  private readonly idempotency = new Map<string, string>();
  private readonly faults = new Map<CallType, Fault[]>();
  private readonly persistentFaults = new Map<CallType, Fault>();
  private readonly signedEvents = new Map<string, string>();
  private orderCount = 0;
  private captureCount = 0;
  private refundCount = 0;
  private captureOutcome: "COMPLETED" | "PENDING" | "DECLINED" = "COMPLETED";
  private refundOutcome: "COMPLETED" | "PENDING" | "FAILED" = "COMPLETED";
  private tamper: Record<string, { amountValue?: string; merchantId?: string; referenceId?: string }> = {};
  private eventCount = 0;

  get createdOrderCount(): number {
    return this.orderCount;
  }

  get createdRefundCount(): number {
    return this.refundCount;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input.toString());
    const path = url.pathname;
    const method = init.method ?? "GET";
    if (path === "/v1/oauth2/token") {
      if (init.headers && new Headers(init.headers).get("authorization") !== `Basic ${Buffer.from("mock-client:mock-secret").toString("base64")}`) {
        return response({ name: "AUTHENTICATION_FAILURE" }, 401);
      }
      return response({ access_token: "mock-access-token", token_type: "Bearer", expires_in: 3600 });
    }
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== "Bearer mock-access-token") {
      return response({ name: "AUTHENTICATION_FAILURE" }, 401);
    }
    const call = this.classify(method, path);
    if (!call) return response({ name: "RESOURCE_NOT_FOUND" }, 404);
    const requestId = headers.get("paypal-request-id") ?? undefined;
    this.callLog.push({ type: call, ...(requestId ? { requestId } : {}), path });
    const faultQueue = this.faults.get(call);
    const fault = faultQueue?.shift() ?? this.persistentFaults.get(call);
    if (fault?.mode === "network-before") throw new TypeError("mock network-before");
    if (fault?.mode === "http") {
      return response({
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: fault.issue ?? "MOCK_FAILURE", description: "mock provider error" }],
      }, fault.status ?? 422, `MOCK-DEBUG-${call}`);
    }
    if (path === "/v1/notifications/verify-webhook-signature") {
      const body = String(init.body ?? "");
      const marker = '"webhook_event":';
      const start = body.indexOf(marker);
      const rawBody = start < 0 ? "" : body.slice(start + marker.length, -1);
      this.verifiedBodies.push(rawBody);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return response({ verification_status: "FAILURE" });
      }
      const event = payload.webhook_event;
      const eventId = event && typeof event === "object" ? (event as Record<string, unknown>).id : undefined;
      const accepted = payload.webhook_id === "mock-webhook" &&
        typeof eventId === "string" &&
        typeof payload.transmission_sig === "string" &&
        this.signedEvents.get(payload.transmission_sig) === rawBody;
      return response({ verification_status: accepted ? "SUCCESS" : "FAILURE" });
    }

    if (["createOrder", "captureOrder", "refundCapture"].includes(call)) {
      if (!requestId || headers.get("prefer") !== "return=representation") {
        return response({ name: "VALIDATION_ERROR" }, 400);
      }
    }
    const result = await this.dispatch(call, path, init, requestId);
    if (fault?.mode === "network-after") throw new TypeError("mock network-after");
    return result;
  };

  approve(id: string): void {
    const order = this.requireOrder(id);
    order.status = "APPROVED";
  }

  setCaptureOutcome(outcome: "COMPLETED" | "PENDING" | "DECLINED"): void {
    this.captureOutcome = outcome;
  }

  completePendingCapture(id: string): void {
    const capture = this.captures.get(id);
    if (capture) capture.status = "COMPLETED";
    const order = [...this.orders.values()].find((candidate) =>
      candidate.purchase_units[0]?.payments?.captures?.some((entry: MockCapture) => entry.id === id));
    if (order) order.status = "COMPLETED";
  }

  setRefundOutcome(outcome: "COMPLETED" | "PENDING" | "FAILED"): void {
    this.refundOutcome = outcome;
  }

  completePendingRefund(id: string): void {
    const refund = this.refunds.get(id);
    if (refund) refund.status = "COMPLETED";
  }

  injectFault(callType: CallType, fault: Fault): void {
    const current = this.faults.get(callType) ?? [];
    current.push(fault);
    this.faults.set(callType, current);
  }

  injectPersistentFault(callType: CallType, fault: Fault): void {
    this.persistentFaults.set(callType, fault);
  }

  tamperNext(callType: CallType, values: { amountValue?: string; merchantId?: string; referenceId?: string }): void {
    this.tamper[callType] = values;
  }

  signEvent(rawBody: string): PayPalWebhookHeaders {
    this.eventCount += 1;
    const transmissionId = `mock-transmission-${this.eventCount}`;
    const transmissionTime = "2026-10-11T12:00:00Z";
    const webhookId = "mock-webhook";
    const signature = createHmac("sha256", "mock-webhook-secret")
      .update(`${transmissionId}|${transmissionTime}|${webhookId}|${rawBody}`)
      .digest("base64");
    this.signedEvents.set(signature, rawBody);
    return {
      "paypal-auth-algo": "HMAC-SHA256",
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/cert",
      "paypal-transmission-id": transmissionId,
      "paypal-transmission-sig": signature,
      "paypal-transmission-time": transmissionTime,
    };
  }

  private classify(method: string, path: string): CallType | null {
    if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
      return "verifyWebhookSignature";
    }
    if (method === "POST" && path === "/v2/checkout/orders") return "createOrder";
    if (method === "GET" && /^\/v2\/checkout\/orders\/[^/]+$/.test(path)) return "getOrder";
    if (method === "POST" && /^\/v2\/checkout\/orders\/[^/]+\/capture$/.test(path)) return "captureOrder";
    if (method === "GET" && /^\/v2\/payments\/captures\/[^/]+$/.test(path)) return "getCapture";
    if (method === "POST" && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(path)) return "refundCapture";
    if (method === "GET" && /^\/v2\/payments\/refunds\/[^/]+$/.test(path)) return "getRefund";
    return null;
  }

  private async dispatch(call: CallType, path: string, init: RequestInit, requestId?: string): Promise<Response> {
    const body = init.body ? JSON.parse(String(init.body)) as MockRequestBody : {};
    if (call === "createOrder") {
      const key = `createOrder:${requestId}`;
      let id = this.idempotency.get(key);
      if (!id) {
        this.orderCount += 1;
        id = `MOCK-ORDER-${this.orderCount}`;
        this.idempotency.set(key, id);
        const purchase: MockPurchaseUnit = structuredClone(body.purchase_units?.[0] ?? {});
        const tamper = this.tamper.createOrder;
        if (tamper?.amountValue && purchase.amount) purchase.amount.value = tamper.amountValue;
        if (tamper?.merchantId && purchase.payee) purchase.payee.merchant_id = tamper.merchantId;
        if (tamper?.referenceId) purchase.reference_id = tamper.referenceId;
        delete this.tamper.createOrder;
        this.orders.set(id, {
          id,
          status: "CREATED",
          purchase_units: [purchase],
          links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
          debugId: "MOCK-CREATE-DEBUG",
        });
      }
      return response(this.requireOrder(id), 201, "MOCK-CREATE-DEBUG");
    }
    if (call === "getOrder") {
      return response(this.requireOrder(decodeURIComponent(path.split("/").pop()!)));
    }
    if (call === "captureOrder") {
      const id = decodeURIComponent(path.split("/").at(-2)!);
      const order = this.requireOrder(id);
      const key = `captureOrder:${requestId}`;
      let captureId = this.idempotency.get(key);
      if (!captureId) {
        if (order.status !== "APPROVED") {
          return response({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
        }
        this.captureCount += 1;
        captureId = `MOCK-CAPTURE-${this.captureCount}`;
        this.idempotency.set(key, captureId);
        const unit = order.purchase_units[0]!;
        const tamper = this.tamper.captureOrder;
        const capture: MockCapture = {
          id: captureId,
          status: this.captureOutcome,
          amount: {
            currency_code: "USD",
            value: tamper?.amountValue ?? unit.amount!.value,
          },
          custom_id: unit.custom_id!,
          invoice_id: unit.invoice_id!,
        };
        delete this.tamper.captureOrder;
        this.captures.set(captureId, capture);
        unit.payments = { captures: [capture] };
        order.status = this.captureOutcome === "DECLINED" ? "COMPLETED" : "COMPLETED";
        if (tamper?.merchantId && unit.payee) unit.payee.merchant_id = tamper.merchantId;
        if (tamper?.referenceId) unit.reference_id = tamper.referenceId;
      }
      return response(order, 201, "MOCK-CAPTURE-DEBUG");
    }
    if (call === "getCapture") {
      const capture = this.captures.get(decodeURIComponent(path.split("/").pop()!));
      return capture ? response(capture) : response({ name: "RESOURCE_NOT_FOUND" }, 404);
    }
    if (call === "refundCapture") {
      const captureId = decodeURIComponent(path.split("/").at(-2)!);
      const key = `refundCapture:${requestId}`;
      let id = this.idempotency.get(key);
      if (!id) {
        if (!this.captures.has(captureId)) return response({ name: "RESOURCE_NOT_FOUND" }, 404);
        this.refundCount += 1;
        id = `MOCK-REFUND-${this.refundCount}`;
        this.idempotency.set(key, id);
        this.refunds.set(id, {
          id,
          status: this.refundOutcome,
          amount: body.amount!,
          debugId: "MOCK-REFUND-DEBUG",
        });
      }
      return response(this.refunds.get(id), 201, "MOCK-REFUND-DEBUG");
    }
    const refund = this.refunds.get(decodeURIComponent(path.split("/").pop()!));
    return refund ? response(refund) : response({ name: "RESOURCE_NOT_FOUND" }, 404);
  }

  private requireOrder(id: string): MockOrder {
    const order = this.orders.get(id);
    if (!order) throw new Error(`Mock order ${id} not found`);
    return order;
  }
}
