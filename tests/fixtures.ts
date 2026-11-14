import type { MandateTermsInput } from "../src/mandate/schema.js";
import type { CheckoutSnapshotInput } from "../src/policy/snapshot.js";

export const NOW = new Date("2026-11-08T10:00:00Z");

export const terms = (): MandateTermsInput => ({
  intent: "USB-C cable under $15, delivered by Friday",
  merchant: { id: "drift-mart", name: "Drift Mart", origin: "http://localhost:4000" },
  currency: "USD",
  items: [{ sku: "cable-usbc-1m", title: "USB-C Cable 1m", quantity: 1, unit_price: 999 }],
  fulfillment: {
    method: "SHIPPING",
    title: "Standard shipping (3-5 days)",
    cost: 300,
    latest_delivery_at: "2026-11-13T23:59:00Z",
  },
  fees: [],
  total_cap: 1299,
});

/** A checkout that exactly matches terms(). */
export const snapshot = (): CheckoutSnapshotInput => ({
  merchant: { id: "drift-mart", origin: "http://localhost:4000" },
  currency: "USD",
  lines: [{ sku: "cable-usbc-1m", title: "USB-C Cable 1m", quantity: 1, unit_price: 999 }],
  fees: [],
  fulfillment: {
    method: "SHIPPING",
    title: "Standard shipping (3-5 days)",
    cost: 300,
    latest_delivery_at: "2026-11-12T18:00:00Z",
  },
  displayed_total: 1299,
  observed_at: NOW.toISOString(),
});
