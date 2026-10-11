import { describe, expect, it } from "vitest";
import { formatUsdCents, parseUsdToCents } from "./money";
import { checkoutBody } from "./http-schemas";

describe("T-006 money and strict request contracts", () => {
  it("formats and parses integer USD cents without floating-point arithmetic", () => {
    expect(formatUsdCents(1234)).toBe("12.34");
    expect(formatUsdCents(1)).toBe("0.01");
    expect(parseUsdToCents("12.34")).toBe(1234);
    expect(() => parseUsdToCents("12.345")).toThrow();
    expect(() => formatUsdCents(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("rejects client-controlled amount, merchant, and currency fields", () => {
    const base = { quoteId: "quote-1", idempotencyKey: "request-1" };
    expect(checkoutBody.safeParse(base).success).toBe(true);
    expect(checkoutBody.safeParse({ ...base, amountCents: 1 }).success).toBe(false);
    expect(checkoutBody.safeParse({ ...base, merchantId: "client-choice" }).success).toBe(false);
    expect(checkoutBody.safeParse({ ...base, currency: "EUR" }).success).toBe(false);
  });
});
