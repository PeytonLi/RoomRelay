import { ZodError, z } from "zod";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { parseRoomGeometry } from "@/lib/room-geometry";
import { createRoom, listOwnRooms } from "@/lib/services/rooms";
import { readJson, zodFieldErrors } from "@/lib/validation";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  geometry: z.unknown(),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = createSchema.safeParse(body.value);
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
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const result = await createRoom(prisma, auth.user, { name: parsed.data.name, geometry });
  return Response.json({ ...result.room, geometry: result.revision.geometry }, { status: 201 });
}

export async function GET(): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  return Response.json(await listOwnRooms(prisma, auth.user));
}
