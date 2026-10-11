import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db";
import { getConfig } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  const { capabilities } = getConfig();
  const database = await checkDatabase();
  return NextResponse.json(
    {
      service: "roomrelay-web",
      status: "up",
      database,
      capabilities,
    },
    { status: 200 },
  );
}
