import { apiError } from "./http";
import type { ZodError } from "zod";

export async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: apiError("INVALID_REQUEST", "invalid JSON body", 400) };
  }
}

export function zodFieldErrors(error: ZodError): Record<string, string[]> {
  return Object.fromEntries(error.issues.map((issue) => [issue.path.join(".") || "body", [issue.message]]));
}
