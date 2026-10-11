import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Not env("DATABASE_URL"): that helper throws at config-load time, which
    // breaks `prisma generate` (and `pnpm install` postinstall) on a fresh
    // clone before .env exists. An empty URL still makes `migrate deploy`
    // fail clearly, while generate never touches the datasource.
    url: process.env.DATABASE_URL ?? "",
  },
});
