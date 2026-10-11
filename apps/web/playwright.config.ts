import { defineConfig } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "3100";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `pnpm dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      CLERK_SECRET_KEY: "",
      NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: "1",
      ROOMRELAY_TEST_IDENTITY: "enabled",
      NEXT_PUBLIC_PAYPAL_CLIENT_ID: "",
      PAYPAL_CLIENT_SECRET: "",
      PAYPAL_WEBHOOK_ID: "",
      PAYPAL_MERCHANT_ID: "",
    },
  },
});
