import { afterEach, describe, expect, it } from "vitest";
import { buildDriftMart } from "../src/merchant/drift-mart/server.js";
import { SimulatedProcessor, luhnValid, type ChargeRequest } from "../src/merchant/drift-mart/processor.js";
import { pricedCheckoutToSnapshot } from "../src/merchant/drift-mart/to-snapshot.js";
import type { PricedCheckout } from "../src/merchant/drift-mart/store.js";
import { generateMandateKeys, issueMandate } from "../src/mandate/signer.js";
import { evaluate } from "../src/policy/engine.js";

const ORIGIN = "http://localhost:4000";
const TEST_CARD = { number: "4111111111111111", expiry_month: "12", expiry_year: "2030", cvc: "123", name: "Test Shopper" };

class CountingProcessor extends SimulatedProcessor {
  calls: ChargeRequest[] = [];
  override async charge(req: ChargeRequest) {
    this.calls.push(req);
    return super.charge(req);
  }
}

let built: ReturnType<typeof buildDriftMart>;
let proc: CountingProcessor;
const setup = () => {
  proc = new CountingProcessor();
  built = buildDriftMart({ origin: ORIGIN, processor: proc });
  return built;
};
afterEach(async () => built?.app.close());

async function cartWith(sku: string) {
  const { app } = built;
  const cart = (await app.inject({ method: "POST", url: "/api/carts" })).json<{ id: string }>();
  await app.inject({ method: "POST", url: `/api/carts/${cart.id}/items`, payload: { sku } });
  return cart.id;
}
const checkout = async (id: string) => (await built.app.inject({ method: "GET", url: `/api/checkout/${id}` })).json<PricedCheckout>();

async function mandateFor(c: PricedCheckout) {
  const keys = await generateMandateKeys();
  return (
    await issueMandate(
      {
        intent: "USB-C cable under $15",
        merchant: { id: c.merchant.id, name: c.merchant.name, origin: c.merchant.origin },
        currency: c.currency,
        items: c.lines.map((l) => ({ sku: l.sku, title: l.title, quantity: l.quantity, unit_price: l.unit_price })),
        fulfillment: c.fulfillment,
        fees: [],
        total_cap: c.total,
      },
      keys,
    )
  ).mandate;
}

describe("Drift Mart", () => {
  it("serves catalog pages and products.json", async () => {
    const { app } = setup();
    const home = await app.inject({ method: "GET", url: "/" });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('data-sku="cable-usbc-1m"');
    const pj = (await app.inject({ method: "GET", url: "/products.json" })).json<{ products: unknown[] }>();
    expect(pj.products.length).toBe(8);
  });

  it("checkout with no drift MATCHes the mandate", async () => {
    setup();
    const id = await cartWith("cable-usbc-1m");
    const c = await checkout(id);
    expect(c.total).toBe(999 + 300);
    const m = await mandateFor(c);
    expect(evaluate(m, pricedCheckoutToSnapshot(c)).decision).toBe("MATCH");
  });

  it.each([
    ["price_bump", ["PRICE_INCREASED", "TOTAL_EXCEEDS_CAP"]],
    ["surprise_fee", ["FEE_ADDED", "TOTAL_EXCEEDS_CAP"]],
    ["substitution", ["ITEM_SUBSTITUTED", "TOTAL_EXCEEDS_CAP"]],
    ["subscription", ["RECURRING_ADDED", "TOTAL_EXCEEDS_CAP"]],
    ["slow_shipping", ["DELIVERY_LATER", "FULFILLMENT_CHANGED", "FULFILLMENT_COST_INCREASED", "TOTAL_EXCEEDS_CAP"]],
  ])("scenario %s is caught as DRIFT", async (scenario, expected) => {
    const { app } = setup();
    const id = await cartWith("cable-usbc-1m");
    const m = await mandateFor(await checkout(id)); // shopper approves BEFORE drift
    await app.inject({ method: "POST", url: `/admin/scenario/${scenario}`, headers: { accept: "application/json" } });
    const r = evaluate(m, pricedCheckoutToSnapshot(await checkout(id)));
    expect(r.decision).toBe("DRIFT");
    expect(r.findings.map((f) => f.code).sort()).toEqual(expected);
  });

  it("out-of-stock in a 2-item cart is caught as ITEM_REMOVED", async () => {
    const { app } = setup();
    const id = await cartWith("cable-usbc-1m");
    await app.inject({ method: "POST", url: `/api/carts/${id}/items`, payload: { sku: "charger-30w" } });
    const m = await mandateFor(await checkout(id));
    await app.inject({ method: "POST", url: "/admin/scenario/out_of_stock", headers: { accept: "application/json" } });
    const r = evaluate(m, pricedCheckoutToSnapshot(await checkout(id)));
    expect(r.findings.map((f) => f.code)).toEqual(["ITEM_REMOVED"]);
  });

  it("pay is idempotent: same key → one charge, same order", async () => {
    const { app } = setup();
    const id = await cartWith("cable-usbc-1m");
    const total = (await checkout(id)).total;
    const form = {
      idempotency_key: "11111111-2222-4333-8444-555555555555",
      expected_total: String(total),
      card_number: TEST_CARD.number,
      expiry_month: TEST_CARD.expiry_month,
      expiry_year: TEST_CARD.expiry_year,
      cvc: TEST_CARD.cvc,
      card_name: TEST_CARD.name,
    };
    const pay = () => app.inject({ method: "POST", url: `/checkout/${id}/pay`, headers: { accept: "application/json" }, payload: form });
    const [a, b] = await Promise.all([pay(), pay()]);
    const c = await pay();
    expect(a.json().order_id).toBe(b.json().order_id);
    expect(c.json().order_id).toBe(a.json().order_id);
    expect(a.json().status).toBe("PAID");
    expect(proc.calls).toHaveLength(1);
    const lookup = (await app.inject({ method: "GET", url: `/api/orders?idempotency_key=${form.idempotency_key}` })).json();
    expect(lookup.orders[0].order_id).toBe(a.json().order_id);
  });

  it("refuses to charge if the total changed since the buyer saw it", async () => {
    const { app } = setup();
    const id = await cartWith("cable-usbc-1m");
    const seen = (await checkout(id)).total;
    await app.inject({ method: "POST", url: "/admin/scenario/surprise_fee", headers: { accept: "application/json" } });
    const res = await app.inject({
      method: "POST",
      url: `/checkout/${id}/pay`,
      headers: { accept: "application/json" },
      payload: { idempotency_key: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", expected_total: String(seen), card_number: TEST_CARD.number, expiry_month: "12", expiry_year: "2030", cvc: "123", card_name: "T" },
    });
    expect(res.statusCode).toBe(409);
    expect(proc.calls).toHaveLength(0);
  });

  it("declines bad cards", async () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    const r = await new SimulatedProcessor().charge({ idempotencyKey: "k".repeat(12), orderId: "o", amount: 100, currency: "USD", card: { ...TEST_CARD, number: "4000000000000002" } });
    expect(r.status).toBe("DECLINED");
  });

  it("checkout page exposes machine-readable data attributes", async () => {
    const { app } = setup();
    const id = await cartWith("cable-usbc-1m");
    const page = await app.inject({ method: "GET", url: `/checkout/${id}` });
    expect(page.body).toContain('data-total="1299"');
    expect(page.body).toContain('id="place-order"');
  });
});
