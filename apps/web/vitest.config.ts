import { defineConfig } from "vitest/config";

export default defineConfig({
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
