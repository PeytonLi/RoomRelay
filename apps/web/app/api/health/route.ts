import { NextResponse } from "next/server";
import { checkDatabase, getPrisma } from "@/lib/db";
import { getConfig } from "@/lib/env";
import { getJobHealth } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET() {
  const { capabilities } = getConfig();
  const database = await checkDatabase();
  const jobs = await getJobHealth(getPrisma());
  return NextResponse.json(
    {
      service: "roomrelay-web",
      status: "up",
      database,
      capabilities,
      jobs,
    },
    { status: 200 },
  );
}
