/**
 * Start everything for a local demo:
 *   Drift Mart (merchant)  http://localhost:4000   console: /admin
 *   Mandate Guard (app)    http://localhost:3000
 *
 * Env:
 *   MERCHANT_ADAPTER=http|browser   (browser = Playwright driving the real pages; HEADED=1 to watch)
 *   GATEWAY=test|airi               (test = Airi-compatible 4111 test card stub)
 *   DRIFT_MART_PROCESSOR=simulated|airwallex
 */
import { AuditLog } from "./audit/log.js";
import { AirwallexClient } from "./lib/airwallex.js";
import { loadOrCreateKeys } from "./mandate/signer.js";
import { BrowserDriftMartAdapter } from "./merchant/drift-mart/browser-adapter.js";
import { HttpDriftMartAdapter } from "./merchant/drift-mart/http-adapter.js";
import { AirwallexProcessor, SimulatedProcessor, type CardProcessor } from "./merchant/drift-mart/processor.js";
import { buildDriftMart } from "./merchant/drift-mart/server.js";
import { AiriCliGateway, TestCardGateway, type PaymentGateway } from "./payments/gateway.js";
import { buildApp } from "./app/server.js";

const env = process.env;
const martPort = Number(env.DRIFT_MART_PORT ?? 4000);
const appPort = Number(env.APP_PORT ?? 3000);
const origin = env.DRIFT_MART_ORIGIN ?? `http://localhost:${martPort}`;

const processor: CardProcessor = env.DRIFT_MART_PROCESSOR === "airwallex" ? new AirwallexProcessor(AirwallexClient.fromEnv()) : new SimulatedProcessor();
const mart = buildDriftMart({ origin, processor });
await mart.app.listen({ port: martPort, host: "127.0.0.1" });

const adapterName = env.MERCHANT_ADAPTER === "browser" ? "browser" : "http";
const merchant =
  adapterName === "browser"
    ? new BrowserDriftMartAdapter(origin, { headless: env.HEADED !== "1", slowMo: env.HEADED === "1" ? 150 : undefined })
    : new HttpDriftMartAdapter(origin);
const gateway: PaymentGateway = env.GATEWAY === "airi" ? new AiriCliGateway() : new TestCardGateway(20_000);
const keys = await loadOrCreateKeys(env.MANDATE_SIGNING_KEY_PATH ?? "./data/keys/mandate-ed25519.jwk");
const audit = new AuditLog(env.AUDIT_LOG_PATH ?? "./data/audit/audit.jsonl");

const { app } = buildApp({
  merchant,
  gateway,
  keys,
  audit,
  issuerLimit: 20_000,
  agentEnabled: Boolean(env.ANTHROPIC_API_KEY),
  adapterName,
});
await app.listen({ port: appPort, host: "127.0.0.1" });

console.log(`Drift Mart     ${origin}  (processor: ${processor.name}, console: ${origin}/admin)`);
console.log(`Mandate Guard  http://localhost:${appPort}  (adapter: ${adapterName}, gateway: ${gateway.name})`);
const v = audit.verify();
console.log(`Audit log      ${v.ok ? `intact, ${v.count} entries` : `BROKEN at #${v.brokenAt}`}`);

const shutdown = async () => {
  await merchant.close();
  await Promise.all([app.close(), mart.app.close()]);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
