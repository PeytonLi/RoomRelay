/** Browser-side JSON helpers shared by the journey pages. Handles both API
 * error shapes: flat `{code,message}` (apiError) and `{error:{code,message}}`
 * (payment routes). */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

function failureFrom(status: number, body: unknown): ApiFailure {
  const record = (body ?? {}) as { code?: string; message?: string; error?: { code?: string; message?: string } };
  const source = record.error ?? record;
  const code = source.code ?? (status === 404 ? "NOT_FOUND" : "REQUEST_FAILED");
  const message = source.message ?? (status === 404 ? "Not found" : `Request failed (${status})`);
  return new ApiFailure(status, code, message, body);
}

export async function apiJson<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const response = await fetch(url, {
    ...rest,
    ...(json === undefined
      ? {}
      : { method: rest.method ?? "POST", body: JSON.stringify(json), headers: { "Content-Type": "application/json", ...rest.headers } }),
    cache: "no-store",
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw failureFrom(response.status, body);
  return body as T;
}

export function failureMessage(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.code === "PAYMENTS_UNAVAILABLE") return `PayPal sandbox payments are unavailable: ${error.message}`;
    if (error.code === "IDENTITY_UNAVAILABLE") return "Identity unavailable: sign-in is not configured.";
    if (error.code === "UNAUTHENTICATED") return "Sign in to continue.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function formatSlot(slot: { start: string; end: string }): string {
  return `${formatDateTime(slot.start)} – ${formatDateTime(slot.end)}`;
}

export function formatMeters(value: number | null | undefined): string {
  return value === null || value === undefined ? "unknown" : `${value.toFixed(2)} m`;
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** datetime-local value (local time, minute precision) ⇄ ISO string. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
