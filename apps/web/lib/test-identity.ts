import { cookies } from "next/headers";

let testSubject: string | null = null;

function isVitest(): boolean {
  return process.env.NODE_ENV !== "production" && Boolean(process.env.VITEST);
}

export function setTestIdentity(subject: string | null): void {
  if (!isVitest()) throw new Error("setTestIdentity is only available in Vitest.");
  testSubject = subject === null ? null : subject.startsWith("test:") ? subject : `test:${subject}`;
}

export async function getTestIdentity(): Promise<string | null> {
  if (process.env.NODE_ENV === "production") return null;
  if (process.env.VITEST) return testSubject;
  if (process.env.ROOMRELAY_TEST_IDENTITY !== "enabled") return null;

  const subject = (await cookies()).get("rr_test_user")?.value;
  return subject ? `test:${subject.replace(/^test:/, "")}` : null;
}
