import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { getConfig } from "../env";
import { getPrisma } from "../db";
import { runtimeApiConfig, getPayPalClient, type PayPalApiConfig } from "./paypal/config";
import type { PayPalClient } from "./paypal/types";

export interface PaymentRuntimeConfig {
  environment: "sandbox" | "live";
  merchantId: string;
  webhookId?: string;
  webBaseUrl: string;
  operatorIds: string[];
}

export interface PaymentHooks {
  afterCaptureStaged?: () => Promise<void>;
  afterProviderCapture?: () => Promise<void>;
}

export interface PaymentDeps {
  prisma: PrismaClient;
  paypal: PayPalClient;
  config: PaymentRuntimeConfig;
  now?: () => Date;
  hooks?: PaymentHooks;
}

export type PaymentTx = Prisma.TransactionClient;

export function createPaymentDeps(
  prisma: PrismaClient,
  paypal: PayPalClient,
  config: PayPalApiConfig,
  now?: () => Date,
  hooks?: PaymentHooks,
): PaymentDeps {
  return {
    prisma,
    paypal,
    config: {
      environment: config.environment,
      merchantId: config.merchantId,
      ...(config.webhookId === undefined ? {} : { webhookId: config.webhookId }),
      webBaseUrl: config.webBaseUrl,
      operatorIds: config.operatorIds,
    },
    ...(now === undefined ? {} : { now }),
    ...(hooks === undefined ? {} : { hooks }),
  };
}

export function getPaymentDeps(): PaymentDeps | null {
  const { env, capabilities } = getConfig();
  if (capabilities.paypal.status !== "available") return null;
  const prisma = getPrisma();
  const apiConfig = runtimeApiConfig(env);
  if (!prisma || !apiConfig || !apiConfig.webhookId) return null;
  const paypal = getPayPalClient(apiConfig);
  if (!paypal) return null;
  return createPaymentDeps(prisma, paypal, apiConfig);
}

export function getSmokePaymentDeps(): PaymentDeps | null {
  const prisma = getPrisma();
  const apiConfig = runtimeApiConfig(getConfig().env);
  const directConfig = apiConfig ?? null;
  const paypal = getPayPalClient(directConfig);
  if (!prisma || !directConfig || !paypal) return null;
  return createPaymentDeps(prisma, paypal, directConfig);
}
