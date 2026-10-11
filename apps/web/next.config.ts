import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@roomrelay/spatial", "@roomrelay/assets", "@roomrelay/planning"],
};

export default nextConfig;
