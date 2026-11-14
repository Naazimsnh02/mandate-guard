import { describe, expect, it } from "vitest";
import { AiriCliGateway, parseCard, type Exec } from "../src/payments/gateway.js";
import { generateMandateKeys, issueMandate } from "../src/mandate/signer.js";
import { terms } from "./fixtures.js";

/** Fake airi-cli: records argv, answers like the README describes. */
function fakeCli(credFile: unknown = { pan: "4111111111111111", expiry: "12/30", cvv: "123" }) {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    const cmd = argv.slice(argv.indexOf("airi-cli") + 1);
    if (argv.includes("cat")) return JSON.stringify(credFile);
    if (argv.includes("rm")) return "";
    if (cmd[0] === "payment-methods") return JSON.stringify([{ paymentMethodId: "pm_test_1", brand: "visa", last4: "1111" }]);
    if (cmd[0] === "mandate" && cmd[1] === "create") return JSON.stringify({ mandate_id: "md_123", verification_url: "https://app.airi.com/approve/md_123" });
    if (cmd[0] === "mandate" && cmd[1] === "get-credential") return JSON.stringify({ status: "AUTHORIZED", tokenType: "PAN" });
    if (cmd[0] === "mandate" && cmd[1] === "result") return JSON.stringify({ ok: true });
    throw new Error("unexpected " + argv.join(" "));
  };
  return { calls, exec };
}

describe("AiriCliGateway", () => {
  it("creates a mandate, waits for approval, reads + deletes the credential file, reports the result", async () => {
    const { calls, exec } = fakeCli();
    const g = new AiriCliGateway({ AIRI_EXEC_PREFIX: "docker exec -i mandate-guard-airi" }, exec);
    const { mandate, jws } = await issueMandate(terms(), await generateMandateKeys());
    const approvals: unknown[] = [];
    const cred = await g.issueCredential({
      mandate,
      mandate_jws: jws,
      amount: 1299,
      items: [
        { name: "USB-C Cable, 1m: braided", unit_price: 999, quantity: 1 },
        { name: "Standard shipping", unit_price: 300, quantity: 1 },
      ],
      onApprovalRequired: (i) => approvals.push(i),
    });

    expect(cred.card).toMatchObject({ number: "4111111111111111", expiry_month: "12", expiry_year: "2030", cvc: "123" });
    expect(cred.credential_id).toBe("md_123");
    expect(approvals).toEqual([{ url: "https://app.airi.com/approve/md_123", payment_mandate_id: "md_123" }]);

    const create = calls.find((c) => c.includes("create"))!;
    expect(create.slice(0, 4)).toEqual(["docker", "exec", "-i", "mandate-guard-airi"]);
    expect(create).toContain("pm_test_1");
    expect(create[create.indexOf("--total-amount") + 1]).toBe("12.99");
    // separators in merchant text are stripped so they can't inject extra item fields
    expect(create).toContain("name:USB-C Cable 1m braided,unit_price:9.99,quantity:1");
    const getCred = calls.find((c) => c.includes("get-credential"))!;
    expect(getCred).toContain("--file");
    expect(calls.some((c) => c.includes("rm"))).toBe(true);

    await g.reportResult("md_123", { status: "SUCCEEDED", merchant_order_id: "DM-1" });
    await g.reportResult("md_123", { status: "FAILED", failure_reason: "card_declined" });
    await g.reportResult("md_123", { status: "UNKNOWN" });
    const results = calls.filter((c) => c.includes("result")).map((c) => c[c.indexOf("--result") + 1]);
    expect(results).toEqual(["SUCCEEDED", "DECLINED"]);
  });

  it("parses common credential shapes and never echoes values on failure", () => {
    expect(parseCard({ card: { cardNumber: "4111 1111 1111 1111", expiryMonth: 1, expiryYear: 2031, cvc: "999" } })).toMatchObject({
      number: "4111111111111111",
      expiry_month: "01",
      expiry_year: "2031",
    });
    expect(parseCard({ pan: "4111111111111111", expirationDate: "2030-12", cvv: "1" })).toMatchObject({ expiry_month: "12", expiry_year: "2030" });
    try {
      parseCard({ pan: "4111111111111111" });
      throw new Error("should fail");
    } catch (e) {
      expect((e as Error).message).not.toContain("4111");
    }
  });
});
