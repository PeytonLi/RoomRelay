import { requireUser } from "../auth";

export interface Principal {
  userId: string;
}

export async function getPrincipal(_request: Request): Promise<Principal | null> {
  const result = await requireUser();
  return result.ok ? { userId: result.user.id } : null;
}
