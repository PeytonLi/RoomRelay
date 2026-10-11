import { getConfig } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const { capabilities } = getConfig();
  if (capabilities.paypal.status !== "available") {
    return (
      <main className="workspace">
        <header className="topbar">
          <h1>RoomRelay checkout</h1>
          <span className="sub">Sandbox payment capability</span>
        </header>
        <section className="stage" aria-label="Checkout status">
          <div className="side">
            <article className="card">
              <h2>Checkout unavailable</h2>
              <p>PayPal sandbox checkout is unavailable</p>
              <p className="muted">Missing configuration: {capabilities.paypal.missing.join(", ")}</p>
              <p className="notice">No payment will be recorded.</p>
            </article>
          </div>
        </section>
      </main>
    );
  }
  return (
    <main className="workspace">
      <header className="topbar">
        <h1>RoomRelay checkout</h1>
        <span className="sub">Sandbox payment capability</span>
      </header>
      <section className="stage" aria-label="Checkout status">
        <div className="side">
          <article className="card">
            <h2>Checkout requires sign-in</h2>
            <p>Sign-in is not configured yet; checkout requires an authenticated buyer.</p>
            <p className="muted">No payment will be recorded.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
