import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { addOrderNote } from "@/lib/services/orders";
import { readJson, zodFieldErrors } from "@/lib/validation";

const bodySchema = z.object({
  body: z.string().trim().min(1).max(1000),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "note is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await addOrderNote(prisma, auth.user.id, id, parsed.data.body);
  if (result.kind === "not-found") return apiError("NOT_FOUND", "order not found", 404);
  return Response.json({ id: result.note.id, authorRole: result.note.authorRole, createdAt: result.note.createdAt }, { status: 201 });
}
