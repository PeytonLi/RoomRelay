import { DEFAULT_MARGIN_M, type RoomGeometry } from "@roomrelay/spatial";
import { z } from "zod";
import { candidateItemSchema, LIMITS, planningRequestSchema, type CandidateItem, type PlanningRequest } from "./schema";

/** The bounded, server-assembled input to one planning call. */
export interface PlanningContext {
  room: RoomGeometry;
  candidates: CandidateItem[];
  request: PlanningRequest;
  marginM: number;
}

export class PlanningInputError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid planning input: ${issues.join("; ")}`);
    this.name = "PlanningInputError";
  }
}

const candidatesSchema = z.array(candidateItemSchema).min(1).max(LIMITS.maxCandidates);

export function buildPlanningContext(input: {
  room: RoomGeometry;
  candidates: unknown;
  request: unknown;
  marginM?: number;
}): PlanningContext {
  const candidates = candidatesSchema.safeParse(input.candidates);
  const request = planningRequestSchema.safeParse(input.request);
  const issues: string[] = [];
  if (!candidates.success) issues.push(...candidates.error.issues.map((i) => `candidates.${i.path.join(".")}: ${i.message}`));
  if (!request.success) issues.push(...request.error.issues.map((i) => `request.${i.path.join(".")}: ${i.message}`));
  if (candidates.success) {
    const ids = new Set<string>();
    for (const c of candidates.data) {
      if (ids.has(c.itemId)) issues.push(`candidates: duplicate itemId ${c.itemId}`);
      ids.add(c.itemId);
    }
  }
  if (issues.length > 0 || !candidates.success || !request.success) throw new PlanningInputError(issues);
  return {
    room: input.room,
    candidates: candidates.data,
    request: request.data,
    marginM: input.marginM ?? DEFAULT_MARGIN_M,
  };
}
