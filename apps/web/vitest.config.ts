import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts", "lib/**/*.test.tsx", "test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
  },
});
