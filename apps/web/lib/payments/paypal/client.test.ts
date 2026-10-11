import { describe, expect, it } from "vitest";
import { HttpPayPalClient } from "./client";
import { PayPalContractMock } from "../../../test/support/paypal-contract-mock";
import { getPrincipal } from "../../auth/principal";

describe("T-006 PayPal contract client", () => {
  it("splices the signed webhook body byte-for-byte into PayPal verification", async () => {
    const provider = new PayPalContractMock();
    const client = new HttpPayPalClient({
      environment: "sandbox",
      clientId: "mock-client",
      clientSecret: "mock-secret",
      fetch: provider.fetch,
    });
    const rawBody = '{\n  "id": "event-1", "event_type": "CHECKOUT.ORDER.APPROVED"\n}\n';
    const verification = await client.verifyWebhookSignature({
      headers: provider.signEvent(rawBody),
      rawBody,
      webhookId: "mock-webhook",
    });
    expect(verification).toBe("SUCCESS");
    expect(provider.verifiedBodies).toEqual([rawBody]);
  });

  it("does not infer an authenticated principal from request headers", async () => {
    const request = new Request("http://localhost/api/v1/checkouts", {
      headers: { "x-roomrelay-role": "operator", "x-user-id": "spoofed" },
    });
    expect(await getPrincipal(request)).toBeNull();
  });
});
