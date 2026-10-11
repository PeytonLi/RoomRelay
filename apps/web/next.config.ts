import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.ROOMRELAY_E2E_SERVER === "1" ? ".next-e2e" : ".next",
  transpilePackages: ["@roomrelay/spatial", "@roomrelay/assets", "@roomrelay/planning"],
};

export default nextConfig;
