export type PaymentErrorCode =
  | "PAYMENTS_UNAVAILABLE"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION"
  | "QUOTE_NOT_PAYABLE"
  | "QUOTE_STALE"
  | "INVENTORY_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "HOLD_EXPIRED"
  | "ORDER_BINDING_MISMATCH"
  | "INVALID_STATE"
  | "PROVIDER_UNAVAILABLE"
  | "REFUND_NOT_ALLOWED";

const statuses: Record<PaymentErrorCode, number> = {
  PAYMENTS_UNAVAILABLE: 503,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VALIDATION: 400,
  QUOTE_NOT_PAYABLE: 409,
  QUOTE_STALE: 409,
  INVENTORY_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  HOLD_EXPIRED: 409,
  ORDER_BINDING_MISMATCH: 409,
  INVALID_STATE: 409,
  PROVIDER_UNAVAILABLE: 503,
  REFUND_NOT_ALLOWED: 409,
};

export class PaymentError extends Error {
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(readonly code: PaymentErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "PaymentError";
    this.httpStatus = statuses[code];
    this.retryable = retryable;
  }
}
