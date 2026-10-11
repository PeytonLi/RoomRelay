import { ZodError, z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { parseRoomGeometry } from "@/lib/room-geometry";
import { getOwnRoom, patchRoom } from "@/lib/services/rooms";
import { readJson, zodFieldErrors } from "@/lib/validation";

const patchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  geometry: z.unknown(),
}).strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const room = await getOwnRoom(prisma, auth.user, id);
  if (!room) return apiError("NOT_FOUND", "room not found", 404);
  return Response.json(room);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = patchSchema.safeParse(body.value);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "room is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  let geometry;
  try {
    geometry = parseRoomGeometry(parsed.data.geometry);
  } catch (error) {
    const fieldErrors = error instanceof ZodError
      ? zodFieldErrors(error)
      : { geometry: [error instanceof Error ? error.message : "invalid room geometry"] };
    return apiError("VALIDATION_ERROR", "room geometry is invalid", 422, { fieldErrors });
  }
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await patchRoom(prisma, auth.user, id, parsed.data.expectedRevision, geometry);
  if (result.kind === "not-found") return apiError("NOT_FOUND", "room not found", 404);
  if (result.kind === "stale") return apiError("STALE_VERSION", "room revision is stale", 409);
  return Response.json({ room: result.room, revision: result.revision });
}
