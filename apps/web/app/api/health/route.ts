import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db";
import { getConfig } from "@/lib/env";
import { getObjectStoreStatus } from "@/lib/object-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const { capabilities } = getConfig();
  const database = await checkDatabase();
  const objectStore = getObjectStoreStatus();
  return NextResponse.json(
    {
      service: "roomrelay-web",
      status: "up",
      database,
      capabilities,
      objectStore,
    },
    { status: 200 },
  );
}
