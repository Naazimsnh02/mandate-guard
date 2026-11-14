import type { MerchantRef } from "../mandate/schema.js";
import type { CardCredential } from "../payments/gateway.js";
import type { CheckoutSnapshotInput } from "../policy/snapshot.js";

/**
 * Everything Mandate Guard needs from a merchant. Implementations:
 *  - HttpDriftMartAdapter   (structured API, used in tests)
 *  - BrowserDriftMartAdapter (Playwright: what the agent does on a real site)
 */
export interface ProductSummary {
  sku: string;
  title: string;
  description: string;
  price: number; // minor units
  currency: string;
  available: boolean;
  url: string;
}

export interface ShippingChoice {
  id: string;
  title: string;
  cost: number;
}

export type PaymentOutcome =
  | {
      kind: "CONFIRMED";
      order_id: string;
      status: "PAID" | "DECLINED" | "ERROR";
      total: number;
      reference?: string;
      failure_reason?: string;
    }
  /** Timeout / dropped connection / unreadable page: the charge MAY have happened. */
  | { kind: "UNCONFIRMED"; error: string };

export interface MerchantAdapter {
  readonly merchant: MerchantRef;
  searchProducts(query: string): Promise<ProductSummary[]>;
  shippingOptions(): Promise<ShippingChoice[]>;
  createCart(items: { sku: string; quantity: number }[], shippingId: string): Promise<{ cart_id: string }>;
  /** Read the checkout exactly as the merchant presents it right now. */
  readCheckout(cartId: string): Promise<CheckoutSnapshotInput>;
  /** Submit payment. Must use `idempotencyKey` so the merchant can dedupe retries. */
  submitPayment(
    cartId: string,
    p: { idempotencyKey: string; expectedTotal: number; card: CardCredential },
  ): Promise<PaymentOutcome>;
  /** Look up a prior attempt by idempotency key (before any retry). */
  lookupAttempt(idempotencyKey: string): Promise<PaymentOutcome | null>;
  close(): Promise<void>;
}
