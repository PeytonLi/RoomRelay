import type { User } from "./generated/prisma/client";
import { getPrisma } from "./db";
import { getConfig } from "./env";
import { apiError } from "./http";
import { getTestIdentity } from "./test-identity";

export type RequireUserResult = { ok: true; user: User } | { ok: false; response: Response };

async function findOrCreateUser(authSubject: string): Promise<RequireUserResult> {
  const prisma = getPrisma();
  if (!prisma) {
    return { ok: false, response: apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true }) };
  }
  const user = await prisma.user.upsert({
    where: { authSubject },
    update: {},
    create: { authSubject },
  });
  if (user.disabledAt) {
    return { ok: false, response: apiError("USER_DISABLED", "user disabled", 403) };
  }
  return { ok: true, user };
}

export async function requireUser(): Promise<RequireUserResult> {
  const testSubject = await getTestIdentity();
  if (testSubject) return findOrCreateUser(testSubject);

  if (getConfig().capabilities.identity.status === "unavailable") {
    return {
      ok: false,
      response: apiError("IDENTITY_UNAVAILABLE", "identity unavailable", 503, {
        hint: "run `npx clerk@latest init` in apps/web for a local dev instance",
      }),
    };
  }

  const { userId } = await (await import("@clerk/nextjs/server")).auth();
  if (!userId) return { ok: false, response: apiError("UNAUTHENTICATED", "authentication required", 401) };
  return findOrCreateUser(userId);
}

export async function getOptionalUser(): Promise<User | null> {
  const testSubject = await getTestIdentity();
  if (testSubject) {
    const result = await findOrCreateUser(testSubject);
    return result.ok ? result.user : null;
  }

  if (getConfig().capabilities.identity.status === "unavailable") return null;

  const { userId } = await (await import("@clerk/nextjs/server")).auth();
  if (!userId) return null;
  const result = await findOrCreateUser(userId);
  return result.ok ? result.user : null;
}
