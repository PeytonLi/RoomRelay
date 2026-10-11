import type {
  PayPalCapture,
  PayPalClient,
  PayPalEnvironment,
  PayPalOrder,
  PayPalRefund,
  PayPalWebhookHeaders,
} from "./types";

const BASE_URLS: Record<PayPalEnvironment, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

export function getPayPalApiBaseUrl(environment: PayPalEnvironment): string {
  return BASE_URLS[environment];
}

export class PayPalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly issue?: string,
    readonly providerName?: string,
    readonly debugId?: string,
  ) {
    super(`PayPal request failed (${status}${issue ? `: ${issue}` : ""})`);
    this.name = "PayPalHttpError";
  }
}

export class PayPalNetworkError extends Error {
  constructor(message = "PayPal network request failed") {
    super(message);
    this.name = "PayPalNetworkError";
  }
}

type ClientOptions = {
  environment: PayPalEnvironment;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type ProviderPayload = Record<string, unknown> & { debugId?: string | undefined };

export class HttpPayPalClient implements PayPalClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private token?: { value: string; expiresAt: number };
  private _lastDebugId: string | undefined;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = getPayPalApiBaseUrl(options.environment);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get lastDebugId(): string | undefined {
    return this._lastDebugId;
  }

  async createOrder(body: Record<string, unknown>, requestId: string): Promise<PayPalOrder> {
    return (await this.request("/v2/checkout/orders", "POST", body, requestId)) as unknown as PayPalOrder;
  }

  async getOrder(id: string): Promise<PayPalOrder> {
    return (await this.request(`/v2/checkout/orders/${encodeURIComponent(id)}`, "GET")) as unknown as PayPalOrder;
  }

  async captureOrder(id: string, requestId: string): Promise<PayPalOrder> {
    return (await this.request(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, "POST", {}, requestId)) as unknown as PayPalOrder;
  }

  async getCapture(id: string): Promise<PayPalCapture & { debugId?: string }> {
    return (await this.request(`/v2/payments/captures/${encodeURIComponent(id)}`, "GET")) as unknown as PayPalCapture & {
      debugId?: string;
    };
  }

  async refundCapture(
    captureId: string,
    body: Record<string, unknown>,
    requestId: string,
  ): Promise<PayPalRefund> {
    return (await this.request(
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      "POST",
      body,
      requestId,
    )) as unknown as PayPalRefund;
  }

  async getRefund(id: string): Promise<PayPalRefund> {
    return (await this.request(`/v2/payments/refunds/${encodeURIComponent(id)}`, "GET")) as unknown as PayPalRefund;
  }

  async verifyWebhookSignature(input: {
    headers: PayPalWebhookHeaders;
    rawBody: string;
    webhookId: string;
  }): Promise<"SUCCESS" | "FAILURE"> {
    const token = await this.accessToken();
    const h = input.headers;
    const body =
      `{"auth_algo":${JSON.stringify(h["paypal-auth-algo"])},` +
      `"cert_url":${JSON.stringify(h["paypal-cert-url"])},` +
      `"transmission_id":${JSON.stringify(h["paypal-transmission-id"])},` +
      `"transmission_sig":${JSON.stringify(h["paypal-transmission-sig"])},` +
      `"transmission_time":${JSON.stringify(h["paypal-transmission-time"])},` +
      `"webhook_id":${JSON.stringify(input.webhookId)},` +
      `"webhook_event":${input.rawBody}}`;
    const result = await this.send(
      `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    return result.payload.verification_status === "SUCCESS" ? "SUCCESS" : "FAILURE";
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const credentials = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
    const result = await this.send(
      `${this.baseUrl}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    const accessToken = result.payload.access_token;
    const expiresIn = result.payload.expires_in;
    if (typeof accessToken !== "string" || typeof expiresIn !== "number") {
      throw new PayPalNetworkError("PayPal returned an invalid OAuth response");
    }
    this.token = {
      value: accessToken,
      expiresAt: Date.now() + Math.max(1, expiresIn - 60) * 1000,
    };
    return accessToken;
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
    requestId?: string,
  ): Promise<ProviderPayload> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body) headers["Content-Type"] = "application/json";
    if (requestId) {
      headers["PayPal-Request-Id"] = requestId;
      headers.Prefer = "return=representation";
    }
    const result = await this.send(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { ...result.payload, ...(result.debugId === undefined ? {} : { debugId: result.debugId }) };
  }

  private async send(
    url: string,
    init: RequestInit,
  ): Promise<{ payload: ProviderPayload; debugId?: string }> {
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch {
      throw new PayPalNetworkError();
    }
    const debugId = response.headers.get("paypal-debug-id") ?? undefined;
    this._lastDebugId = debugId;
    const text = await response.text();
    let payload: ProviderPayload = {};
    if (text) {
      try {
        payload = JSON.parse(text) as ProviderPayload;
      } catch {
        if (response.ok) throw new PayPalNetworkError("PayPal returned an invalid response");
      }
    }
    if (!response.ok) {
      const details = Array.isArray(payload.details) ? payload.details : [];
      const first = details[0] as { issue?: string } | undefined;
      throw new PayPalHttpError(
        response.status,
        first?.issue,
        typeof payload.name === "string" ? payload.name : undefined,
        debugId,
      );
    }
    return {
      payload: { ...payload, ...(debugId === undefined ? {} : { debugId }) },
      ...(debugId === undefined ? {} : { debugId }),
    };
  }
}
