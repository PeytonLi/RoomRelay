import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { getObjectStore } from "@/lib/object-store";
import { createUploadManifest } from "@/lib/services/uploads";
import { getPrisma } from "@/lib/db";

const uploadSchema = z.object({
  role: z.enum(["CONDITION_PHOTO", "ITEM_MODEL", "ROOM_MODEL"]),
  contentType: z.string(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f\d]{64}$/i),
});

function zodFieldErrors(error: z.ZodError): Record<string, string[]> {
  return Object.fromEntries(
    error.issues.map((issue) => [issue.path.join(".") || "body", [issue.message]]),
  );
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_REQUEST", "invalid JSON body", 400);
  }
  const parsed = uploadSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "upload manifest is invalid", 422, { fieldErrors: zodFieldErrors(parsed.error) });
  }

  const isPhoto = parsed.data.role === "CONDITION_PHOTO";
  const validType = isPhoto
    ? ["image/jpeg", "image/png", "image/webp"].includes(parsed.data.contentType)
    : parsed.data.contentType === "model/gltf-binary";
  const maxBytes = isPhoto ? 20 * 1024 * 1024 : 50 * 1024 * 1024;
  if (!validType || parsed.data.bytes > maxBytes) {
    return apiError("VALIDATION_ERROR", "content type or size is not allowed", 422, {
      fieldErrors: {
        ...(validType ? {} : { contentType: ["content type is not allowed for this role"] }),
        ...(parsed.data.bytes > maxBytes ? { bytes: [`maximum size is ${maxBytes} bytes`] } : {}),
      },
    });
  }

  const objectStore = getObjectStore();
  if (!objectStore.available) {
    return apiError("OBJECT_STORE_UNAVAILABLE", objectStore.reason, 503, { retryable: true });
  }
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const manifest = await createUploadManifest(prisma, auth.user, parsed.data);
  return Response.json({
    id: manifest.id,
    role: manifest.role,
    contentType: manifest.contentType,
    bytes: manifest.declaredBytes,
    status: manifest.status,
    uploadUrl: `/api/v1/uploads/${manifest.id}/content`,
    method: "PUT",
    expiresAt: manifest.expiresAt,
  }, { status: 201 });
}
