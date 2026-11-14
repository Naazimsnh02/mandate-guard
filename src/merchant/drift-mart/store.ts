import { randomUUID } from "node:crypto";
import type { CardProcessor, ChargeResult, CardInput } from "./processor.js";

/**
 * Drift Mart domain: catalog, carts, drift settings, checkout pricing, orders.
 * In-memory on purpose — it is a demo merchant, reset between demo runs.
 *
 * Drift applies ONLY when the checkout is priced, never on the product pages:
 * exactly the "terms changed at the last step" problem Mandate Guard solves.
 */
export interface Product {
  sku: string;
  title: string;
  description: string;
  price: number; // minor units, USD
  image: string;
  stock: number;
}

export const CURRENCY = "USD";

export const CATALOG: Product[] = [
  { sku: "cable-usbc-1m", title: "USB-C to USB-C Cable 1m (60W)", description: "Braided nylon, 60W PD fast charging.", price: 999, image: "🔌", stock: 40 },
  { sku: "cable-usbc-2m", title: "USB-C to USB-C Cable 2m (100W)", description: "Braided, 100W PD, 480Mbps data.", price: 1499, image: "🔌", stock: 25 },
  { sku: "charger-30w", title: "30W GaN USB-C Charger", description: "Compact GaN wall charger, foldable pins.", price: 2499, image: "🔋", stock: 30 },
  { sku: "earbuds-lite", title: "Wireless Earbuds Lite", description: "Bluetooth 5.3, 30h battery with case.", price: 3999, image: "🎧", stock: 15 },
  { sku: "earbuds-pro", title: "Wireless Earbuds Pro (ANC)", description: "Active noise cancellation, 40h battery.", price: 7999, image: "🎧", stock: 10 },
  { sku: "mouse-wireless", title: "Silent Wireless Mouse", description: "2.4GHz + Bluetooth, silent clicks.", price: 1999, image: "🖱️", stock: 20 },
  { sku: "keyboard-mech", title: "Compact Mechanical Keyboard", description: "75% layout, hot-swap switches.", price: 8999, image: "⌨️", stock: 8 },
  { sku: "monitor-27", title: '27" 1440p IPS Monitor', description: "27-inch QHD, 75Hz, USB-C 65W.", price: 18999, image: "🖥️", stock: 5 },
];

export interface ShippingOption {
  id: string;
  method: "SHIPPING";
  title: string;
  cost: number;
  days: number;
}

export const SHIPPING: ShippingOption[] = [
  { id: "std", method: "SHIPPING", title: "Standard shipping (3-5 days)", cost: 300, days: 5 },
  { id: "exp", method: "SHIPPING", title: "Express shipping (1-2 days)", cost: 900, days: 2 },
];

/** Knobs flipped from the drift console during a demo. */
export interface DriftSettings {
  /** sku → new unit price (minor) at checkout */
  priceOverrides: Record<string, number>;
  /** Extra fee appended at checkout */
  surpriseFee?: { label: string; amount: number };
  /** skus treated as out of stock at checkout */
  outOfStock: string[];
  /** sku → substitute sku shown at checkout */
  substitutions: Record<string, string>;
  /** Pre-ticked subscription add-on appended at checkout */
  subscriptionAddon?: { sku: string; title: string; amount: number; interval: string };
  /** Replace the chosen shipping option with a slower/pricier one */
  shippingDowngrade?: { title: string; cost: number; days: number };
  /** Simulate a payment timeout: charge succeeds but the HTTP response is dropped */
  dropNextPaymentResponse: boolean;
}

export const emptyDrift = (): DriftSettings => ({
  priceOverrides: {},
  outOfStock: [],
  substitutions: {},
  dropNextPaymentResponse: false,
});

export interface CartLine {
  sku: string;
  quantity: number;
}

export interface Cart {
  id: string;
  lines: CartLine[];
  shippingId: string;
  createdAt: string;
}

export interface PricedLine {
  sku: string;
  title: string;
  quantity: number;
  unit_price: number;
  recurring?: { interval: string };
  note?: string;
}

export interface PricedCheckout {
  cart_id: string;
  merchant: { id: string; name: string; origin: string };
  currency: string;
  lines: PricedLine[];
  fees: { label: string; amount: number }[];
  fulfillment: { id: string; method: "SHIPPING"; title: string; cost: number; latest_delivery_at: string };
  total: number;
  priced_at: string;
}

export type OrderStatus = "PAID" | "DECLINED" | "ERROR";

export interface Order {
  id: string;
  cart_id: string;
  idempotency_key: string;
  status: OrderStatus;
  checkout: PricedCheckout;
  payment: ChargeResult;
  created_at: string;
}

export class DriftMart {
  readonly merchant: { id: string; name: string; origin: string };
  drift: DriftSettings = emptyDrift();
  private carts = new Map<string, Cart>();
  private ordersByKey = new Map<string, Order>();
  private orders = new Map<string, Order>();
  private inflight = new Map<string, Promise<Order>>();

  constructor(
    origin: string,
    private processor: CardProcessor,
    private clock: () => Date = () => new Date(),
  ) {
    this.merchant = { id: "drift-mart", name: "Drift Mart", origin };
  }

  get processorName() {
    return this.processor.name;
  }

  product(sku: string) {
    return CATALOG.find((p) => p.sku === sku);
  }

  createCart(): Cart {
    const cart: Cart = { id: randomUUID(), lines: [], shippingId: "std", createdAt: this.clock().toISOString() };
    this.carts.set(cart.id, cart);
    return cart;
  }

  getCart(id: string) {
    return this.carts.get(id);
  }

  addToCart(cartId: string, sku: string, quantity = 1): Cart {
    const cart = this.mustCart(cartId);
    if (!this.product(sku)) throw new HttpError(404, `Unknown sku ${sku}`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new HttpError(400, "quantity must be 1..10");
    const line = cart.lines.find((l) => l.sku === sku);
    if (line) line.quantity += quantity;
    else cart.lines.push({ sku, quantity });
    return cart;
  }

  setQuantity(cartId: string, sku: string, quantity: number): Cart {
    const cart = this.mustCart(cartId);
    cart.lines = cart.lines.filter((l) => l.sku !== sku);
    if (quantity > 0) cart.lines.push({ sku, quantity });
    return cart;
  }

  setShipping(cartId: string, shippingId: string): Cart {
    const cart = this.mustCart(cartId);
    if (!SHIPPING.some((s) => s.id === shippingId)) throw new HttpError(400, "unknown shipping option");
    cart.shippingId = shippingId;
    return cart;
  }

  /** Price the checkout NOW, applying any armed drift. */
  priceCheckout(cartId: string): PricedCheckout {
    const cart = this.mustCart(cartId);
    if (cart.lines.length === 0) throw new HttpError(400, "cart is empty");
    const d = this.drift;
    const lines: PricedLine[] = [];
    for (const l of cart.lines) {
      const subSku = d.substitutions[l.sku];
      const p = this.product(subSku ?? l.sku)!;
      if (!subSku && d.outOfStock.includes(l.sku)) continue; // silently dropped, like real stores do
      lines.push({
        sku: p.sku,
        title: p.title,
        quantity: l.quantity,
        unit_price: d.priceOverrides[p.sku] ?? p.price,
        note: subSku ? `Substituted for ${this.product(l.sku)!.title}` : undefined,
      });
    }
    if (lines.length === 0) throw new HttpError(409, "all items are out of stock");
    if (d.subscriptionAddon) {
      lines.push({
        sku: d.subscriptionAddon.sku,
        title: d.subscriptionAddon.title,
        quantity: 1,
        unit_price: d.subscriptionAddon.amount,
        recurring: { interval: d.subscriptionAddon.interval },
      });
    }
    const fees = d.surpriseFee ? [{ ...d.surpriseFee }] : [];
    const base = SHIPPING.find((s) => s.id === cart.shippingId)!;
    const ship = d.shippingDowngrade ? { ...base, ...d.shippingDowngrade } : base;
    const now = this.clock();
    const eta = new Date(now.getTime() + ship.days * 86_400_000);
    eta.setUTCHours(23, 59, 0, 0);
    const total =
      lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) + fees.reduce((s, f) => s + f.amount, 0) + ship.cost;
    return {
      cart_id: cart.id,
      merchant: this.merchant,
      currency: CURRENCY,
      lines,
      fees,
      fulfillment: { id: ship.id, method: "SHIPPING", title: ship.title, cost: ship.cost, latest_delivery_at: eta.toISOString() },
      total,
      priced_at: now.toISOString(),
    };
  }

  /**
   * Pay for a cart. Idempotent on `idempotencyKey`: a repeated call (e.g. the
   * agent retrying after a timeout) returns the original order, never a 2nd charge.
   * `expectedTotal` guards against paying a total the buyer didn't see.
   */
  async pay(cartId: string, idempotencyKey: string, expectedTotal: number, card: CardInput): Promise<Order> {
    if (!idempotencyKey || idempotencyKey.length < 10) throw new HttpError(400, "idempotency_key required");
    const existing = this.ordersByKey.get(idempotencyKey);
    if (existing) return existing;
    const pending = this.inflight.get(idempotencyKey);
    if (pending) return pending;

    const run = (async () => {
      const checkout = this.priceCheckout(cartId);
      if (checkout.total !== expectedTotal) {
        throw new HttpError(409, `total changed: expected ${expectedTotal}, now ${checkout.total}`);
      }
      const orderId = "DM-" + Date.now().toString(36).toUpperCase() + "-" + randomUUID().slice(0, 4).toUpperCase();
      const payment = await this.processor.charge({
        idempotencyKey,
        orderId,
        amount: checkout.total,
        currency: checkout.currency,
        card,
      });
      const order: Order = {
        id: orderId,
        cart_id: cartId,
        idempotency_key: idempotencyKey,
        status: payment.status === "SUCCEEDED" ? "PAID" : payment.status === "DECLINED" ? "DECLINED" : "ERROR",
        checkout,
        payment,
        created_at: this.clock().toISOString(),
      };
      this.ordersByKey.set(idempotencyKey, order);
      this.orders.set(order.id, order);
      return order;
    })();
    this.inflight.set(idempotencyKey, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(idempotencyKey);
    }
  }

  orderByKey(key: string) {
    return this.ordersByKey.get(key);
  }
  order(id: string) {
    return this.orders.get(id);
  }
  listOrders() {
    return [...this.orders.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  reset() {
    this.drift = emptyDrift();
    this.carts.clear();
    this.orders.clear();
    this.ordersByKey.clear();
  }

  private mustCart(id: string): Cart {
    const c = this.carts.get(id);
    if (!c) throw new HttpError(404, "cart not found");
    return c;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Ready-made drift scenarios for the demo console. */
export const SCENARIOS: Record<string, { label: string; apply: (d: DriftSettings) => void }> = {
  price_bump: { label: "Price +20% on cart items", apply: (d) => void (d.priceOverrides = { "cable-usbc-1m": 1199, "earbuds-lite": 4799, "monitor-27": 21999 }) },
  surprise_fee: { label: "Add $1.99 handling fee", apply: (d) => void (d.surpriseFee = { label: "Handling fee", amount: 199 }) },
  out_of_stock: { label: "USB-C 1m out of stock", apply: (d) => void (d.outOfStock = ["cable-usbc-1m"]) },
  substitution: { label: "Substitute 1m cable with 2m cable", apply: (d) => void (d.substitutions = { "cable-usbc-1m": "cable-usbc-2m" }) },
  subscription: {
    label: "Pre-ticked Care+ subscription ($2.99/month)",
    apply: (d) => void (d.subscriptionAddon = { sku: "care-plus-monthly", title: "Care+ Protection Plan", amount: 299, interval: "month" }),
  },
  slow_shipping: { label: "Shipping downgraded to Economy (8 days, $4.50)", apply: (d) => void (d.shippingDowngrade = { title: "Economy shipping (6-8 days)", cost: 450, days: 8 }) },
  payment_timeout: { label: "Drop next payment response (timeout)", apply: (d) => void (d.dropNextPaymentResponse = true) },
};
