export function formatUsdCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError("USD cents must be a non-negative safe integer");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function parseUsdToCents(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new TypeError("Invalid USD amount");
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new RangeError("USD amount is outside the safe integer range");
  return cents;
}
