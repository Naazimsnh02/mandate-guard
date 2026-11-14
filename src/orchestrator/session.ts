import { randomUUID } from "node:crypto";
import type { AuditLog } from "../audit/log.js";
import { formatMoney } from "../lib/money.js";
import { proposeAmendedTerms } from "../mandate/amend.js";
import type { Mandate, MandateTermsInput } from "../mandate/schema.js";
import { issueMandate, verifyMandate, type MandateKeys } from "../mandate/signer.js";
import type { MerchantAdapter, PaymentOutcome } from "../merchant/adapter.js";
import { GatewayLimitError, type IssuedCredential, type PaymentGateway, type PaymentReport } from "../payments/gateway.js";
import { evaluate, type PolicyResult } from "../policy/engine.js";
import { CheckoutSnapshot } from "../policy/snapshot.js";

/**
 * One shopping task, from proposal to reported payment.
 *
 *   PROPOSED ─approve→ APPROVED ─checkout→ (re-read checkout, run policy)
 *      MATCH  → PAYING → PAID | DECLINED | UNCONFIRMED ─reconcile→ PAID | APPROVED (no charge found)
 *      DRIFT  → AWAITING_RECONSENT ─approve→ APPROVED (new mandate, SAME cart) → checkout…
 *                                  └─reject→ CANCELLED
 *      BLOCK  → BLOCKED
 *
 * Invariants enforced here (not by the LLM):
 *  - Money moves only under a verified, unexpired, ACTIVE mandate whose policy check returned MATCH
 *    against a checkout read moments before paying.
 *  - One idempotency key per mandate; every earlier key in the session is looked up before paying,
 *    so a timeout can never turn into a second charge.
 *  - Card data stays in `credentials` (process memory). It is never in the session view or audit log.
 */
export type SessionState =
  | "PROPOSED"
  | "APPROVED"
  | "AWAITING_RECONSENT"
  | "PAYING"
  | "PAID"
  | "DECLINED"
  | "UNCONFIRMED"
  | "BLOCKED"
  | "CANCELLED";

export type MandateStatus = "ACTIVE" | "SUPERSEDED" | "CONSUMED" | "VOID";

export interface MandateRecord {
  mandate: Mandate;
  jws: string;
  digest: string;
  status: MandateStatus;
}

export interface PaymentAttempt {
  mandate_id: string;
  idempotency_key: string;
  amount: number;
  credential_id?: string;
  outcome?: PaymentOutcome;
}

export interface ProposalInput {
  intent: string;
  items: { sku: string; quantity: number }[];
  shipping_id: string;
  rationale?: string;
  /** Shopper's budget for the whole order, minor units. */
  budget?: number;
  /** ISO date-time the goods must arrive by. */
  deliver_by?: string;
}

export interface Session {
  id: string;
  state: SessionState;
  intent: string;
  rationale?: string;
  cart_id: string;
  /** Terms waiting for the shopper's (re-)approval. */
  pending_terms?: MandateTermsInput;
  mandates: MandateRecord[];
  last_policy?: PolicyResult;
  attempts: PaymentAttempt[];
  order?: { order_id: string; status: string; total: number; reference?: string };
  message?: string;
  /** Issuer approval page (Airi passkey) while a credential request is pending. */
  approval_url?: string;
  created_at: string;
  updated_at: string;
}

export class SessionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OrchestratorDeps {
  merchant: MerchantAdapter;
  gateway: PaymentGateway;
  keys: MandateKeys;
  audit: AuditLog;
  /** Issuer per-transaction ceiling (Airi test card: US$200 = 20000). */
  issuerLimit?: number;
  mandateTtlMinutes?: number;
  clock?: () => Date;
}

export class Orchestrator {
  private sessions = new Map<string, Session>();
  /** credential_id → issued credential (card data lives only here). */
  private credentials = new Map<string, IssuedCredential>();
  private busy = new Set<string>();
  private clock: () => Date;

  constructor(private d: OrchestratorDeps) {
    this.clock = d.clock ?? (() => new Date());
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new SessionError(404, "session not found");
    return s;
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  activeMandate(s: Session): MandateRecord | undefined {
    return s.mandates.find((m) => m.status === "ACTIVE");
  }

  // ---------------------------------------------------------------- proposal
  /** Build the cart at the merchant and turn what checkout shows into terms the shopper can approve. */
  async propose(p: ProposalInput): Promise<Session> {
    if (p.items.length === 0) throw new SessionError(400, "proposal has no items");
    const id = randomUUID();
    const { cart_id } = await this.d.merchant.createCart(p.items, p.shipping_id);
    const snap = CheckoutSnapshot.parse(await this.d.merchant.readCheckout(cart_id));
    const fmt = (n: number) => formatMoney(n, snap.currency);

    if (p.budget !== undefined && snap.displayed_total > p.budget) {
      throw new SessionError(422, `Checkout total ${fmt(snap.displayed_total)} is over the budget of ${fmt(p.budget)}`);
    }
    const eta = snap.fulfillment.latest_delivery_at;
    if (p.deliver_by && eta && Date.parse(eta) > Date.parse(p.deliver_by)) {
      throw new SessionError(422, `Merchant ETA ${eta.slice(0, 10)} is later than the deadline ${p.deliver_by.slice(0, 10)}`);
    }

    const terms: MandateTermsInput = {
      intent: p.intent,
      merchant: this.d.merchant.merchant,
      currency: snap.currency,
      items: snap.lines.map((l) => ({ sku: l.sku, title: l.title, variant: l.variant, quantity: l.quantity, unit_price: l.unit_price })),
      // The deadline the shopper cares about is what's bound; else the merchant's own promise.
      fulfillment: { ...snap.fulfillment, latest_delivery_at: p.deliver_by ?? eta },
      fees: snap.fees,
      total_cap: snap.displayed_total,
      allow_recurring: false,
      allow_substitutions: false,
    };
    const now = this.now();
    const s: Session = {
      id,
      state: "PROPOSED",
      intent: p.intent,
      rationale: p.rationale,
      cart_id,
      pending_terms: terms,
      mandates: [],
      attempts: [],
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(id, s);
    this.log(s, "PROPOSED", { cart_id, terms, rationale: p.rationale, budget: p.budget, deliver_by: p.deliver_by });
    return s;
  }

  // ---------------------------------------------------------------- approval
  /** Shopper approves the pending terms (first approval or re-consent). */
  async approve(id: string, overrides: { total_cap?: number } = {}): Promise<Session> {
    return this.locked(id, async (s) => {
      if (s.state !== "PROPOSED" && s.state !== "AWAITING_RECONSENT") {
        throw new SessionError(409, `cannot approve in state ${s.state}`);
      }
      if (!s.pending_terms) throw new SessionError(409, "nothing to approve");
      const previous = this.activeMandate(s);
      const terms = { ...s.pending_terms, ...(overrides.total_cap !== undefined ? { total_cap: overrides.total_cap } : {}) };
      const signed = await issueMandate(terms, this.d.keys, {
        ttlMinutes: this.d.mandateTtlMinutes,
        now: this.clock(),
        supersedes: previous?.mandate.mandate_id,
      });
      if (previous) {
        previous.status = "SUPERSEDED";
        await this.cancelOpenCredentials(s, previous.mandate.mandate_id, "superseded by re-consent");
      }
      s.mandates.push({ ...signed, status: "ACTIVE" });
      s.pending_terms = undefined;
      const wasReconsent = s.state === "AWAITING_RECONSENT";
      this.transition(s, "APPROVED", wasReconsent ? "Re-approved. Resuming the same checkout." : "Approved.");
      this.log(s, wasReconsent ? "RECONSENT_APPROVED" : "APPROVED", {
        mandate_id: signed.mandate.mandate_id,
        digest: signed.digest,
        supersedes: previous?.mandate.mandate_id,
        total_cap: signed.mandate.total_cap,
        expires_at: signed.mandate.expires_at,
      });
      return s;
    });
  }

  async reject(id: string): Promise<Session> {
    return this.locked(id, async (s) => {
      if (s.state !== "PROPOSED" && s.state !== "AWAITING_RECONSENT") {
        throw new SessionError(409, `cannot reject in state ${s.state}`);
      }
      const m = this.activeMandate(s);
      if (m) {
        m.status = "VOID";
        await this.cancelOpenCredentials(s, m.mandate.mandate_id, "cancelled by shopper");
      }
      s.pending_terms = undefined;
      this.transition(s, "CANCELLED", "Cancelled by shopper. Nothing was charged.");
      this.log(s, s.mandates.length ? "RECONSENT_REJECTED" : "REJECTED", { mandate_id: m?.mandate.mandate_id });
      return s;
    });
  }

  // ---------------------------------------------------------------- checkout
  /** Re-read the live checkout, run the policy, and pay only on MATCH. */
  async checkout(id: string): Promise<Session> {
    return this.locked(id, (s) => this.runCheckout(s));
  }

  private async runCheckout(s: Session, depth = 0): Promise<Session> {
    if (s.state !== "APPROVED") throw new SessionError(409, `cannot check out in state ${s.state}`);
    const rec = this.activeMandate(s);
    if (!rec) throw new SessionError(409, "no active mandate");

    // 1. The mandate we hold must be exactly the one that was signed.
    const verified = await verifyMandate(rec.jws, this.d.keys.publicKey);
    if (verified.digest !== rec.digest) throw new SessionError(500, "mandate digest mismatch");
    this.log(s, "MANDATE_VERIFIED", { mandate_id: rec.mandate.mandate_id, digest: rec.digest });

    // 2. Never pay twice: any earlier attempt in this session that actually charged wins.
    if (await this.settleFromPriorAttempts(s)) return s;

    // 3. Read the checkout as it is right now and compare against the signed terms.
    const snap = CheckoutSnapshot.parse(await this.d.merchant.readCheckout(s.cart_id));
    const policy = evaluate(rec.mandate, snap, { now: this.clock(), issuerLimit: this.d.issuerLimit });
    s.last_policy = policy;
    this.log(s, "CHECKOUT_OBSERVED", {
      mandate_id: rec.mandate.mandate_id,
      decision: policy.decision,
      observed_total: policy.observed_total,
      total_cap: policy.total_cap,
      findings: policy.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
    });

    if (policy.decision === "BLOCK") {
      rec.status = "VOID";
      this.transition(s, "BLOCKED", policy.findings.filter((f) => f.severity === "block").map((f) => f.message).join(" "));
      return s;
    }
    if (policy.decision === "DRIFT") {
      s.pending_terms = proposeAmendedTerms(rec.mandate, snap);
      this.transition(s, "AWAITING_RECONSENT", "The checkout changed. Paused for your approval.");
      this.log(s, "PAUSED_FOR_RECONSENT", { mandate_id: rec.mandate.mandate_id, proposed_total: snap.displayed_total });
      return s;
    }

    // 4. MATCH → pay exactly the observed total.
    const outcome = await this.pay(s, rec, snap);
    if (outcome === "TOTAL_CHANGED" && depth < 1) {
      this.transition(s, "APPROVED", "Merchant total changed during payment; re-checking.");
      return this.runCheckout(s, depth + 1);
    }
    return s;
  }

  private async pay(s: Session, rec: MandateRecord, snap: CheckoutSnapshot): Promise<"DONE" | "TOTAL_CHANGED"> {
    const amount = snap.displayed_total;
    const mandate_id = rec.mandate.mandate_id;
    let attempt = s.attempts.find((a) => a.mandate_id === mandate_id);
    if (!attempt) {
      attempt = { mandate_id, idempotency_key: `mg_${mandate_id}`, amount };
      s.attempts.push(attempt);
    }
    attempt.amount = amount;
    this.transition(s, "PAYING", "Paying…");

    // Credential bound to this mandate and this exact amount.
    let cred = attempt.credential_id ? this.credentials.get(attempt.credential_id) : undefined;
    if (!cred || cred.amount_limit !== amount || Date.parse(cred.expires_at) <= this.clock().getTime()) {
      if (cred) await this.cancelCredential(s, attempt, "amount changed before payment");
      try {
        cred = await this.d.gateway.issueCredential({
          mandate: rec.mandate,
          mandate_jws: rec.jws,
          amount,
          // What the issuer shows on its own approval screen: exactly what checkout shows.
          items: [
            ...snap.lines.map((l) => ({ name: l.title, unit_price: l.unit_price, quantity: l.quantity })),
            ...(snap.fulfillment.cost > 0 ? [{ name: snap.fulfillment.title, unit_price: snap.fulfillment.cost, quantity: 1 }] : []),
            ...snap.fees.filter((f) => f.amount > 0).map((f) => ({ name: f.label, unit_price: f.amount, quantity: 1 })),
          ],
          onApprovalRequired: ({ url, payment_mandate_id }) => {
            s.approval_url = url;
            this.transition(s, "PAYING", "Waiting for you to approve the payment in Airi (passkey)…");
            this.log(s, "ISSUER_APPROVAL_REQUESTED", { mandate_id, gateway: this.d.gateway.name, payment_mandate_id, url });
          },
        });
      } catch (err) {
        // A limit can't be raised by re-consent → BLOCKED. Other errors leave the mandate usable for a retry.
        const blocked = err instanceof GatewayLimitError;
        if (blocked) rec.status = "VOID";
        this.transition(s, blocked ? "BLOCKED" : "APPROVED", (err as Error).message);
        this.log(s, "CREDENTIAL_REFUSED", { mandate_id, amount, error: (err as Error).message });
        return "DONE";
      }
      s.approval_url = undefined;
      this.credentials.set(cred.credential_id, cred);
      attempt.credential_id = cred.credential_id;
      this.log(s, "CREDENTIAL_ISSUED", {
        mandate_id,
        gateway: this.d.gateway.name,
        credential_id: cred.credential_id,
        payment_mandate_id: cred.payment_mandate_id,
        amount_limit: cred.amount_limit,
        card_last4: cred.card.number.slice(-4),
        expires_at: cred.expires_at,
      });
    }

    this.log(s, "PAYMENT_SUBMITTED", { mandate_id, idempotency_key: attempt.idempotency_key, amount });
    const outcome = await this.d.merchant.submitPayment(s.cart_id, {
      idempotencyKey: attempt.idempotency_key,
      expectedTotal: amount,
      card: cred.card,
    });
    attempt.outcome = outcome;

    if (outcome.kind === "CONFIRMED" && outcome.failure_reason === "total_changed" && !outcome.order_id) {
      this.log(s, "PAYMENT_REFUSED_TOTAL_CHANGED", { mandate_id, expected: amount, shown: outcome.total });
      return "TOTAL_CHANGED";
    }
    if (outcome.kind === "UNCONFIRMED") {
      this.transition(s, "UNCONFIRMED", "No confirmation from the merchant. Treating as unconfirmed; checking before any retry.");
      this.log(s, "PAYMENT_UNCONFIRMED", { mandate_id, idempotency_key: attempt.idempotency_key, error: outcome.error });
      // Automatic reconciliation: look the attempt up instead of blindly retrying.
      await this.reconcileInner(s);
      return "DONE";
    }
    await this.settle(s, attempt, outcome);
    return "DONE";
  }

  // ---------------------------------------------------------------- reconciliation
  /** Look up the unconfirmed attempt at the merchant. Never re-submits payment. */
  async reconcile(id: string): Promise<Session> {
    return this.locked(id, async (s) => {
      if (s.state !== "UNCONFIRMED") throw new SessionError(409, `nothing to reconcile in state ${s.state}`);
      await this.reconcileInner(s);
      return s;
    });
  }

  private async reconcileInner(s: Session): Promise<void> {
    if (await this.settleFromPriorAttempts(s)) return;
    // Confirmed no charge exists. Safe to try again later with the SAME idempotency key.
    this.log(s, "RECONCILED_NO_CHARGE", { keys: s.attempts.map((a) => a.idempotency_key) });
    this.transition(s, "APPROVED", "Merchant has no record of the payment, so nothing was charged. Safe to retry.");
  }

  /** Returns true if a prior attempt turned out to have reached the merchant (session settled). */
  private async settleFromPriorAttempts(s: Session): Promise<boolean> {
    for (const a of s.attempts) {
      const found = await this.d.merchant.lookupAttempt(a.idempotency_key);
      if (!found) continue;
      this.log(s, "PRIOR_ATTEMPT_FOUND", { idempotency_key: a.idempotency_key, status: found.kind === "CONFIRMED" ? found.status : "?" });
      a.outcome = found;
      await this.settle(s, a, found);
      return true;
    }
    return false;
  }

  private async settle(s: Session, a: PaymentAttempt, outcome: Extract<PaymentOutcome, { kind: "CONFIRMED" }> | PaymentOutcome) {
    if (outcome.kind !== "CONFIRMED") return;
    const rec = s.mandates.find((m) => m.mandate.mandate_id === a.mandate_id);
    const paid = outcome.status === "PAID";
    if (rec) rec.status = paid ? "CONSUMED" : "VOID";
    s.order = { order_id: outcome.order_id, status: outcome.status, total: outcome.total, reference: outcome.reference };
    this.transition(
      s,
      paid ? "PAID" : "DECLINED",
      paid ? `Paid ${formatMoney(outcome.total, rec?.mandate.currency ?? "USD")}. Order ${outcome.order_id}.` : `Payment ${outcome.status.toLowerCase()}: ${outcome.failure_reason ?? "unknown reason"}`,
    );
    this.log(s, paid ? "PAID" : "PAYMENT_FAILED", {
      mandate_id: a.mandate_id,
      order_id: outcome.order_id,
      total: outcome.total,
      reference: outcome.reference,
      failure_reason: outcome.failure_reason,
    });
    await this.report(s, a, {
      status: paid ? "SUCCEEDED" : "FAILED",
      merchant_order_id: outcome.order_id,
      merchant_reference: outcome.reference,
      failure_reason: outcome.failure_reason,
    });
  }

  /** Kit 09: report the payment result back to the credential issuer (Airi). */
  private async report(s: Session, a: PaymentAttempt, report: PaymentReport) {
    if (!a.credential_id) return;
    try {
      await this.d.gateway.reportResult(a.credential_id, report);
      this.log(s, "RESULT_REPORTED", { gateway: this.d.gateway.name, credential_id: a.credential_id, status: report.status });
    } catch (err) {
      this.log(s, "RESULT_REPORT_FAILED", { credential_id: a.credential_id, error: (err as Error).message });
    }
    this.credentials.delete(a.credential_id);
  }

  /** Tell the issuer an unused credential will not be used (Airi: result CANCELLED). */
  private async cancelOpenCredentials(s: Session, mandate_id: string, reason: string) {
    for (const a of s.attempts) if (a.mandate_id === mandate_id && a.credential_id && this.credentials.has(a.credential_id)) await this.cancelCredential(s, a, reason);
  }

  private async cancelCredential(s: Session, a: PaymentAttempt, reason: string) {
    if (!a.credential_id || !this.credentials.has(a.credential_id)) return;
    if (a.outcome?.kind === "UNCONFIRMED") return; // might have charged: never cancel an unresolved attempt
    await this.report(s, a, { status: "CANCELLED", failure_reason: reason });
    a.credential_id = undefined;
  }

  // ---------------------------------------------------------------- helpers
  private async locked(id: string, fn: (s: Session) => Promise<Session>): Promise<Session> {
    const s = this.get(id);
    if (this.busy.has(id)) throw new SessionError(409, "session is busy");
    this.busy.add(id);
    try {
      return await fn(s);
    } finally {
      this.busy.delete(id);
    }
  }

  private transition(s: Session, state: SessionState, message?: string) {
    s.state = state;
    s.message = message;
    s.updated_at = this.now();
  }

  private log(s: Session, type: string, data: Record<string, unknown>) {
    this.d.audit.append(s.id, type, data);
  }

  private now() {
    return this.clock().toISOString();
  }
}
