import { z } from "zod";

/** Integer amount in minor units (e.g. cents). */
export const Minor = z.number().int().nonnegative();

export const MerchantRef = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Scheme + host the checkout must happen on, e.g. "https://www.boat-lifestyle.com". */
  origin: z.string().url(),
});

export const ApprovedItem = z.object({
  sku: z.string().min(1),
  title: z.string().min(1),
  variant: z.string().optional(),
  quantity: z.number().int().positive(),
  unit_price: Minor,
});

export const ApprovedFulfillment = z.object({
  method: z.enum(["SHIPPING", "PICKUP", "DIGITAL", "LOCAL_DELIVERY"]),
  title: z.string(),
  cost: Minor,
  /** ISO date-time: goods must arrive no later than this. */
  latest_delivery_at: z.string().datetime({ offset: true }).optional(),
});

/** What the shopper sees and approves. Everything here is bound by the signature. */
export const MandateTerms = z.object({
  intent: z.string().min(1),
  merchant: MerchantRef,
  currency: z.string().length(3),
  items: z.array(ApprovedItem).min(1),
  fulfillment: ApprovedFulfillment,
  /** Approved fees by label (e.g. tax). Any fee not listed here is drift. */
  fees: z.array(z.object({ label: z.string(), amount: Minor })).default([]),
  /** Hard ceiling for the final total, in minor units. */
  total_cap: Minor,
  allow_recurring: z.boolean().default(false),
  allow_substitutions: z.boolean().default(false),
});

export const Mandate = MandateTerms.extend({
  mandate_id: z.string().uuid(),
  version: z.literal(1),
  created_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
  /** Set when this mandate replaces an earlier one after re-consent. */
  supersedes: z.string().uuid().optional(),
});

export type MerchantRef = z.infer<typeof MerchantRef>;
export type ApprovedItem = z.infer<typeof ApprovedItem>;
export type MandateTermsInput = z.input<typeof MandateTerms>;
export type MandateTerms = z.infer<typeof MandateTerms>;
export type Mandate = z.infer<typeof Mandate>;
