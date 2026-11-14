import { z } from "zod";
import { Minor } from "../mandate/schema.js";

/**
 * What the agent actually observed on the merchant's checkout page, immediately
 * before paying. Produced by the merchant adapter (Playwright / structured API),
 * never by the LLM directly.
 */
export const CheckoutSnapshot = z.object({
  merchant: z.object({ id: z.string(), origin: z.string().url() }),
  currency: z.string().length(3),
  lines: z
    .array(
      z.object({
        sku: z.string(),
        title: z.string(),
        variant: z.string().optional(),
        quantity: z.number().int().positive(),
        unit_price: Minor,
        /** Present if the line is a subscription / auto-renewing charge. */
        recurring: z.object({ interval: z.string() }).optional(),
      }),
    )
    .min(1),
  fees: z.array(z.object({ label: z.string(), amount: Minor })).default([]),
  fulfillment: z.object({
    method: z.enum(["SHIPPING", "PICKUP", "DIGITAL", "LOCAL_DELIVERY"]),
    title: z.string(),
    cost: Minor,
    latest_delivery_at: z.string().datetime({ offset: true }).optional(),
  }),
  /** The grand total exactly as displayed by the merchant. */
  displayed_total: Minor,
  observed_at: z.string().datetime({ offset: true }),
});

export type CheckoutSnapshotInput = z.input<typeof CheckoutSnapshot>;
export type CheckoutSnapshot = z.infer<typeof CheckoutSnapshot>;
