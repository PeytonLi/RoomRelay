import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@roomrelay/spatial", "@roomrelay/assets"],
};

export default nextConfig;
