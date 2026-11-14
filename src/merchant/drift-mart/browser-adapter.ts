import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { MerchantRef } from "../../mandate/schema.js";
import type { CheckoutSnapshotInput } from "../../policy/snapshot.js";
import type { CardCredential } from "../../payments/gateway.js";
import type { MerchantAdapter, PaymentOutcome, ProductSummary, ShippingChoice } from "../adapter.js";
import { rankProducts, toOutcome } from "./http-adapter.js";

/**
 * Playwright adapter: the agent shops the way a person would — opening pages,
 * clicking "Add to cart", reading the checkout page, typing card details.
 *
 * Security notes:
 *  - The merchant origin in the snapshot comes from the browser's actual URL,
 *    not from anything the page claims about itself.
 *  - Card details are typed directly into the merchant form from server memory;
 *    they are never returned, logged, or shown to the model.
 */
export interface BrowserOptions {
  headless?: boolean;
  /** "chrome" uses the installed Google Chrome (no browser download needed). */
  channel?: string;
  slowMo?: number;
}

export class BrowserDriftMartAdapter implements MerchantAdapter {
  readonly merchant: MerchantRef;
  private browser?: Browser;
  private ctx?: BrowserContext;
  private page?: Page;

  constructor(
    private origin: string,
    private opts: BrowserOptions = {},
  ) {
    this.merchant = { id: "drift-mart", name: "Drift Mart", origin };
  }

  private async p(): Promise<Page> {
    if (!this.page) {
      this.browser = await chromium.launch({
        headless: this.opts.headless ?? true,
        channel: this.opts.channel ?? "chrome",
        slowMo: this.opts.slowMo,
      });
      this.ctx = await this.browser.newContext({ viewport: { width: 1280, height: 860 } });
      this.page = await this.ctx.newPage();
    }
    return this.page;
  }

  async searchProducts(query: string): Promise<ProductSummary[]> {
    const page = await this.p();
    await page.goto(`${this.origin}/`);
    const items = await page.$$eval("a.product", (els) =>
      els.map((e) => ({
        sku: (e as HTMLElement).dataset.sku!,
        title: e.querySelector(".title")?.textContent?.trim() ?? "",
        price: Number((e as HTMLElement).dataset.price),
        href: (e as HTMLAnchorElement).href,
      })),
    );
    const all: ProductSummary[] = items.map((i) => ({
      sku: i.sku,
      title: i.title,
      description: "",
      price: i.price,
      currency: "USD",
      available: true,
      url: i.href,
    }));
    return rankProducts(all, query);
  }

  async shippingOptions(): Promise<ShippingChoice[]> {
    const page = await this.p();
    const res = await page.request.get(`${this.origin}/api/shipping`);
    return (await res.json()) as ShippingChoice[];
  }

  async createCart(items: { sku: string; quantity: number }[], shippingId: string): Promise<{ cart_id: string }> {
    const page = await this.p();
    let cartId = "";
    for (const item of items) {
      await page.goto(`${this.origin}/p/${item.sku}${cartId ? `?cart=${cartId}` : ""}`);
      await page.fill('input[name="quantity"]', String(item.quantity));
      await Promise.all([page.waitForURL(/\/cart\/[0-9a-f-]+$/), page.click("#add-to-cart")]);
      cartId = new URL(page.url()).pathname.split("/").pop()!;
    }
    await page.selectOption("#shipping", shippingId);
    await Promise.all([page.waitForURL(/\/cart\//), page.click('form[action$="/shipping"] button')]);
    return { cart_id: cartId };
  }

  async readCheckout(cartId: string): Promise<CheckoutSnapshotInput> {
    const page = await this.p();
    await page.goto(`${this.origin}/checkout/${cartId}`);
    const raw = await page.$eval("#checkout", (root) => {
      const d = (root as HTMLElement).dataset;
      const lines = [...root.querySelectorAll("tr.line")].map((tr) => {
        const x = (tr as HTMLElement).dataset;
        return { sku: x.sku!, title: x.title!, quantity: Number(x.quantity), unit_price: Number(x.unitPrice), recurring: x.recurring };
      });
      const fees = [...root.querySelectorAll("tr.fee")].map((tr) => ({
        label: (tr as HTMLElement).dataset.label!,
        amount: Number((tr as HTMLElement).dataset.amount),
      }));
      const f = (root.querySelector("#fulfillment") as HTMLElement).dataset;
      return {
        merchant_id: d.merchantId!,
        currency: d.currency!,
        total: Number(d.total),
        lines,
        fees,
        fulfillment: { method: f.method!, title: f.title!, cost: Number(f.cost), latest_delivery_at: f.latestDeliveryAt! },
      };
    });
    return {
      merchant: { id: raw.merchant_id, origin: new URL(page.url()).origin },
      currency: raw.currency,
      lines: raw.lines.map((l) => ({
        sku: l.sku,
        title: l.title,
        quantity: l.quantity,
        unit_price: l.unit_price,
        ...(l.recurring ? { recurring: { interval: l.recurring } } : {}),
      })),
      fees: raw.fees,
      fulfillment: raw.fulfillment as CheckoutSnapshotInput["fulfillment"],
      displayed_total: raw.total,
      observed_at: new Date().toISOString(),
    };
  }

  async submitPayment(cartId: string, p: { idempotencyKey: string; expectedTotal: number; card: CardCredential }): Promise<PaymentOutcome> {
    const page = await this.p();
    if (!page.url().endsWith(`/checkout/${cartId}`)) await page.goto(`${this.origin}/checkout/${cartId}`);
    const shownTotal = Number(await page.getAttribute("#checkout", "data-total"));
    if (shownTotal !== p.expectedTotal) {
      return { kind: "CONFIRMED", order_id: "", status: "ERROR", total: shownTotal, failure_reason: "total_changed" };
    }
    await page.fill("#card_name", p.card.name);
    await page.fill("#card_number", p.card.number);
    await page.fill("#expiry_month", p.card.expiry_month);
    await page.fill("#expiry_year", p.card.expiry_year);
    await page.fill("#cvc", p.card.cvc);
    await page.$eval("#idempotency_key", (el, key) => ((el as HTMLInputElement).value = key), p.idempotencyKey);
    try {
      await Promise.all([page.waitForURL(/\/orders\//, { timeout: 20_000 }), page.click("#place-order")]);
    } catch (err) {
      return { kind: "UNCONFIRMED", error: (err as Error).message.split("\n")[0]! };
    }
    const o = await page.$eval("#order", (el) => ({ ...(el as HTMLElement).dataset }));
    return {
      kind: "CONFIRMED",
      order_id: o.orderId!,
      status: o.status as "PAID" | "DECLINED" | "ERROR",
      total: Number(o.total),
      reference: o.paymentReference || undefined,
      failure_reason: o.failureReason || undefined,
    };
  }

  async lookupAttempt(idempotencyKey: string): Promise<PaymentOutcome | null> {
    const page = await this.p();
    const res = await page.request.get(`${this.origin}/api/orders?idempotency_key=${encodeURIComponent(idempotencyKey)}`);
    const body = (await res.json()) as { orders: unknown[] };
    return body.orders[0] ? toOutcome(body.orders[0]) : null;
  }

  async close() {
    await this.browser?.close();
    this.browser = this.ctx = this.page = undefined;
  }
}
