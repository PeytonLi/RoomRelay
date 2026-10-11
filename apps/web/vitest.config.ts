import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

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
