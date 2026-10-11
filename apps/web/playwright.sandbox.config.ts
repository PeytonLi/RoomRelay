import { defineConfig } from "@playwright/test";

const PORT = process.env.SANDBOX_E2E_PORT ?? "3200";

// Opt-in, unmocked sandbox journey. Never part of CI: default playwright.config.ts
// only loads ./e2e, this config only loads ./e2e-sandbox. Requires the
// PAYPAL_SANDBOX_* env vars; the web server maps them onto the app env names.
export default defineConfig({
  testDir: "./e2e-sandbox",
  timeout: 300_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 30_000,
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      CLERK_SECRET_KEY: "",
      NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: "1",
      ROOMRELAY_TEST_IDENTITY: "enabled",
      AI_PROVIDER: "",
      AI_API_KEY: "",
      AI_TEXT_MODEL: "",
      PAYPAL_ENVIRONMENT: "sandbox",
      ROOMRELAY_WEB_BASE_URL: `http://localhost:${PORT}`,
      NEXT_PUBLIC_PAYPAL_CLIENT_ID: process.env.PAYPAL_SANDBOX_CLIENT_ID ?? "",
      PAYPAL_CLIENT_SECRET: process.env.PAYPAL_SANDBOX_CLIENT_SECRET ?? "",
      PAYPAL_MERCHANT_ID: process.env.PAYPAL_SANDBOX_MERCHANT_ID ?? "",
      // No public HTTPS URL exists, so no real sandbox webhook can be registered;
      // a placeholder satisfies the payment capability check while capture is
      // driven synchronously by the checkout return flow.
      PAYPAL_WEBHOOK_ID: "SANDBOX-E2E-NO-WEBHOOK",
    },
  },
});
