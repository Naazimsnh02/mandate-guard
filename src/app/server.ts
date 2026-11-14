import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planPurchase, ShopperError, MODEL } from "../agent/shopper.js";
import { AuditLog } from "../audit/log.js";
import type { MandateKeys } from "../mandate/signer.js";
import type { MerchantAdapter } from "../merchant/adapter.js";
import { Orchestrator, SessionError, type ProposalInput } from "../orchestrator/session.js";
import type { AiriCliGateway, PaymentGateway } from "../payments/gateway.js";
import { toMinor } from "../lib/money.js";

export interface AppDeps {
  merchant: MerchantAdapter;
  gateway: PaymentGateway;
  keys: MandateKeys;
  audit: AuditLog;
  issuerLimit?: number;
  /** Set false to disable the LLM (manual SKU picks only). */
  agentEnabled?: boolean;
  adapterName?: string;
}

const UI = readFileSync(fileURLToPath(new URL("./ui.html", import.meta.url)), "utf8");

export function buildApp(d: AppDeps): { app: FastifyInstance; orch: Orchestrator } {
  const orch = new Orchestrator({ merchant: d.merchant, gateway: d.gateway, keys: d.keys, audit: d.audit, issuerLimit: d.issuerLimit });
  const app = Fastify({ logger: false });
  const transcripts = new Map<string, string[]>();

  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof SessionError ? err.status : err instanceof ShopperError ? 422 : ((err as { statusCode?: number }).statusCode ?? 500);
    reply.status(status).send({ error: (err as Error).message });
  });

  const view = (id: string) => {
    const s = orch.get(id);
    return { session: s, transcript: transcripts.get(id) ?? [], audit: d.audit.forSession(id) };
  };

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(UI));

  app.get("/api/config", async () => ({
    merchant: d.merchant.merchant,
    adapter: d.adapterName ?? "http",
    gateway: d.gateway.name,
    model: d.agentEnabled === false ? null : MODEL,
    issuer_limit: d.issuerLimit ?? null,
  }));

  app.get("/api/products", async () => d.merchant.searchProducts(""));
  app.get("/api/shipping", async () => d.merchant.shippingOptions());

  app.post<{
    Body: { intent: string; budget?: number | string; deliver_by?: string; sku?: string; quantity?: number; shipping_id?: string };
  }>("/api/sessions", async (req) => {
    const b = req.body;
    if (!b?.intent?.trim()) throw new SessionError(400, "intent is required");
    const budget = b.budget !== undefined && b.budget !== "" ? toMinor(Number(b.budget), "USD") : undefined;
    const deliver_by = b.deliver_by ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(b.deliver_by) ? `${b.deliver_by}T23:59:00Z` : b.deliver_by).toISOString() : undefined;

    let proposal: ProposalInput;
    let transcript: string[] = [];
    if (b.sku) {
      proposal = { intent: b.intent, items: [{ sku: b.sku, quantity: b.quantity ?? 1 }], shipping_id: b.shipping_id ?? "std", budget, deliver_by, rationale: "Picked manually." };
    } else {
      if (d.agentEnabled === false) throw new SessionError(400, "Agent disabled: pick a product manually");
      ({ proposal, transcript } = await planPurchase(b.intent, d.merchant, { budget, deliver_by }));
    }
    const s = await orch.propose(proposal);
    transcripts.set(s.id, transcript);
    return view(s.id);
  });

  app.get("/api/sessions", async () => orch.list().map((s) => ({ id: s.id, intent: s.intent, state: s.state, created_at: s.created_at })));
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req) => view(req.params.id));
  app.post<{ Params: { id: string }; Body: { total_cap?: number } }>("/api/sessions/:id/approve", async (req) => {
    await orch.approve(req.params.id, { total_cap: req.body?.total_cap });
    return view(req.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/sessions/:id/reject", async (req) => (await orch.reject(req.params.id), view(req.params.id)));
  app.post<{ Params: { id: string } }>("/api/sessions/:id/checkout", async (req) => (await orch.checkout(req.params.id), view(req.params.id)));
  app.post<{ Params: { id: string } }>("/api/sessions/:id/reconcile", async (req) => (await orch.reconcile(req.params.id), view(req.params.id)));

  app.get("/api/audit/verify", async () => d.audit.verify());
  app.get("/api/gateway/status", async () => {
    const g = d.gateway as Partial<AiriCliGateway>;
    if (typeof g.whoami !== "function") return { gateway: d.gateway.name, signed_in: null };
    try {
      // whoami also returns contact details (phone, email): expose only sign-in state.
      const w = await g.whoami();
      return { gateway: d.gateway.name, signed_in: w.authenticated === true, session_expires: w.session_expires };
    } catch (err) {
      return { gateway: d.gateway.name, error: (err as Error).message };
    }
  });

  // Demo helpers: arm a drift scenario on the merchant (proxied, so the UI is one page).
  const origin = d.merchant.merchant.origin;
  app.post<{ Params: { name: string } }>("/api/demo/scenario/:name", async (req) => {
    const r = await fetch(`${origin}/admin/scenario/${encodeURIComponent(req.params.name)}`, { method: "POST", headers: { accept: "application/json" } });
    if (!r.ok) throw new SessionError(r.status, await r.text());
    return r.json();
  });
  app.post("/api/demo/reset", async () => {
    await fetch(`${origin}/admin/reset`, { method: "POST", headers: { accept: "application/json" } });
    return { ok: true };
  });
  app.get("/api/demo/drift", async () => (await fetch(`${origin}/admin/drift`)).json());

  return { app, orch };
}
