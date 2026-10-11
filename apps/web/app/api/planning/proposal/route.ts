import { NextResponse } from "next/server";
import { getConfig } from "@/lib/env";
import { handleProposalRequest } from "@/lib/planning";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ state: "invalid_request", issues: ["body must be JSON"] }, { status: 400 });
  }
  const res = await handleProposalRequest(body, { config: getConfig() });
  return NextResponse.json(res.body, { status: res.status });
}
