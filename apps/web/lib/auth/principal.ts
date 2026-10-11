export interface Principal {
  userId: string;
}

export async function getPrincipal(_request: Request): Promise<Principal | null> {
  return null;
}
