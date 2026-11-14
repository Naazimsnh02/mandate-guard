import { describe, expect, it } from "vitest";
import { proposeAmendedTerms } from "../src/mandate/amend.js";
import { generateMandateKeys, issueMandate } from "../src/mandate/signer.js";
import { evaluate } from "../src/policy/engine.js";
import { CheckoutSnapshot } from "../src/policy/snapshot.js";
import { NOW, snapshot, terms } from "./fixtures.js";

const keysP = generateMandateKeys();
const mandate = async () => (await issueMandate(terms(), await keysP, { now: NOW })).mandate;
const codes = (r: ReturnType<typeof evaluate>) => r.findings.map((f) => f.code).sort();
const ISSUER_LIMIT = 20_000; // Airi test card: US$200 per transaction

describe("policy engine", () => {
  it("MATCH when checkout equals the mandate", async () => {
    const r = evaluate(await mandate(), snapshot(), { now: NOW, issuerLimit: ISSUER_LIMIT });
    expect(r.decision).toBe("MATCH");
    expect(r.findings).toEqual([]);
  });

  it("price drop is informational, still MATCH", async () => {
    const s = snapshot();
    s.lines[0]!.unit_price = 899;
    s.displayed_total = 1199;
    const r = evaluate(await mandate(), s, { now: NOW });
    expect(r.decision).toBe("MATCH");
    expect(codes(r)).toEqual(["PRICE_DECREASED"]);
  });

  it("DRIFT on price increase (and cap exceeded)", async () => {
    const s = snapshot();
    s.lines[0]!.unit_price = 1199;
    s.displayed_total = 1499;
    const r = evaluate(await mandate(), s, { now: NOW });
    expect(r.decision).toBe("DRIFT");
    expect(codes(r)).toEqual(["PRICE_INCREASED", "TOTAL_EXCEEDS_CAP"]);
    expect(r.findings[0]!.message).toContain("$9.99");
  });

  it("DRIFT on a surprise fee added at the last step", async () => {
    const s = snapshot();
    s.fees = [{ label: "Handling fee", amount: 199 }];
    s.displayed_total = 1498;
    const r = evaluate(await mandate(), s, { now: NOW });
    expect(r.decision).toBe("DRIFT");
    expect(codes(r)).toEqual(["FEE_ADDED", "TOTAL_EXCEEDS_CAP"]);
  });

  it("DRIFT on substitution even when cheaper", async () => {
    const s = snapshot();
    s.lines = [{ sku: "cable-usbc-generic", title: "Generic USB-C Cable", quantity: 1, unit_price: 799 }];
    s.displayed_total = 1099;
    const r = evaluate(await mandate(), s, { now: NOW });
    expect(r.decision).toBe("DRIFT");
    expect(codes(r)).toEqual(["ITEM_SUBSTITUTED"]);
  });

  it("DRIFT when a subscription is sneaked in", async () => {
    const s = snapshot();
    s.lines.push({ sku: "care-plus", title: "Care+ Protection", quantity: 1, unit_price: 0, recurring: { interval: "month" } });
    const r = evaluate(await mandate(), s, { now: NOW });
    expect(r.decision).toBe("DRIFT");
    expect(codes(r)).toEqual(["RECURRING_ADDED"]);
  });

  it("DRIFT when an approved item becomes recurring", async () => {
    const s = snapshot();
    s.lines[0]!.recurring = { interval: "month" };
    const r = evaluate(await mandate(), s, { now: NOW });
    expect(codes(r)).toEqual(["RECURRING_ADDED"]);
  });

  it("DRIFT on item removed (out of stock) and quantity change", async () => {
    const m = (await issueMandate(
      { ...terms(), items: [...terms().items, { sku: "adapter", title: "Wall adapter", quantity: 1, unit_price: 1500 }], total_cap: 2799 },
      await keysP,
      { now: NOW },
    )).mandate;
    const s = snapshot();
    s.lines[0]!.quantity = 2;
    s.displayed_total = 2298;
    const r = evaluate(m, s, { now: NOW });
    expect(r.decision).toBe("DRIFT");
    expect(codes(r)).toEqual(["ITEM_REMOVED", "QUANTITY_CHANGED"]);
  });

  it("DRIFT on different merchant origin (e.g. redirected to a reseller)", async () => {
    const s = snapshot();
    s.merchant = { id: "drift-mart", origin: "https://drift-mart-deals.example" };
    const r = evaluate(await mandate(), s, { now: NOW });
    expect(codes(r)).toEqual(["MERCHANT_CHANGED"]);
  });

  it("DRIFT on currency change", async () => {
    const s = snapshot();
    s.currency = "EUR";
    expect(codes(evaluate(await mandate(), s, { now: NOW }))).toEqual(["CURRENCY_CHANGED"]);
  });

  it("DRIFT on slower delivery and pricier shipping", async () => {
    const s = snapshot();
    s.fulfillment = { method: "SHIPPING", title: "Economy shipping (7-10 days)", cost: 450, latest_delivery_at: "2026-11-18T18:00:00Z" };
    s.displayed_total = 1449;
    const r = evaluate(await mandate(), s, { now: NOW });
    expect(codes(r)).toEqual(["DELIVERY_LATER", "FULFILLMENT_CHANGED", "FULFILLMENT_COST_INCREASED", "TOTAL_EXCEEDS_CAP"]);
  });

  it("BLOCK when mandate expired, even if cart matches", async () => {
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const r = evaluate(await mandate(), snapshot(), { now: later });
    expect(r.decision).toBe("BLOCK");
    expect(codes(r)).toEqual(["MANDATE_EXPIRED"]);
  });

  it("BLOCK when displayed total does not add up", async () => {
    const s = snapshot();
    s.displayed_total = 1199; // hidden discount/fee mismatch
    const r = evaluate(await mandate(), s, { now: NOW });
    expect(r.decision).toBe("BLOCK");
    expect(codes(r)).toEqual(["TOTAL_INCONSISTENT"]);
  });

  it("BLOCK above the issuer per-transaction limit, even with consent", async () => {
    const m = (await issueMandate(
      { ...terms(), items: [{ sku: "monitor", title: "27in Monitor", quantity: 1, unit_price: 21_000 }], total_cap: 25_000 },
      await keysP,
      { now: NOW },
    )).mandate;
    const s = snapshot();
    s.lines = [{ sku: "monitor", title: "27in Monitor", quantity: 1, unit_price: 21_000 }];
    s.displayed_total = 21_300;
    const r = evaluate(m, s, { now: NOW, issuerLimit: ISSUER_LIMIT });
    expect(r.decision).toBe("BLOCK");
    expect(codes(r)).toEqual(["ISSUER_LIMIT_EXCEEDED"]);
  });

  it("re-consent: amended mandate supersedes the old one and then MATCHes", async () => {
    const old = await mandate();
    const s = snapshot();
    s.fees = [{ label: "Handling fee", amount: 199 }];
    s.displayed_total = 1498;
    expect(evaluate(old, s, { now: NOW }).decision).toBe("DRIFT");

    const amended = await issueMandate(proposeAmendedTerms(old, CheckoutSnapshot.parse(s)), await keysP, {
      now: NOW,
      supersedes: old.mandate_id,
    });
    expect(amended.mandate.supersedes).toBe(old.mandate_id);
    expect(amended.mandate.total_cap).toBe(1498);
    expect(evaluate(amended.mandate, s, { now: NOW }).decision).toBe("MATCH");
  });
});
