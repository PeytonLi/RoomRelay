import { Suspense } from "react";
import CheckoutClient from "./checkout-client";

export const dynamic = "force-dynamic";

/** Capability, identity and payment state all come from the checkout API so a
 * refresh always restores the server's view (PayPal approval is not success). */
export default async function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<p role="status">Loading checkout…</p>}>
      <CheckoutClient checkoutId={id} />
    </Suspense>
  );
}
