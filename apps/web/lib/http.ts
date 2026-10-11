import { randomUUID } from "node:crypto";

export type FieldErrors = Record<string, string[]>;

export function apiError(
  code: string,
  message: string,
  status: number,
  options: { retryable?: boolean; fieldErrors?: FieldErrors; hint?: string } = {},
): Response {
  return Response.json(
    {
      code,
      message,
      ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
      ...(options.hint ? { hint: options.hint } : {}),
      retryable: options.retryable ?? false,
      correlationId: randomUUID(),
    },
    { status },
  );
}
