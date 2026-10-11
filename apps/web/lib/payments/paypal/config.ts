import type { ServerEnv } from "@/lib/env";
import { HttpPayPalClient } from "./client";
import type { PayPalEnvironment } from "./types";

export interface PayPalApiConfig {
  environment: PayPalEnvironment;
  clientId: string;
  clientSecret: string;
  merchantId: string;
  webhookId?: string;
  webBaseUrl: string;
  operatorIds: string[];
}

export function getPayPalApiConfig(
  source: Record<string, string | undefined> = process.env,
): PayPalApiConfig | null {
  const environment = source.PAYPAL_ENVIRONMENT || "sandbox";
  const clientId = source.NEXT_PUBLIC_PAYPAL_CLIENT_ID;
  const clientSecret = source.PAYPAL_CLIENT_SECRET;
  const merchantId = source.PAYPAL_MERCHANT_ID;
  const allowLive = source.ALLOW_LIVE_PAYMENTS === "true";
  if (
    (environment !== "sandbox" && environment !== "live") ||
    !clientId?.trim() ||
    !clientSecret?.trim() ||
    !merchantId?.trim() ||
    (environment === "live" && !allowLive)
  ) {
    return null;
  }
  return {
    environment,
    clientId,
    clientSecret,
    merchantId,
    ...(source.PAYPAL_WEBHOOK_ID?.trim() ? { webhookId: source.PAYPAL_WEBHOOK_ID.trim() } : {}),
    webBaseUrl: source.ROOMRELAY_WEB_BASE_URL?.trim() || "http://localhost:3000",
    operatorIds: (source.ROOMRELAY_OPERATOR_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

export function getPayPalClient(config: PayPalApiConfig | null): HttpPayPalClient | null {
  if (!config) return null;
  return new HttpPayPalClient({
    environment: config.environment,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
}

export function runtimeApiConfig(env: ServerEnv): PayPalApiConfig | null {
  return getPayPalApiConfig({
    PAYPAL_ENVIRONMENT: env.PAYPAL_ENVIRONMENT,
    NEXT_PUBLIC_PAYPAL_CLIENT_ID: env.NEXT_PUBLIC_PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
    PAYPAL_MERCHANT_ID: env.PAYPAL_MERCHANT_ID,
    PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID,
    ALLOW_LIVE_PAYMENTS: env.ALLOW_LIVE_PAYMENTS ? "true" : "false",
    ROOMRELAY_WEB_BASE_URL: env.ROOMRELAY_WEB_BASE_URL,
    ROOMRELAY_OPERATOR_IDS: env.ROOMRELAY_OPERATOR_IDS,
  });
}
