export type PayPalEnvironment = "sandbox" | "live";

export interface PayPalLink {
  rel: string;
  href: string;
}

export interface PayPalCapture {
  id: string;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
  status_details?: { reason?: string };
  amount: { currency_code: string; value: string };
  custom_id?: string;
  invoice_id?: string;
}

export interface PayPalPurchaseUnit {
  reference_id?: string;
  custom_id?: string;
  invoice_id?: string;
  payee?: { merchant_id?: string };
  amount?: {
    currency_code: string;
    value: string;
    breakdown?: {
      item_total?: { currency_code: string; value: string };
      discount?: { currency_code: string; value: string };
    };
  };
  payments?: { captures?: PayPalCapture[] };
}

export interface PayPalOrder {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  purchase_units: PayPalPurchaseUnit[];
  links?: PayPalLink[];
  debugId?: string | undefined;
}

export interface PayPalRefund {
  id: string;
  status: "CANCELLED" | "FAILED" | "PENDING" | "COMPLETED";
  amount: { currency_code: string; value: string };
  debugId?: string | undefined;
}

export interface PayPalWebhookHeaders {
  "paypal-transmission-id": string;
  "paypal-transmission-time": string;
  "paypal-transmission-sig": string;
  "paypal-cert-url": string;
  "paypal-auth-algo": string;
}

export interface PayPalClient {
  readonly lastDebugId: string | undefined;
  createOrder(body: Record<string, unknown>, requestId: string): Promise<PayPalOrder>;
  getOrder(id: string): Promise<PayPalOrder>;
  captureOrder(id: string, requestId: string): Promise<PayPalOrder>;
  getCapture(id: string): Promise<PayPalCapture & { debugId?: string }>;
  refundCapture(captureId: string, body: Record<string, unknown>, requestId: string): Promise<PayPalRefund>;
  getRefund(id: string): Promise<PayPalRefund>;
  verifyWebhookSignature(input: {
    headers: PayPalWebhookHeaders;
    rawBody: string;
    webhookId: string;
  }): Promise<"SUCCESS" | "FAILURE">;
}
