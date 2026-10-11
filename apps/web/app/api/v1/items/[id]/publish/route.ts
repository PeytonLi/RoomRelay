import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { publishItem } from "@/lib/services/inventory";
import { readJson, zodFieldErrors } from "@/lib/validation";

const publishSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = publishSchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "publish request is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await publishItem(prisma, auth.user, id, parsed.data.expectedVersion);
  if (result.kind === "not-found") return apiError("NOT_FOUND", "item not found", 404);
  if (result.kind === "locked") return apiError("ITEM_LOCKED", "item is locked", 409);
  if (result.kind === "stale") return apiError("STALE_VERSION", "item version is stale", 409);
  if (result.kind === "invalid") return apiError("VALIDATION_ERROR", "listing cannot be published", 422, { fieldErrors: result.fieldErrors });
  return Response.json({ item: result.item, publishedVersion: result.item && (result.item as { publishedVersion: number }).publishedVersion });
}
