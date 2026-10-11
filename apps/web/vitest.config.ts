import { defineConfig } from "vitest/config";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://roomrelay:roomrelay-dev@localhost:5432/roomrelay_test";
process.env.TEST_DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  resolve: {
    alias: { "@": path.dirname(fileURLToPath(import.meta.url)) },
  },
  test: {
    include: ["lib/**/*.test.ts", "lib/**/*.test.tsx", "test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
  },
});
