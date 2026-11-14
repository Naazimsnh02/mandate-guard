/** End-to-end smoke test of the Playwright adapter (needs Google Chrome installed). HEADED=1 to watch. */
import { AuditLog } from "../src/audit/log.js";
import { generateMandateKeys } from "../src/mandate/signer.js";
import { BrowserDriftMartAdapter } from "../src/merchant/drift-mart/browser-adapter.js";
import { SimulatedProcessor } from "../src/merchant/drift-mart/processor.js";
import { buildDriftMart } from "../src/merchant/drift-mart/server.js";
import { SCENARIOS } from "../src/merchant/drift-mart/store.js";
import { Orchestrator } from "../src/orchestrator/session.js";
import { TestCardGateway } from "../src/payments/gateway.js";

const port = 4555;
const origin = `http://localhost:${port}`;
const mart = buildDriftMart({ origin, processor: new SimulatedProcessor() });
await mart.app.listen({ port, host: "127.0.0.1" });
const adapter = new BrowserDriftMartAdapter(origin, { headless: process.env.HEADED !== "1" });
const audit = new AuditLog();
const orch = new Orchestrator({ merchant: adapter, gateway: new TestCardGateway(), keys: await generateMandateKeys(), audit, issuerLimit: 20_000 });
const check = (cond: boolean, label: string) => { console.log(`${cond ? "✔" : "✘"} ${label}`); if (!cond) process.exitCode = 1; };

try {
  const found = await adapter.searchProducts("usb-c cable");
  check(found[0]?.sku.startsWith("cable-usbc") ?? false, `search → ${found.map((p) => p.sku).join(", ")}`);

  // 1. price drift → re-consent → resume same cart → paid
  const s = await orch.propose({ intent: "USB-C cable", items: [{ sku: "cable-usbc-1m", quantity: 2 }], shipping_id: "exp" });
  check(s.pending_terms?.total_cap === 999 * 2 + 900, `proposal total ${s.pending_terms?.total_cap}`);
  await orch.approve(s.id);
  SCENARIOS.price_bump!.apply(mart.store.drift);
  await orch.checkout(s.id);
  check(s.state === "AWAITING_RECONSENT", `drift → ${s.state} (${s.last_policy?.findings.map((f) => f.code).join(",")})`);
  await orch.approve(s.id);
  await orch.checkout(s.id);
  check(s.state === "PAID", `re-consent + checkout → ${s.state} ${s.message}`);

  // 2. timeout → reconcile → exactly one order
  mart.store.reset();
  const t = await orch.propose({ intent: "earbuds", items: [{ sku: "earbuds-lite", quantity: 1 }], shipping_id: "std" });
  await orch.approve(t.id);
  SCENARIOS.payment_timeout!.apply(mart.store.drift);
  await orch.checkout(t.id);
  check(t.state === "PAID", `timeout → ${t.state}`);
  check(mart.store.listOrders().length === 1, `orders at merchant: ${mart.store.listOrders().length}`);
  check(JSON.stringify(audit.all()).includes("PAYMENT_UNCONFIRMED"), "audit shows PAYMENT_UNCONFIRMED");
  check(audit.verify().ok, "audit chain intact");
} finally {
  await adapter.close();
  await mart.app.close();
}
