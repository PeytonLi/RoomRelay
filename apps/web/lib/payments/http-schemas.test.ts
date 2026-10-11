import { describe, expect, it } from "vitest";
import { checkoutBody } from "./http-schemas";

describe("payment request schemas", () => {
  it("TEST-08: checkout schema rejects client-supplied amount and merchant fields", () => {
    expect(checkoutBody.safeParse({
      quoteId: "quote-id",
      idempotencyKey: "strict-checkout",
      amountCents: 1234,
      merchantId: "attacker-merchant",
    }).success).toBe(false);
  });
});
