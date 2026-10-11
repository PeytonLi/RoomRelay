import { sha256Hex, inspectGlb } from "@roomrelay/assets";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { getObjectStore } from "@/lib/object-store";
import { getOwnedUploadManifest, markUploadComplete } from "@/lib/services/uploads";

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function matchesImageSignature(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "image/png") {
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  }
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/webp") {
    return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  }
  return false;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  const manifest = await getOwnedUploadManifest(prisma, auth.user, id);
  if (!manifest) return apiError("NOT_FOUND", "upload not found", 404);
  if (manifest.status !== "PENDING" || manifest.expiresAt <= new Date()) {
    return apiError("UPLOAD_EXPIRED", "upload is not available", 409);
  }

  const maxBytes = manifest.role === "CONDITION_PHOTO" ? 20 * 1024 * 1024 : 50 * 1024 * 1024;
  const bytes = await readBoundedBody(request, maxBytes);
  if (!bytes) return apiError("PAYLOAD_TOO_LARGE", "upload exceeds its size limit", 413);
  if (bytes.byteLength !== manifest.declaredBytes) {
    return apiError("UPLOAD_SIZE_MISMATCH", "uploaded size does not match the manifest", 422);
  }
  const sha256 = sha256Hex(bytes);
  if (sha256.toLowerCase() !== manifest.declaredSha256.toLowerCase()) {
    return apiError("UPLOAD_HASH_MISMATCH", "uploaded hash does not match the manifest", 422);
  }
  if (manifest.role === "CONDITION_PHOTO" && !matchesImageSignature(manifest.contentType, bytes)) {
    return apiError("INVALID_MEDIA", "photo signature does not match its content type", 422);
  }
  if (manifest.role !== "CONDITION_PHOTO") {
    try {
      inspectGlb(bytes);
    } catch {
      return apiError("INVALID_GLB", "GLB inspection failed", 422);
    }
  }

  const objectStore = getObjectStore();
  if (!objectStore.available) return apiError("OBJECT_STORE_UNAVAILABLE", objectStore.reason, 503, { retryable: true });
  try {
    await objectStore.store.put(manifest.objectKey, bytes);
  } catch {
    return apiError("UPLOAD_WRITE_FAILED", "upload could not be stored", 503, { retryable: true });
  }
  const result = await markUploadComplete(prisma, auth.user, id);
  if (result.count !== 1) return apiError("UPLOAD_EXPIRED", "upload is no longer available", 409);
  return Response.json({ status: "UPLOADED" });
}
