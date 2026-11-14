import { createHash } from "node:crypto";
import { AirwallexClient, AirwallexError } from "../../lib/airwallex.js";
import { toMajor } from "../../lib/money.js";

/**
 * Drift Mart's card processor. Sandbox only: Drift Mart receives the one-time
 * (test) credential issued by Airi and charges it here. In production a merchant
 * would collect card data only in its PSP's hosted fields.
 */
export interface CardInput {
  number: string;
  expiry_month: string;
  expiry_year: string;
  cvc: string;
  name: string;
}

export interface ChargeRequest {
  /** Merchant-side idempotency key — the same key must never charge twice. */
  idempotencyKey: string;
  orderId: string;
  amount: number; // minor units
  currency: string;
  card: CardInput;
}

export interface ChargeResult {
  status: "SUCCEEDED" | "DECLINED" | "ERROR";
  processor: "airwallex" | "simulated";
  reference?: string;
  failure_reason?: string;
  card_last4: string;
}

export interface CardProcessor {
  readonly name: "airwallex" | "simulated";
  charge(req: ChargeRequest): Promise<ChargeResult>;
}

export function luhnValid(num: string): boolean {
  const digits = num.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const last4 = (n: string) => n.replace(/\D/g, "").slice(-4);

/** Deterministic stand-in used until Payment Acceptance is enabled on the sandbox account. */
export class SimulatedProcessor implements CardProcessor {
  readonly name = "simulated" as const;
  /** Test numbers that always decline (mirrors common PSP test cards). */
  static DECLINE = new Set(["4000000000000002", "4000000000009995"]);

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const num = req.card.number.replace(/\D/g, "");
    const base = { processor: this.name, card_last4: last4(num) };
    if (!luhnValid(num)) return { ...base, status: "DECLINED", failure_reason: "invalid_card_number" };
    const exp = new Date(Number(req.card.expiry_year), Number(req.card.expiry_month), 1);
    if (!(exp.getTime() > Date.now())) return { ...base, status: "DECLINED", failure_reason: "expired_card" };
    if (SimulatedProcessor.DECLINE.has(num)) return { ...base, status: "DECLINED", failure_reason: "card_declined" };
    const ref = "sim_" + createHash("sha256").update(req.idempotencyKey).digest("hex").slice(0, 20);
    return { ...base, status: "SUCCEEDED", reference: ref };
  }
}

/** Airwallex Payment Acceptance: create + confirm a PaymentIntent with the card. */
export class AirwallexProcessor implements CardProcessor {
  readonly name = "airwallex" as const;
  constructor(private client: AirwallexClient) {}

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const base = { processor: this.name, card_last4: last4(req.card.number) };
    // Derive stable request_ids from the merchant idempotency key so a retry of the
    // same checkout reuses them (Airwallex dedupes) instead of creating a 2nd charge.
    const rid = (suffix: string) => uuidFromKey(`${req.idempotencyKey}:${suffix}`);
    try {
      const intent = await this.client.post<{ id: string }>("/api/v1/pa/payment_intents/create", {
        request_id: rid("create"),
        amount: toMajor(req.amount, req.currency),
        currency: req.currency,
        merchant_order_id: req.orderId,
      });
      const confirmed = await this.client.post<{ id: string; status: string; latest_payment_attempt?: { failure_code?: string } }>(
        `/api/v1/pa/payment_intents/${intent.id}/confirm`,
        {
          request_id: rid("confirm"),
          payment_method: { type: "card", card: { ...req.card, number: req.card.number.replace(/\D/g, "") } },
        },
      );
      if (confirmed.status === "SUCCEEDED") return { ...base, status: "SUCCEEDED", reference: intent.id };
      return {
        ...base,
        status: "DECLINED",
        reference: intent.id,
        failure_reason: confirmed.latest_payment_attempt?.failure_code ?? confirmed.status,
      };
    } catch (err) {
      if (err instanceof AirwallexError) return { ...base, status: "ERROR", failure_reason: `${err.code ?? err.status}` };
      throw err;
    }
  }
}

function uuidFromKey(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
