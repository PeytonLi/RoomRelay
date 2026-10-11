import "dotenv/config";
import { getPaymentDeps } from "../lib/payments/deps";
import { reconcilePayments } from "../lib/payments/reconcile";

const deps = getPaymentDeps();
if (!deps) {
  console.error("Payments reconciliation unavailable: complete the PayPal and database configuration.");
  process.exitCode = 1;
} else {
  reconcilePayments(deps)
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error("Payments reconciliation failed.");
      process.exitCode = 1;
    });
}
