import { z } from "zod";

/**
 * Capability-based server configuration (ARCHITECTURE.md A-07).
 * A capability is `available` only when every variable in its group is set;
 * otherwise `unavailable` reporting the missing variable NAMES (never values).
 * PAYPAL_ENVIRONMENT must be "sandbox" unless ALLOW_LIVE_PAYMENTS=true —
 * a live config without that flag is a config error.
 */

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

const groups = {
  database: ["DATABASE_URL"],
  identity: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"],
  objectStore: [
    "OBJECT_STORE_ENDPOINT",
    "OBJECT_STORE_REGION",
    "OBJECT_STORE_BUCKET",
    "OBJECT_STORE_ACCESS_KEY_ID",
    "OBJECT_STORE_SECRET_ACCESS_KEY",
  ],
  paypal: [
    "PAYPAL_ENVIRONMENT",
    "NEXT_PUBLIC_PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_WEBHOOK_ID",
    "PAYPAL_MERCHANT_ID",
  ],
  ai: ["AI_PROVIDER", "AI_API_KEY", "AI_TEXT_MODEL"],
} as const;

export type CapabilityName = keyof typeof groups;

export interface CapabilityState {
  status: "available" | "unavailable";
  missing: string[];
}

const baseSchema = z.object({
  DATABASE_URL: optionalString,
  ROOMRELAY_WEB_BASE_URL: optionalString,
  ROOMRELAY_API_BASE_URL: optionalString,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: optionalString,
  CLERK_SECRET_KEY: optionalString,
  CLERK_JWT_KEY: optionalString,
  OBJECT_STORE_ENDPOINT: optionalString,
  OBJECT_STORE_REGION: optionalString,
  OBJECT_STORE_BUCKET: optionalString,
  OBJECT_STORE_ACCESS_KEY_ID: optionalString,
  OBJECT_STORE_SECRET_ACCESS_KEY: optionalString,
  PAYPAL_ENVIRONMENT: z.enum(["sandbox", "live"]).optional().default("sandbox"),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_WEBHOOK_ID: optionalString,
  PAYPAL_MERCHANT_ID: optionalString,
  ALLOW_LIVE_PAYMENTS: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  AI_PROVIDER: optionalString,
  AI_API_KEY: optionalString,
  AI_TEXT_MODEL: optionalString,
  WORKER_CONCURRENCY: z.coerce.number().int().positive().optional().default(1),
});

export type ServerEnv = z.infer<typeof baseSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ServerConfig {
  env: ServerEnv;
  capabilities: Record<CapabilityName, CapabilityState>;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = baseSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(`invalid configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const env = parsed.data;

  if (env.PAYPAL_ENVIRONMENT === "live" && !env.ALLOW_LIVE_PAYMENTS) {
    throw new ConfigError(
      "PAYPAL_ENVIRONMENT=live requires ALLOW_LIVE_PAYMENTS=true; live payments are gated (A-07).",
    );
  }

  const capabilities = {} as Record<CapabilityName, CapabilityState>;
  for (const [name, vars] of Object.entries(groups) as [CapabilityName, readonly string[]][]) {
    const missing = vars.filter((v) => {
      const raw = source[v];
      return raw === undefined || raw.trim() === "";
    });
    capabilities[name] = missing.length === 0 ? { status: "available", missing: [] } : { status: "unavailable", missing };
  }

  return { env, capabilities };
}

let cached: ServerConfig | null = null;
export function getConfig(): ServerConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
