import { getIdentityMode } from "@/lib/identity-mode";
import { requireUser } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { apiError } from "@/lib/http";
import { getObjectStore } from "@/lib/object-store";
import { getDownloadableAsset } from "@/lib/services/uploads";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const prisma = getPrisma();
  if (!prisma) return apiError("DATABASE_UNAVAILABLE", "database unavailable", 503, { retryable: true });
  let userId: string | null = null;
  if (getIdentityMode() !== "unavailable") {
    const auth = await requireUser();
    if (auth.ok) userId = auth.user.id;
  }
  const asset = await getDownloadableAsset(prisma, userId, id);
  if (!asset) return apiError("NOT_FOUND", "asset not found", 404);
  const objectStore = getObjectStore();
  if (!objectStore.available) {
    return apiError("OBJECT_STORE_UNAVAILABLE", objectStore.reason, 503, { retryable: true });
  }
  const bytes = await objectStore.store.get(asset.objectKey);
  if (!bytes) return apiError("NOT_FOUND", "asset not found", 404);
  const body = Uint8Array.from(bytes).buffer as ArrayBuffer;
  return new Response(body, {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": asset.visibility === "APPROVED_LISTING" ? "public, max-age=60" : "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
