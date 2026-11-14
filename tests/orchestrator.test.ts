import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/log.js";
import { generateMandateKeys } from "../src/mandate/signer.js";
import { HttpDriftMartAdapter } from "../src/merchant/drift-mart/http-adapter.js";
import { SimulatedProcessor, type ChargeRequest } from "../src/merchant/drift-mart/processor.js";
import { buildDriftMart } from "../src/merchant/drift-mart/server.js";
import { SCENARIOS } from "../src/merchant/drift-mart/store.js";
import { Orchestrator } from "../src/orchestrator/session.js";
import { TestCardGateway } from "../src/payments/gateway.js";

class CountingProcessor extends SimulatedProcessor {
  calls: ChargeRequest[] = [];
  override async charge(req: ChargeRequest) {
    this.calls.push(req);
    return super.charge(req);
  }
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

let mart: ReturnType<typeof buildDriftMart>;
let proc: CountingProcessor;
let gateway: TestCardGateway;
let audit: AuditLog;
let orch: Orchestrator;

beforeEach(async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  proc = new CountingProcessor();
  mart = buildDriftMart({ origin, processor: proc });
  await mart.app.listen({ port, host: "127.0.0.1" });
  gateway = new TestCardGateway();
  audit = new AuditLog();
  orch = new Orchestrator({
    merchant: new HttpDriftMartAdapter(origin),
    gateway,
    keys: await generateMandateKeys(),
    audit,
    issuerLimit: 20_000,
  });
});
afterEach(async () => mart.app.close());

const arm = (name: string) => SCENARIOS[name]!.apply(mart.store.drift);
const proposeCable = () =>
  orch.propose({ intent: "USB-C cable under $15", items: [{ sku: "cable-usbc-1m", quantity: 1 }], shipping_id: "std", budget: 1500 });
const types = (id: string) => audit.forSession(id).map((e) => e.type);

describe("Orchestrator", () => {
  it("happy path: propose → approve → checkout → PAID, result reported", async () => {
    const s = await proposeCable();
    expect(s.state).toBe("PROPOSED");
    expect(s.pending_terms?.total_cap).toBe(1299);
    await orch.approve(s.id);
    await orch.checkout(s.id);
    expect(s.state).toBe("PAID");
    expect(s.order?.total).toBe(1299);
    expect(s.mandates[0]!.status).toBe("CONSUMED");
    expect(proc.calls).toHaveLength(1);
    expect([...gateway.reports.values()][0]?.status).toBe("SUCCEEDED");
    expect(types(s.id)).toEqual([
      "PROPOSED",
      "APPROVED",
      "MANDATE_VERIFIED",
      "CHECKOUT_OBSERVED",
      "CREDENTIAL_ISSUED",
      "PAYMENT_SUBMITTED",
      "PAID",
      "RESULT_REPORTED",
    ]);
    expect(audit.verify().ok).toBe(true);
  });

  it("rejects proposals over budget or past the deadline", async () => {
    await expect(
      orch.propose({ intent: "x", items: [{ sku: "keyboard-mech", quantity: 1 }], shipping_id: "std", budget: 5000 }),
    ).rejects.toThrow(/over the budget/);
    await expect(
      orch.propose({ intent: "x", items: [{ sku: "cable-usbc-1m", quantity: 1 }], shipping_id: "std", deliver_by: new Date().toISOString() }),
    ).rejects.toThrow(/later than the deadline/);
  });

  it("price drift pauses, re-consent issues a superseding mandate and resumes the SAME cart", async () => {
    const s = await proposeCable();
    const cart = s.cart_id;
    await orch.approve(s.id);
    arm("price_bump");
    await orch.checkout(s.id);
    expect(s.state).toBe("AWAITING_RECONSENT");
    expect(proc.calls).toHaveLength(0);
    expect(s.last_policy?.findings.map((f) => f.code)).toContain("PRICE_INCREASED");

    await orch.approve(s.id);
    expect(s.mandates).toHaveLength(2);
    expect(s.mandates[0]!.status).toBe("SUPERSEDED");
    expect(s.mandates[1]!.mandate.supersedes).toBe(s.mandates[0]!.mandate.mandate_id);

    await orch.checkout(s.id);
    expect(s.state).toBe("PAID");
    expect(s.cart_id).toBe(cart);
    expect(proc.calls).toHaveLength(1);
    expect(s.order?.total).toBe(s.mandates[1]!.mandate.total_cap);
  });

  it("rejecting re-consent cancels without charging", async () => {
    const s = await proposeCable();
    await orch.approve(s.id);
    arm("surprise_fee");
    await orch.checkout(s.id);
    expect(s.state).toBe("AWAITING_RECONSENT");
    await orch.reject(s.id);
    expect(s.state).toBe("CANCELLED");
    expect(s.mandates[0]!.status).toBe("VOID");
    expect(proc.calls).toHaveLength(0);
    await expect(orch.checkout(s.id)).rejects.toThrow(/cannot check out/);
  });

  it("subscription sneak-in is caught", async () => {
    const s = await proposeCable();
    await orch.approve(s.id);
    arm("subscription");
    await orch.checkout(s.id);
    expect(s.state).toBe("AWAITING_RECONSENT");
    expect(s.last_policy?.findings.map((f) => f.code)).toContain("RECURRING_ADDED");
  });

  it("payment timeout → UNCONFIRMED → lookup finds the order → PAID with exactly one charge", async () => {
    const s = await proposeCable();
    await orch.approve(s.id);
    arm("payment_timeout");
    await orch.checkout(s.id);
    expect(s.state).toBe("PAID");
    expect(proc.calls).toHaveLength(1);
    const t = types(s.id);
    expect(t).toContain("PAYMENT_UNCONFIRMED");
    expect(t).toContain("PRIOR_ATTEMPT_FOUND");
    expect(t.indexOf("PAYMENT_UNCONFIRMED")).toBeLessThan(t.indexOf("PAID"));
  });

  it("refuses issuer-limit totals (BLOCK — re-consent cannot raise it)", async () => {
    const s = await orch.propose({
      intent: "monitor + keyboard",
      items: [
        { sku: "monitor-27", quantity: 1 },
        { sku: "keyboard-mech", quantity: 1 },
      ],
      shipping_id: "std",
    });
    await orch.approve(s.id);
    await orch.checkout(s.id);
    expect(s.state).toBe("BLOCKED");
    expect(proc.calls).toHaveLength(0);
  });

  it("refuses to pay with a tampered mandate", async () => {
    const s = await proposeCable();
    await orch.approve(s.id);
    const rec = s.mandates[0]!;
    const [h, p, sig] = rec.jws.split(".");
    const body = JSON.parse(Buffer.from(p!, "base64url").toString());
    body.total_cap = 999_999;
    rec.jws = [h, Buffer.from(JSON.stringify(body)).toString("base64url"), sig].join(".");
    await expect(orch.checkout(s.id)).rejects.toThrow(/signature invalid/);
    expect(proc.calls).toHaveLength(0);
  });

  it("never writes card numbers to the audit log", async () => {
    const s = await proposeCable();
    await orch.approve(s.id);
    await orch.checkout(s.id);
    expect(JSON.stringify(audit.all())).not.toContain("4111111111111111");
    expect(JSON.stringify(s)).not.toContain("4111111111111111");
  });
});

describe("AuditLog", () => {
  it("detects tampering", () => {
    const log = new AuditLog();
    log.append("s", "A", { n: 1 });
    log.append("s", "B", { n: 2 });
    expect(log.verify().ok).toBe(true);
    (log.all()[0] as { data: Record<string, unknown> }).data.n = 5;
    expect(log.verify()).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it("refuses card numbers", () => {
    expect(() => new AuditLog().append("s", "X", { pan: "4111111111111111" })).toThrow(/card number/);
    expect(() => new AuditLog().append("s", "X", { ts: 1731060000000 })).not.toThrow();
  });
});
