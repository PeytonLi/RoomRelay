import "dotenv/config";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? (() => {
    const databaseUrl = process.env.DATABASE_URL
      ? new URL(process.env.DATABASE_URL)
      : new URL("postgresql://roomrelay:roomrelay-dev@localhost:5432/roomrelay_test");
    databaseUrl.pathname = "/roomrelay_test";
    return databaseUrl.toString();
  })();
process.env.TEST_DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["lib/**/*.test.ts", "lib/**/*.test.tsx"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["test/db/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          globalSetup: ["./test/db/global-setup.ts"],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
