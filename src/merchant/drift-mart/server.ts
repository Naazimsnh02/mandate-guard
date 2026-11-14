import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { formatMoney } from "../../lib/money.js";
import { AirwallexClient } from "../../lib/airwallex.js";
import { AirwallexProcessor, SimulatedProcessor, type CardProcessor } from "./processor.js";
import { CATALOG, CURRENCY, DriftMart, HttpError, SCENARIOS, SHIPPING, emptyDrift, type PricedCheckout } from "./store.js";

/**
 * Drift Mart — a demo merchant for Mandate Guard.
 *
 * Human/agent pages (Playwright reads these; key values are exposed as data-* attributes):
 *   GET  /                     catalog
 *   GET  /p/:sku               product page
 *   POST /cart/add             add to cart (form) → redirects to /cart/:id
 *   GET  /cart/:id             cart
 *   GET  /checkout/:id         checkout page (drift applied here!)
 *   POST /checkout/:id/pay     pay (card + idempotency_key + expected_total)
 *   GET  /orders/:id           order confirmation
 * Machine API:
 *   GET  /products.json        Shopify-style catalog
 *   POST /api/carts, POST /api/carts/:id/items, GET /api/checkout/:id
 *   GET  /api/orders?idempotency_key=…   (retry check)
 * Demo console:
 *   GET  /admin, POST /admin/scenario/:name, POST /admin/reset
 */
export function buildDriftMart(opts: { origin: string; processor: CardProcessor; logger?: boolean }): {
  app: FastifyInstance;
  store: DriftMart;
} {
  const store = new DriftMart(opts.origin, opts.processor);
  const app = Fastify({ logger: opts.logger ?? false });
  app.register(formbody);

  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof HttpError ? err.status : ((err as { statusCode?: number }).statusCode ?? 500);
    reply.status(status).send({ error: (err as Error).message });
  });

  const m = (n: number) => formatMoney(n, CURRENCY);
  const droppedKeys = new Map<string, number>(); // idempotency_key → drop responses until (ms)

  // ---------- pages ----------
  app.get("/", async (_req, reply) =>
    html(reply, "Drift Mart", `
      <h1>Drift Mart</h1><p class="muted">Demo electronics store · prices in ${CURRENCY}</p>
      <div class="grid">${CATALOG.map((p) => `
        <a class="card product" href="/p/${p.sku}" data-sku="${p.sku}" data-price="${p.price}">
          <div class="emoji">${p.image}</div><div class="title">${esc(p.title)}</div>
          <div class="price">${m(p.price)}</div></a>`).join("")}
      </div>`),
  );

  app.get<{ Params: { sku: string }; Querystring: { cart?: string } }>("/p/:sku", async (req, reply) => {
    const p = store.product(req.params.sku);
    const cartId = req.query.cart && store.getCart(req.query.cart) ? req.query.cart : "";
    if (!p) throw new HttpError(404, "product not found");
    return html(reply, p.title, `
      <a href="/">← All products</a>
      <div class="card" id="product" data-sku="${p.sku}" data-title="${esc(p.title)}" data-price="${p.price}" data-currency="${CURRENCY}" data-stock="${p.stock}">
        <div class="emoji big">${p.image}</div>
        <h1>${esc(p.title)}</h1><p>${esc(p.description)}</p>
        <p class="price" id="price">${m(p.price)}</p>
        <p class="muted">Standard shipping ${m(SHIPPING[0]!.cost)} · arrives in 3-5 days</p>
        <form method="post" action="/cart/add">
          <input type="hidden" name="sku" value="${p.sku}">
          <input type="hidden" name="cart_id" value="${esc(cartId)}">
          <label>Qty <input name="quantity" type="number" min="1" max="10" value="1"></label>
          <button id="add-to-cart" type="submit">Add to cart</button>
        </form>
      </div>`);
  });

  app.post<{ Body: { sku: string; quantity?: string; cart_id?: string } }>("/cart/add", async (req, reply) => {
    const cart = (req.body.cart_id && store.getCart(req.body.cart_id)) || store.createCart();
    store.addToCart(cart.id, req.body.sku, Number(req.body.quantity ?? 1));
    return reply.redirect(`/cart/${cart.id}`);
  });

  app.get<{ Params: { id: string } }>("/cart/:id", async (req, reply) => {
    const cart = store.getCart(req.params.id);
    if (!cart) throw new HttpError(404, "cart not found");
    const rows = cart.lines.map((l) => {
      const p = store.product(l.sku)!;
      return `<tr class="line" data-sku="${p.sku}" data-quantity="${l.quantity}" data-unit-price="${p.price}">
        <td>${esc(p.title)}</td><td>${l.quantity}</td><td>${m(p.price)}</td><td>${m(p.price * l.quantity)}</td></tr>`;
    });
    return html(reply, "Cart", `
      <h1>Your cart</h1>
      <table><tr><th>Item</th><th>Qty</th><th>Price</th><th>Subtotal</th></tr>${rows.join("")}</table>
      <form method="post" action="/cart/${cart.id}/shipping">
        <label>Delivery <select name="shipping_id" id="shipping">${SHIPPING.map((s) => `<option value="${s.id}" ${s.id === cart.shippingId ? "selected" : ""}>${esc(s.title)} · ${m(s.cost)}</option>`).join("")}</select></label>
        <button type="submit">Update</button>
      </form>
      <p><a class="btn" id="go-to-checkout" href="/checkout/${cart.id}">Proceed to checkout</a></p>`);
  });

  app.post<{ Params: { id: string }; Body: { shipping_id: string } }>("/cart/:id/shipping", async (req, reply) => {
    store.setShipping(req.params.id, req.body.shipping_id);
    return reply.redirect(`/cart/${req.params.id}`);
  });

  app.get<{ Params: { id: string } }>("/checkout/:id", async (req, reply) => {
    const c = store.priceCheckout(req.params.id);
    return html(reply, "Checkout", checkoutPage(c, m));
  });

  app.post<{ Params: { id: string }; Body: Record<string, string> }>("/checkout/:id/pay", async (req, reply) => {
    const b = req.body;
    const key = b.idempotency_key ?? "";
    // Browsers silently retry a POST once after a connection reset, so keep dropping
    // responses for the same payment for a short window to simulate a real outage.
    if (store.drift.dropNextPaymentResponse) {
      store.drift.dropNextPaymentResponse = false;
      droppedKeys.set(key, Date.now() + 10_000);
    }
    const dropResponse = (droppedKeys.get(key) ?? 0) > Date.now();
    const order = await store.pay(req.params.id, b.idempotency_key ?? "", Number(b.expected_total), {
      number: b.card_number ?? "",
      expiry_month: b.expiry_month ?? "",
      expiry_year: b.expiry_year ?? "",
      cvc: b.cvc ?? "",
      name: b.card_name ?? "",
    });
    if (dropResponse) {
      // Charge went through, but the buyer never hears back: a realistic timeout.
      reply.raw.destroy();
      return reply;
    }
    if (req.headers.accept?.includes("application/json")) return orderJson(order);
    return reply.redirect(`/orders/${order.id}`);
  });

  app.get<{ Params: { id: string } }>("/orders/:id", async (req, reply) => {
    const o = store.order(req.params.id);
    if (!o) throw new HttpError(404, "order not found");
    return html(reply, `Order ${o.id}`, `
      <div class="card" id="order" data-order-id="${o.id}" data-status="${o.status}" data-total="${o.checkout.total}"
           data-payment-reference="${o.payment.reference ?? ""}" data-failure-reason="${o.payment.failure_reason ?? ""}">
        <h1>${o.status === "PAID" ? "✅ Order confirmed" : "❌ Payment " + o.status.toLowerCase()}</h1>
        <p>Order number <b id="order-number">${o.id}</b></p>
        <p>Total ${m(o.checkout.total)} · card •••• ${o.payment.card_last4} · processor ${o.payment.processor}</p>
        ${o.payment.failure_reason ? `<p class="warn">Reason: ${esc(o.payment.failure_reason)}</p>` : ""}
      </div>`);
  });

  // ---------- machine API ----------
  app.get("/products.json", async () => ({
    products: CATALOG.map((p) => ({
      id: p.sku,
      title: p.title,
      handle: p.sku,
      body_html: p.description,
      variants: [{ id: p.sku, sku: p.sku, price: (p.price / 100).toFixed(2), available: p.stock > 0 }],
    })),
  }));
  app.post("/api/carts", async () => store.createCart());
  app.post<{ Params: { id: string }; Body: { sku: string; quantity?: number } }>("/api/carts/:id/items", async (req) =>
    store.addToCart(req.params.id, req.body.sku, req.body.quantity ?? 1),
  );
  app.get("/api/shipping", async () => SHIPPING.map((s) => ({ id: s.id, title: s.title, cost: s.cost })));
  app.post<{ Params: { id: string }; Body: { shipping_id: string } }>("/api/carts/:id/shipping", async (req) =>
    store.setShipping(req.params.id, req.body.shipping_id),
  );
  app.get<{ Params: { id: string } }>("/api/checkout/:id", async (req) => store.priceCheckout(req.params.id));
  app.get<{ Querystring: { idempotency_key?: string } }>("/api/orders", async (req) => {
    if (req.query.idempotency_key) {
      const o = store.orderByKey(req.query.idempotency_key);
      return { orders: o ? [orderJson(o)] : [] };
    }
    return { orders: store.listOrders().map(orderJson) };
  });

  // ---------- demo console ----------
  app.get("/admin", async (_req, reply) =>
    html(reply, "Drift console", `
      <h1>Drift console</h1>
      <p class="muted">Arm a change, then let the agent reach checkout. Processor: <b>${store.processorName}</b></p>
      <div class="grid">${Object.entries(SCENARIOS).map(([k, s]) => `
        <form method="post" action="/admin/scenario/${k}"><button class="wide">${esc(s.label)}</button></form>`).join("")}
      </div>
      <form method="post" action="/admin/reset"><button class="danger">Reset drift + orders</button></form>
      <h2>Armed drift</h2><pre id="drift">${esc(JSON.stringify(store.drift, null, 2))}</pre>
      <h2>Orders</h2><pre>${esc(JSON.stringify(store.listOrders().map(orderJson), null, 2))}</pre>`),
  );
  app.get("/admin/drift", async () => store.drift);
  app.post<{ Params: { name: string } }>("/admin/scenario/:name", async (req, reply) => {
    const s = SCENARIOS[req.params.name];
    if (!s) throw new HttpError(404, "unknown scenario");
    s.apply(store.drift);
    return req.headers.accept?.includes("application/json") ? store.drift : reply.redirect("/admin");
  });
  app.post("/admin/drift/clear", async () => ((store.drift = emptyDrift()), store.drift));
  app.post("/admin/reset", async (req, reply) => {
    store.reset();
    return req.headers.accept?.includes("application/json") ? { ok: true } : reply.redirect("/admin");
  });

  return { app, store };
}

function checkoutPage(c: PricedCheckout, m: (n: number) => string): string {
  const lines = c.lines
    .map(
      (l) => `<tr class="line" data-sku="${l.sku}" data-title="${esc(l.title)}" data-quantity="${l.quantity}" data-unit-price="${l.unit_price}" ${l.recurring ? `data-recurring="${l.recurring.interval}"` : ""}>
      <td>${esc(l.title)}${l.note ? `<div class="warn small">${esc(l.note)}</div>` : ""}${l.recurring ? `<div class="small"><label><input type="checkbox" checked disabled> Renews every ${l.recurring.interval}</label></div>` : ""}</td>
      <td>${l.quantity}</td><td>${m(l.unit_price)}</td><td>${m(l.unit_price * l.quantity)}</td></tr>`,
    )
    .join("");
  const fees = c.fees
    .map((f) => `<tr class="fee" data-label="${esc(f.label)}" data-amount="${f.amount}"><td colspan="3">${esc(f.label)}</td><td>${m(f.amount)}</td></tr>`)
    .join("");
  const f = c.fulfillment;
  return `
  <h1>Checkout</h1>
  <div id="checkout" data-merchant-id="${c.merchant.id}" data-origin="${c.merchant.origin}" data-currency="${c.currency}" data-total="${c.total}" data-priced-at="${c.priced_at}">
    <table><tr><th>Item</th><th>Qty</th><th>Price</th><th>Subtotal</th></tr>${lines}
      <tr id="fulfillment" data-method="${f.method}" data-title="${esc(f.title)}" data-cost="${f.cost}" data-latest-delivery-at="${f.latest_delivery_at}">
        <td colspan="3">${esc(f.title)} · arrives by ${f.latest_delivery_at.slice(0, 10)}</td><td>${m(f.cost)}</td></tr>
      ${fees}
      <tr class="total"><td colspan="3"><b>Total</b></td><td id="total"><b>${m(c.total)}</b></td></tr>
    </table>
  </div>
  <form method="post" action="/checkout/${c.cart_id}/pay" id="pay-form" class="card">
    <h2>Payment</h2>
    <input type="hidden" name="expected_total" value="${c.total}">
    <input type="hidden" name="idempotency_key" id="idempotency_key" value="">
    <label>Name on card <input name="card_name" id="card_name" autocomplete="off"></label>
    <label>Card number <input name="card_number" id="card_number" inputmode="numeric" autocomplete="off"></label>
    <div class="row"><label>MM <input name="expiry_month" id="expiry_month" size="2"></label>
    <label>YYYY <input name="expiry_year" id="expiry_year" size="4"></label>
    <label>CVC <input name="cvc" id="cvc" size="4" autocomplete="off"></label></div>
    <button type="submit" id="place-order">Place order · ${m(c.total)}</button>
    <p class="muted small">Sandbox demo merchant. Use test card credentials only.</p>
  </form>
  <script>document.getElementById('idempotency_key').value ||= crypto.randomUUID();</script>`;
}

function orderJson(o: ReturnType<DriftMart["listOrders"]>[number]) {
  return {
    order_id: o.id,
    status: o.status,
    total: o.checkout.total,
    currency: o.checkout.currency,
    idempotency_key: o.idempotency_key,
    payment: o.payment,
    created_at: o.created_at,
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function html(reply: FastifyReply, title: string, body: string) {
  return reply.type("text/html; charset=utf-8").send(`<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)} · Drift Mart</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#111}
a{color:#0b5}.muted{color:#666}.small{font-size:.85em}.warn{color:#b45309}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:1rem}
.card{border:1px solid #ddd;border-radius:12px;padding:1rem;display:block;text-decoration:none;color:inherit;margin:1rem 0}
.emoji{font-size:2rem}.emoji.big{font-size:4rem}.price{font-weight:700;font-size:1.2rem}
table{width:100%;border-collapse:collapse}td,th{padding:.5rem;border-bottom:1px solid #eee;text-align:left}
label{display:block;margin:.5rem 0}input,select{padding:.4rem;font-size:1rem}.row{display:flex;gap:1rem}
button,.btn{background:#111;color:#fff;border:0;border-radius:8px;padding:.6rem 1rem;font-size:1rem;cursor:pointer;text-decoration:none;display:inline-block}
button.wide{width:100%}button.danger{background:#b91c1c;margin-top:1rem}pre{background:#f6f6f6;padding:1rem;overflow:auto}
</style></head><body>${body}</body></html>`);
}

// ---------- entrypoint ----------
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  const port = Number(process.env.DRIFT_MART_PORT ?? 4000);
  const origin = process.env.DRIFT_MART_ORIGIN ?? `http://localhost:${port}`;
  const processor: CardProcessor =
    process.env.DRIFT_MART_PROCESSOR === "airwallex" ? new AirwallexProcessor(AirwallexClient.fromEnv()) : new SimulatedProcessor();
  const { app } = buildDriftMart({ origin, processor, logger: true });
  app.listen({ port, host: "127.0.0.1" }).then(() => console.log(`Drift Mart on ${origin} (processor: ${processor.name}) · console: ${origin}/admin`));
}
