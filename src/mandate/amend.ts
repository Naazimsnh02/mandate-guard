import type { CheckoutSnapshot } from "../policy/snapshot.js";
import type { Mandate, MandateTermsInput } from "./schema.js";

/**
 * Build the terms for a replacement mandate from the observed checkout, so the
 * shopper can re-approve exactly what they now see. The new mandate is issued
 * with `supersedes: old.mandate_id`; the old one must then be treated as void.
 *
 * The cap becomes the new displayed total (no headroom), unless the shopper
 * explicitly passes a higher cap when re-approving.
 */
export function proposeAmendedTerms(
  old: Mandate,
  snap: CheckoutSnapshot,
  overrides: { total_cap?: number; merchantName?: string } = {},
): MandateTermsInput {
  return {
    intent: old.intent,
    merchant: {
      id: snap.merchant.id,
      name: snap.merchant.id === old.merchant.id ? old.merchant.name : (overrides.merchantName ?? snap.merchant.id),
      origin: snap.merchant.origin,
    },
    currency: snap.currency,
    items: snap.lines.map((l) => ({
      sku: l.sku,
      title: l.title,
      variant: l.variant,
      quantity: l.quantity,
      unit_price: l.unit_price,
    })),
    fulfillment: { ...snap.fulfillment },
    fees: snap.fees.filter((f) => f.amount > 0),
    total_cap: overrides.total_cap ?? snap.displayed_total,
    allow_recurring: old.allow_recurring || snap.lines.some((l) => l.recurring !== undefined),
    allow_substitutions: old.allow_substitutions,
  };
}
