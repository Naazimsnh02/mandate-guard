import type { MerchantRef } from "../../mandate/schema.js";
import type { CheckoutSnapshotInput } from "../../policy/snapshot.js";
import type { MerchantAdapter, PaymentOutcome, ProductSummary, ShippingChoice } from "../adapter.js";
import type { CardCredential } from "../../payments/gateway.js";
import { pricedCheckoutToSnapshot } from "./to-snapshot.js";
import type { PricedCheckout } from "./store.js";

/** Structured-API adapter for Drift Mart (fast, deterministic; used in tests). */
export class HttpDriftMartAdapter implements MerchantAdapter {
  readonly merchant: MerchantRef;

  constructor(private origin: string) {
    this.merchant = { id: "drift-mart", name: "Drift Mart", origin };
  }

  async searchProducts(query: string): Promise<ProductSummary[]> {
    const res = await this.json<{ products: { id: string; title: string; body_html: string; variants: { sku: string; price: string; available: boolean }[] }[] }>(
      "GET",
      "/products.json",
    );
    const all = res.products.map((p) => ({
      sku: p.variants[0]!.sku,
      title: p.title,
      description: p.body_html,
      price: Math.round(Number(p.variants[0]!.price) * 100),
      currency: "USD",
      available: p.variants[0]!.available,
      url: `${this.origin}/p/${p.id}`,
    }));
    return rankProducts(all, query);
  }

  shippingOptions(): Promise<ShippingChoice[]> {
    return this.json("GET", "/api/shipping");
  }

  async createCart(items: { sku: string; quantity: number }[], shippingId: string) {
    const cart = await this.json<{ id: string }>("POST", "/api/carts");
    for (const i of items) await this.json("POST", `/api/carts/${cart.id}/items`, { sku: i.sku, quantity: i.quantity });
    await this.json("POST", `/api/carts/${cart.id}/shipping`, { shipping_id: shippingId });
    return { cart_id: cart.id };
  }

  async readCheckout(cartId: string): Promise<CheckoutSnapshotInput> {
    return pricedCheckoutToSnapshot(await this.json<PricedCheckout>("GET", `/api/checkout/${cartId}`));
  }

  async submitPayment(cartId: string, p: { idempotencyKey: string; expectedTotal: number; card: CardCredential }): Promise<PaymentOutcome> {
    const form = new URLSearchParams({
      idempotency_key: p.idempotencyKey,
      expected_total: String(p.expectedTotal),
      card_number: p.card.number,
      expiry_month: p.card.expiry_month,
      expiry_year: p.card.expiry_year,
      cvc: p.card.cvc,
      card_name: p.card.name,
    });
    let res: Response;
    try {
      res = await fetch(`${this.origin}/checkout/${cartId}/pay`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return { kind: "UNCONFIRMED", error: (err as Error).message };
    }
    if (res.status === 409) {
      // Merchant refused before charging: total changed since we read it.
      const shown = await this.readCheckout(cartId).then((c) => c.displayed_total).catch(() => p.expectedTotal);
      return { kind: "CONFIRMED", order_id: "", status: "ERROR", total: shown, failure_reason: "total_changed" };
    }
    if (!res.ok) return { kind: "UNCONFIRMED", error: `HTTP ${res.status}` };
    return toOutcome(await res.json());
  }

  async lookupAttempt(idempotencyKey: string): Promise<PaymentOutcome | null> {
    const r = await this.json<{ orders: unknown[] }>("GET", `/api/orders?idempotency_key=${encodeURIComponent(idempotencyKey)}`);
    return r.orders[0] ? toOutcome(r.orders[0]) : null;
  }

  async close() {}

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.origin}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
}

export function toOutcome(o: any): PaymentOutcome {
  return {
    kind: "CONFIRMED",
    order_id: o.order_id,
    status: o.status,
    total: o.total,
    reference: o.payment?.reference,
    failure_reason: o.payment?.failure_reason,
  };
}

/** Naive keyword ranking — the LLM does the real judgement over these results. */
export function rankProducts(all: ProductSummary[], query: string): ProductSummary[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (terms.length === 0) return all;
  const scored = all
    .map((p) => {
      const hay = `${p.title} ${p.description} ${p.sku}`.toLowerCase();
      return { p, score: terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored.map((x) => x.p) : all;
}
