import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MandateSignatureError,
  generateMandateKeys,
  issueMandate,
  loadOrCreateKeys,
  verifyMandate,
} from "../src/mandate/signer.js";
import { NOW, terms } from "./fixtures.js";

const keysP = generateMandateKeys();
const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe("mandate signing", () => {
  it("issues a signed mandate that verifies and round-trips", async () => {
    const keys = await keysP;
    const signed = await issueMandate(terms(), keys, { now: NOW, ttlMinutes: 15 });
    expect(signed.mandate.expires_at).toBe("2026-11-08T10:15:00.000Z");
    const verified = await verifyMandate(signed.jws, keys.publicKey);
    expect(verified.mandate).toEqual(signed.mandate);
    expect(verified.digest).toBe(signed.digest);
  });

  it("rejects a tampered payload (e.g. agent raises the cap)", async () => {
    const keys = await keysP;
    const { jws } = await issueMandate(terms(), keys, { now: NOW });
    const [h, p, s] = jws.split(".");
    const body = JSON.parse(Buffer.from(p!, "base64url").toString());
    body.total_cap = 99_999;
    const forged = [h, Buffer.from(JSON.stringify(body)).toString("base64url"), s].join(".");
    await expect(verifyMandate(forged, keys.publicKey)).rejects.toBeInstanceOf(MandateSignatureError);
  });

  it("rejects a mandate signed by a different key", async () => {
    const keys = await keysP;
    const other = await generateMandateKeys();
    const { jws } = await issueMandate(terms(), other, { now: NOW });
    await expect(verifyMandate(jws, keys.publicKey)).rejects.toBeInstanceOf(MandateSignatureError);
  });

  it("refuses a cap lower than the approved basket", async () => {
    const keys = await keysP;
    await expect(issueMandate({ ...terms(), total_cap: 1000 }, keys)).rejects.toThrow(/total_cap/);
  });

  it("persists and reloads the signing key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mg-"));
    dirs.push(dir);
    const path = join(dir, "keys", "k.jwk");
    const a = await loadOrCreateKeys(path);
    const b = await loadOrCreateKeys(path);
    expect(b.kid).toBe(a.kid);
    const { jws } = await issueMandate(terms(), a, { now: NOW });
    await expect(verifyMandate(jws, b.publicKey)).resolves.toBeTruthy();
  });
});
