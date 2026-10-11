import { defineConfig } from "vitest/config";

// Live provider eval: real network calls, never part of `pnpm test`.
export default defineConfig({
  test: {
    include: ["eval/**/*.live.ts"],
    environment: "node",
    testTimeout: 180_000,
    fileParallelism: false,
  },
});
