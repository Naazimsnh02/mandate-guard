import { randomUUID } from "node:crypto";
import type { Mandate } from "../mandate/schema.js";
import { decimalsFor, formatMoney, toMajor } from "../lib/money.js";

/**
 * Where the one-time payment credential comes from.
 *
 * Kit 09 flow: after the shopper approves, the agent asks Airi CLI to create a
 * payment mandate and issue one-time credentials, uses them at the merchant
 * checkout, then reports the payment result back to Airi.
 *
 * Card data returned here is held in server memory only: it is handed straight
 * to the merchant adapter and never enters model context, logs, or the UI.
 */
export interface CardCredential {
  number: string;
  expiry_month: string;
  expiry_year: string;
  cvc: string;
  name: string;
}

export interface IssuedCredential {
  credential_id: string;
  /** The gateway's own mandate/authorization id (e.g. Airi payment mandate). */
  payment_mandate_id: string;
  card: CardCredential;
  amount_limit: number; // minor units
  currency: string;
  expires_at: string;
}

export type ReportedStatus = "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";

export interface PaymentReport {
  status: ReportedStatus;
  merchant_order_id?: string;
  merchant_reference?: string;
  failure_reason?: string;
}

export interface CredentialRequest {
  mandate: Mandate;
  mandate_jws: string;
  amount: number; // exact total to authorize, minor units
  /** Line items as observed at checkout (shown on the issuer's approval screen). */
  items?: { name: string; unit_price: number; quantity: number }[];
  /** Called when the issuer needs the shopper to approve (e.g. Airi passkey page) before releasing the credential. */
  onApprovalRequired?: (info: { url?: string; payment_mandate_id: string }) => void;
}

export interface PaymentGateway {
  readonly name: string;
  issueCredential(req: CredentialRequest): Promise<IssuedCredential>;
  reportResult(credential_id: string, report: PaymentReport): Promise<void>;
}

export class GatewayLimitError extends Error {}

/**
 * Behaves like the Airi hackathon test card: 4111 1111 1111 1111, a fixed
 * US$200 per-transaction limit, and a credential bound to one mandate + amount.
 * Used for offline demos and in tests.
 */
export class TestCardGateway implements PaymentGateway {
  readonly name = "test-card (Airi-compatible stub)";
  readonly issued = new Map<string, IssuedCredential & { mandate_id: string }>();
  readonly reports = new Map<string, PaymentReport>();

  constructor(
    private perTxLimit = 20_000,
    private clock: () => Date = () => new Date(),
  ) {}

  async issueCredential(req: CredentialRequest): Promise<IssuedCredential> {
    if (req.amount > this.perTxLimit) {
      throw new GatewayLimitError(
        `Amount exceeds the per-transaction limit of ${formatMoney(this.perTxLimit, req.mandate.currency)}`,
      );
    }
    if (req.amount > req.mandate.total_cap) throw new GatewayLimitError("Amount exceeds the mandate cap");
    const cred = {
      credential_id: "cred_" + randomUUID(),
      payment_mandate_id: "pm_" + randomUUID().slice(0, 12),
      card: { number: "4111111111111111", expiry_month: "12", expiry_year: "2030", cvc: "123", name: "Mandate Guard Test" },
      amount_limit: req.amount,
      currency: req.mandate.currency,
      expires_at: new Date(this.clock().getTime() + 10 * 60_000).toISOString(),
      mandate_id: req.mandate.mandate_id,
    };
    this.issued.set(cred.credential_id, cred);
    return cred;
  }

  async reportResult(credential_id: string, report: PaymentReport): Promise<void> {
    if (!this.issued.has(credential_id)) throw new Error(`Unknown credential ${credential_id}`);
    this.reports.set(credential_id, report);
  }
}

/**
 * Airi CLI gateway (Kit 09), per the @airwallex/airi-cli README:
 *   1. airi-cli mandate create …              → mandate_id + approval (passkey) URL for the shopper
 *   2. airi-cli mandate get-credential --file → polls until approved, writes the single-use
 *      credential to a 0600 file (never printed, never in model context)
 *   3. airi-cli mandate result --result SUCCEEDED|CANCELLED|DECLINED
 *
 * airi-cli ships macOS/Linux binaries only. On Windows run it in the docker/airi container
 * and set AIRI_EXEC_PREFIX="docker exec -i mandate-guard-airi".
 *
 * Env: AIRI_CLI (default "airi-cli"), AIRI_EXEC_PREFIX, AIRI_PAYMENT_METHOD_ID (default: first
 * listed), AIRI_MERCHANT_COUNTRY (default "US"), AIRI_SOURCE (default "mandate-guard"),
 * AIRI_CREDENTIAL_TIMEOUT (seconds, default 300).
 */
export class AiriCliGateway implements PaymentGateway {
  readonly name = "airi-cli";
  private prefix: string[];
  private bin: string;
  private paymentMethodId?: string;

  constructor(
    private env: NodeJS.ProcessEnv = process.env,
    private exec: Exec = execCommand,
  ) {
    this.prefix = (env.AIRI_EXEC_PREFIX ?? "").split(/\s+/).filter(Boolean);
    this.bin = env.AIRI_CLI ?? "airi-cli";
    this.paymentMethodId = env.AIRI_PAYMENT_METHOD_ID || undefined;
  }

  /** `auth whoami`: lets the app show whether Airi is signed in. */
  async whoami(): Promise<Record<string, unknown>> {
    return (await this.cli(["auth", "whoami", "-o", "json"])) as Record<string, unknown>;
  }

  async listPaymentMethods(): Promise<unknown> {
    return this.cli(["payment-methods", "list", "-o", "json"]);
  }

  async issueCredential(req: CredentialRequest): Promise<IssuedCredential> {
    const m = req.mandate;
    const major = (n: number) => toMajor(n, m.currency).toFixed(decimalsFor(m.currency));
    const pm = this.paymentMethodId ?? (this.paymentMethodId = firstPaymentMethodId(await this.listPaymentMethods()));
    const items = req.items ?? m.items.map((i) => ({ name: i.title, unit_price: i.unit_price, quantity: i.quantity }));
    const args = [
      "mandate", "create",
      "--source", this.env.AIRI_SOURCE ?? "mandate-guard",
      "--payment-method-id", pm,
      "--merchant-name", m.merchant.name,
      "--merchant-url", m.merchant.origin,
      "--merchant-country", this.env.AIRI_MERCHANT_COUNTRY ?? "US",
      "--total-amount", major(req.amount),
      "--currency", m.currency,
      ...items.flatMap((i) => ["--item", `name:${clean(i.name)},unit_price:${major(i.unit_price)},quantity:${i.quantity}`]),
      "--description", `Mandate Guard ${m.mandate_id.slice(0, 8)}: ${clean(m.intent).slice(0, 120)}`,
      "-o", "json",
    ];
    const created = await this.cli(args);
    const mandateId = String(pick(created, ["mandate_id", "mandateId", "id"]) ?? "");
    if (!mandateId) throw new Error(`airi-cli mandate create returned no mandate_id (shape: ${shape(created)})`);
    req.onApprovalRequired?.({ url: findUrl(created), payment_mandate_id: mandateId });

    // The credential goes to a 0600 file, is read once into memory, then deleted.
    const file = `/tmp/mg-cred-${mandateId.replace(/[^\w-]/g, "")}.json`;
    const timeout = Number(this.env.AIRI_CREDENTIAL_TIMEOUT ?? 300);
    await this.cli(
      ["mandate", "get-credential", "--mandate-id", mandateId, "--file", file, "--force", "--timeout", String(timeout), "-o", "json"],
      (timeout + 30) * 1000,
    );
    let raw: string;
    try {
      raw = await this.exec([...this.prefix, "cat", file], 15_000);
    } finally {
      await this.exec([...this.prefix, "rm", "-f", file], 15_000).catch(() => undefined);
    }
    return {
      credential_id: mandateId,
      payment_mandate_id: mandateId,
      card: parseCard(JSON.parse(raw)),
      amount_limit: req.amount,
      currency: m.currency,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }

  async reportResult(credential_id: string, report: PaymentReport): Promise<void> {
    if (report.status === "UNKNOWN") return; // report only once the outcome is known
    const result = report.status === "SUCCEEDED" ? "SUCCEEDED" : report.status === "CANCELLED" ? "CANCELLED" : "DECLINED";
    const args = ["mandate", "result", "--mandate-id", credential_id, "--result", result];
    const reason = report.failure_reason ?? (report.merchant_order_id ? `order ${report.merchant_order_id}` : undefined);
    if (reason) args.push("--reason", clean(reason).slice(0, 200));
    await this.cli([...args, "-o", "json"]);
  }

  private async cli(args: string[], timeoutMs = 60_000): Promise<unknown> {
    const out = await this.exec([...this.prefix, this.bin, ...args], timeoutMs);
    try {
      return out.trim() ? JSON.parse(out) : {};
    } catch {
      throw new Error(`airi-cli ${args.slice(0, 2).join(" ")} returned non-JSON output`);
    }
  }
}

export type Exec = (argv: string[], timeoutMs: number) => Promise<string>;

/** No shell: merchant-supplied text is passed as discrete argv entries. */
async function execCommand(argv: string[], timeoutMs: number): Promise<string> {
  const { execFile } = await import("node:child_process");
  const [cmd, ...args] = argv;
  return new Promise((resolve, reject) =>
    execFile(cmd!, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        // The credential itself goes to --file, so stderr/stdout never carry it.
        const detail = String(stderr || stdout || err.message).trim().split("\n").slice(-3).join(" ");
        return reject(new Error(`${argv.includes("airi-cli") ? "airi-cli" : cmd} failed: ${detail}`));
      }
      resolve(String(stdout));
    }),
  );
}

/** Item names come from the merchant: strip the CLI's field separators. */
function clean(s: string): string {
  return s.replace(/[,:\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

function pick(o: unknown, keys: string[]): unknown {
  if (!o || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  for (const k of keys) if (rec[k] !== undefined && rec[k] !== null && rec[k] !== "") return rec[k];
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") {
      const found = pick(v, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findUrl(o: unknown): string | undefined {
  const preferred = pick(o, ["verification_url", "verificationUrl", "approval_url", "approvalUrl", "passkey_url", "passkeyUrl", "url"]);
  if (typeof preferred === "string" && /^https?:\/\//.test(preferred)) return preferred;
  return JSON.stringify(o ?? {}).match(/https?:\/\/[^"\s]+/)?.[0];
}

/** Structure of a JSON value with every leaf replaced by its type (safe to log). */
function shape(o: unknown): string {
  return JSON.stringify(o, (_k, v) => (v !== null && typeof v === "object" ? v : typeof v)).slice(0, 400);
}

export function firstPaymentMethodId(list: unknown): string {
  const arr = Array.isArray(list) ? list : pick(list, ["payment_methods", "paymentMethods", "data", "items"]);
  const first = Array.isArray(arr) ? arr[0] : undefined;
  const id = pick(first, ["paymentMethodId", "payment_method_id", "id"]);
  if (!id) throw new Error("No Airi payment method available. Add the test card at app.airi.com, or set AIRI_PAYMENT_METHOD_ID.");
  return String(id);
}

/** Map the credential file to card fields without ever echoing values in errors. */
export function parseCard(o: unknown): CardCredential {
  const number = pick(o, ["pan", "number", "cardNumber", "card_number", "tokenNumber", "token"]);
  let month = pick(o, ["expiry_month", "expiryMonth", "exp_month", "expMonth"]);
  let year = pick(o, ["expiry_year", "expiryYear", "exp_year", "expYear"]);
  const combined = pick(o, ["expiry", "expiration", "expirationDate", "expiry_date", "exp"]);
  if ((!month || !year) && typeof combined === "string") {
    const slash = combined.match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/);
    const iso = combined.match(/^(\d{4})-(\d{2})/);
    if (slash) [month, year] = [slash[1], slash[2]];
    else if (iso) [month, year] = [iso[2], iso[1]];
  }
  const cvc = pick(o, ["cvc", "cvv", "cvv2", "securityCode", "security_code"]);
  if (!number || !month || !year || !cvc) throw new Error(`Could not read the Airi credential file (shape: ${shape(o)})`);
  const y = String(year);
  return {
    number: String(number).replace(/\s+/g, ""),
    expiry_month: String(month).padStart(2, "0"),
    expiry_year: y.length === 2 ? `20${y}` : y,
    cvc: String(cvc),
    name: String(pick(o, ["name", "cardholderName", "cardholder_name"]) ?? "Airi Agent"),
  };
}
