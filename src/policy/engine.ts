import type { Mandate } from "../mandate/schema.js";
import { formatMoney } from "../lib/money.js";
import { CheckoutSnapshot, type CheckoutSnapshotInput } from "./snapshot.js";

/**
 * Deterministic policy engine: compares the observed checkout against the signed
 * mandate line by line. The LLM never decides whether a payment may proceed —
 * this code does.
 *
 *  MATCH   → pay.
 *  DRIFT   → pause, show diff, ask the shopper to re-approve (resume same checkout).
 *  BLOCK   → cannot be fixed by re-consent (expired, issuer limit, broken totals…).
 */
export type Decision = "MATCH" | "DRIFT" | "BLOCK";

/** info = allowed and shown; reconsent = needs new approval; block = never pay. */
export type Severity = "info" | "reconsent" | "block";

export type FindingCode =
  | "MANDATE_EXPIRED"
  | "MERCHANT_CHANGED"
  | "CURRENCY_CHANGED"
  | "ITEM_SUBSTITUTED"
  | "ITEM_ADDED"
  | "ITEM_REMOVED"
  | "QUANTITY_CHANGED"
  | "PRICE_INCREASED"
  | "PRICE_DECREASED"
  | "RECURRING_ADDED"
  | "FEE_ADDED"
  | "FEE_INCREASED"
  | "FULFILLMENT_CHANGED"
  | "FULFILLMENT_COST_INCREASED"
  | "DELIVERY_LATER"
  | "TOTAL_EXCEEDS_CAP"
  | "TOTAL_INCONSISTENT"
  | "ISSUER_LIMIT_EXCEEDED";

export interface Finding {
  code: FindingCode;
  severity: Severity;
  field: string;
  approved?: unknown;
  observed?: unknown;
  /** Plain-language explanation shown to the shopper. */
  message: string;
}

export interface PolicyResult {
  decision: Decision;
  findings: Finding[];
  approved_total: number;
  observed_total: number;
  total_cap: number;
}

export interface PolicyOptions {
  now?: Date;
  /**
   * Issuer-side per-transaction ceiling in minor units (Airi test card: US$200).
   * Exceeding it is a BLOCK: re-consent cannot raise an issuer limit.
   */
  issuerLimit?: number;
}

export function evaluate(
  mandate: Mandate,
  snapshotInput: CheckoutSnapshotInput,
  opts: PolicyOptions = {},
): PolicyResult {
  const snap = CheckoutSnapshot.parse(snapshotInput);
  const now = opts.now ?? new Date();
  const cur = mandate.currency;
  const fmt = (n: number) => formatMoney(n, cur);
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  // 1. Mandate validity
  if (now.getTime() >= Date.parse(mandate.expires_at)) {
    add({
      code: "MANDATE_EXPIRED",
      severity: "block",
      field: "expires_at",
      approved: mandate.expires_at,
      observed: now.toISOString(),
      message: `Your approval expired at ${mandate.expires_at}. A fresh approval is required.`,
    });
  }

  // 2. Merchant + currency
  if (snap.merchant.id !== mandate.merchant.id || new URL(snap.merchant.origin).origin !== new URL(mandate.merchant.origin).origin) {
    add({
      code: "MERCHANT_CHANGED",
      severity: "reconsent",
      field: "merchant",
      approved: mandate.merchant,
      observed: snap.merchant,
      message: `Checkout is on ${snap.merchant.origin}, but you approved ${mandate.merchant.name} (${mandate.merchant.origin}).`,
    });
  }
  if (snap.currency !== cur) {
    add({
      code: "CURRENCY_CHANGED",
      severity: "reconsent",
      field: "currency",
      approved: cur,
      observed: snap.currency,
      message: `Checkout is charging in ${snap.currency}, but you approved ${cur}.`,
    });
  }

  // 3. Line items
  const approvedBySku = new Map(mandate.items.map((i) => [i.sku, i]));
  const observedBySku = new Map(snap.lines.map((l) => [l.sku, l]));
  const removed = mandate.items.filter((i) => !observedBySku.has(i.sku));
  const added = snap.lines.filter((l) => !approvedBySku.has(l.sku));

  // Pair removed+added as substitutions (same position order) — a swapped item.
  const pairs = Math.min(removed.length, added.length);
  for (let k = 0; k < pairs; k++) {
    const a = removed[k]!;
    const o = added[k]!;
    add({
      code: "ITEM_SUBSTITUTED",
      severity: "reconsent",
      field: `items[${a.sku}]`,
      approved: { sku: a.sku, title: a.title, unit_price: a.unit_price },
      observed: { sku: o.sku, title: o.title, unit_price: o.unit_price },
      message: `"${a.title}" was replaced with "${o.title}" (${fmt(o.unit_price)}).`,
    });
  }
  for (const a of removed.slice(pairs)) {
    add({
      code: "ITEM_REMOVED",
      severity: "reconsent",
      field: `items[${a.sku}]`,
      approved: a,
      message: `"${a.title}" is no longer in the cart (out of stock or removed).`,
    });
  }
  for (const o of added.slice(pairs)) {
    add({
      code: o.recurring ? "RECURRING_ADDED" : "ITEM_ADDED",
      severity: "reconsent",
      field: `items[${o.sku}]`,
      observed: o,
      message: o.recurring
        ? `A subscription "${o.title}" (${fmt(o.unit_price)} every ${o.recurring.interval}) was added.`
        : `An extra item "${o.title}" (${fmt(o.unit_price)}) was added.`,
    });
  }

  for (const a of mandate.items) {
    const o = observedBySku.get(a.sku);
    if (!o) continue;
    if (o.quantity !== a.quantity) {
      add({
        code: "QUANTITY_CHANGED",
        severity: "reconsent",
        field: `items[${a.sku}].quantity`,
        approved: a.quantity,
        observed: o.quantity,
        message: `Quantity of "${a.title}" changed from ${a.quantity} to ${o.quantity}.`,
      });
    }
    if (o.unit_price > a.unit_price) {
      add({
        code: "PRICE_INCREASED",
        severity: "reconsent",
        field: `items[${a.sku}].unit_price`,
        approved: a.unit_price,
        observed: o.unit_price,
        message: `"${a.title}" went up from ${fmt(a.unit_price)} to ${fmt(o.unit_price)}.`,
      });
    } else if (o.unit_price < a.unit_price) {
      add({
        code: "PRICE_DECREASED",
        severity: "info",
        field: `items[${a.sku}].unit_price`,
        approved: a.unit_price,
        observed: o.unit_price,
        message: `"${a.title}" dropped from ${fmt(a.unit_price)} to ${fmt(o.unit_price)}. No action needed.`,
      });
    }
    if (o.recurring && !mandate.allow_recurring) {
      add({
        code: "RECURRING_ADDED",
        severity: "reconsent",
        field: `items[${a.sku}].recurring`,
        observed: o.recurring,
        message: `"${a.title}" is now a recurring charge (every ${o.recurring.interval}). You approved a one-time purchase.`,
      });
    }
  }

  // 4. Fees
  const approvedFees = new Map(mandate.fees.map((f) => [norm(f.label), f]));
  for (const f of snap.fees) {
    const a = approvedFees.get(norm(f.label));
    if (!a) {
      if (f.amount === 0) continue;
      add({
        code: "FEE_ADDED",
        severity: "reconsent",
        field: `fees[${f.label}]`,
        observed: f.amount,
        message: `A new fee "${f.label}" of ${fmt(f.amount)} was added at checkout.`,
      });
    } else if (f.amount > a.amount) {
      add({
        code: "FEE_INCREASED",
        severity: "reconsent",
        field: `fees[${f.label}]`,
        approved: a.amount,
        observed: f.amount,
        message: `"${f.label}" went up from ${fmt(a.amount)} to ${fmt(f.amount)}.`,
      });
    }
  }

  // 5. Fulfillment
  const af = mandate.fulfillment;
  const of = snap.fulfillment;
  if (of.method !== af.method || norm(of.title) !== norm(af.title)) {
    add({
      code: "FULFILLMENT_CHANGED",
      severity: "reconsent",
      field: "fulfillment",
      approved: { method: af.method, title: af.title },
      observed: { method: of.method, title: of.title },
      message: `Delivery changed from "${af.title}" to "${of.title}".`,
    });
  }
  if (of.cost > af.cost) {
    add({
      code: "FULFILLMENT_COST_INCREASED",
      severity: "reconsent",
      field: "fulfillment.cost",
      approved: af.cost,
      observed: of.cost,
      message: `Delivery cost went up from ${fmt(af.cost)} to ${fmt(of.cost)}.`,
    });
  }
  if (af.latest_delivery_at && (!of.latest_delivery_at || Date.parse(of.latest_delivery_at) > Date.parse(af.latest_delivery_at))) {
    add({
      code: "DELIVERY_LATER",
      severity: "reconsent",
      field: "fulfillment.latest_delivery_at",
      approved: af.latest_delivery_at,
      observed: of.latest_delivery_at ?? "unknown",
      message: of.latest_delivery_at
        ? `Delivery is now expected by ${of.latest_delivery_at}, later than your deadline ${af.latest_delivery_at}.`
        : `The merchant no longer shows a delivery date. You required delivery by ${af.latest_delivery_at}.`,
    });
  }

  // 6. Totals
  const computed =
    snap.lines.reduce((s, l) => s + l.unit_price * l.quantity, 0) +
    snap.fees.reduce((s, f) => s + f.amount, 0) +
    of.cost;
  if (computed !== snap.displayed_total) {
    add({
      code: "TOTAL_INCONSISTENT",
      severity: "block",
      field: "displayed_total",
      approved: computed,
      observed: snap.displayed_total,
      message: `The merchant shows ${fmt(snap.displayed_total)} but the lines add up to ${fmt(computed)}. Not paying until this is resolved.`,
    });
  }
  const observedTotal = snap.displayed_total;
  if (observedTotal > mandate.total_cap) {
    add({
      code: "TOTAL_EXCEEDS_CAP",
      severity: "reconsent",
      field: "total",
      approved: mandate.total_cap,
      observed: observedTotal,
      message: `Total ${fmt(observedTotal)} is over your approved limit of ${fmt(mandate.total_cap)}.`,
    });
  }
  if (opts.issuerLimit !== undefined && observedTotal > opts.issuerLimit) {
    add({
      code: "ISSUER_LIMIT_EXCEEDED",
      severity: "block",
      field: "total",
      approved: opts.issuerLimit,
      observed: observedTotal,
      message: `Total ${fmt(observedTotal)} exceeds the card's per-transaction limit of ${fmt(opts.issuerLimit)}.`,
    });
  }

  const decision: Decision = findings.some((f) => f.severity === "block")
    ? "BLOCK"
    : findings.some((f) => f.severity === "reconsent")
      ? "DRIFT"
      : "MATCH";

  return {
    decision,
    findings,
    approved_total:
      mandate.items.reduce((s, i) => s + i.unit_price * i.quantity, 0) +
      mandate.fees.reduce((s, f) => s + f.amount, 0) +
      af.cost,
    observed_total: observedTotal,
    total_cap: mandate.total_cap,
  };
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
