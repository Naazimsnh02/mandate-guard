import type { CheckoutSnapshotInput } from "../../policy/snapshot.js";
import type { PricedCheckout } from "./store.js";

/** Map Drift Mart's structured checkout to the policy engine's snapshot shape. */
export function pricedCheckoutToSnapshot(c: PricedCheckout, observedAt = new Date()): CheckoutSnapshotInput {
  return {
    merchant: { id: c.merchant.id, origin: c.merchant.origin },
    currency: c.currency,
    lines: c.lines.map((l) => ({
      sku: l.sku,
      title: l.title,
      quantity: l.quantity,
      unit_price: l.unit_price,
      ...(l.recurring ? { recurring: l.recurring } : {}),
    })),
    fees: c.fees,
    fulfillment: {
      method: c.fulfillment.method,
      title: c.fulfillment.title,
      cost: c.fulfillment.cost,
      latest_delivery_at: c.fulfillment.latest_delivery_at,
    },
    displayed_total: c.total,
    observed_at: observedAt.toISOString(),
  };
}
