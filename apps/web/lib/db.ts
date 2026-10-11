import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { getConfig } from "./env";

let client: PrismaClient | null = null;

export function getPrisma(): PrismaClient | null {
  const { env, capabilities } = getConfig();
  if (capabilities.database.status !== "available" || !env.DATABASE_URL) return null;
  if (!client) {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  }
  return client;
}

export async function checkDatabase(): Promise<"unconfigured" | "unreachable" | "ok"> {
  const prisma = getPrisma();
  if (!prisma) return "unconfigured";
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "unreachable";
  }
}
