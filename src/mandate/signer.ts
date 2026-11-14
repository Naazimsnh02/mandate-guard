import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CompactSign,
  compactVerify,
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JWK,
} from "jose";
import { canonicalize, digest } from "../lib/canonical.js";
import { Mandate, MandateTerms, type MandateTermsInput } from "./schema.js";

const ALG = "EdDSA";
const TYP = "mandate-guard+jws";

export interface MandateKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
}

export interface SignedMandate {
  mandate: Mandate;
  /** Compact JWS over the canonical mandate JSON. */
  jws: string;
  /** sha256 of the canonical mandate — stable ID for audit + idempotency. */
  digest: string;
}

export async function generateMandateKeys(): Promise<MandateKeys> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { crv: "Ed25519", extractable: true });
  const kid = digest(await exportJWK(publicKey)).slice(0, 16);
  return { privateKey, publicKey, kid };
}

/** Load the signing key from disk, creating one on first run. Never commit this file. */
export async function loadOrCreateKeys(path: string): Promise<MandateKeys> {
  try {
    const jwk = JSON.parse(await readFile(path, "utf8")) as JWK & { kid: string };
    const privateKey = (await importJWK(jwk, ALG)) as CryptoKey;
    const { d: _d, ...pub } = jwk;
    const publicKey = (await importJWK(pub, ALG)) as CryptoKey;
    return { privateKey, publicKey, kid: jwk.kid };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const keys = await generateMandateKeys();
    const jwk = { ...(await exportJWK(keys.privateKey)), kid: keys.kid };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(jwk), { mode: 0o600 });
    return keys;
  }
}

export interface IssueOptions {
  ttlMinutes?: number;
  now?: Date;
  supersedes?: string;
}

/** Turn approved terms into a signed, expiring mandate. */
export async function issueMandate(
  terms: MandateTermsInput,
  keys: MandateKeys,
  opts: IssueOptions = {},
): Promise<SignedMandate> {
  const now = opts.now ?? new Date();
  const ttl = opts.ttlMinutes ?? 30;
  const parsed = MandateTerms.parse(terms);
  if (parsed.total_cap < sumApproved(parsed)) {
    throw new Error("total_cap is below the approved items + fulfillment + fees");
  }
  const mandate = Mandate.parse({
    ...parsed,
    mandate_id: randomUUID(),
    version: 1,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl * 60_000).toISOString(),
    supersedes: opts.supersedes,
  });
  const payload = new TextEncoder().encode(canonicalize(mandate));
  const jws = await new CompactSign(payload)
    .setProtectedHeader({ alg: ALG, typ: TYP, kid: keys.kid })
    .sign(keys.privateKey);
  return { mandate, jws, digest: digest(mandate) };
}

export class MandateSignatureError extends Error {}

/** Verify signature + schema. Throws MandateSignatureError on any tampering. */
export async function verifyMandate(jws: string, publicKey: CryptoKey): Promise<SignedMandate> {
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(jws, publicKey, { algorithms: [ALG] }));
  } catch (err) {
    throw new MandateSignatureError(`Mandate signature invalid: ${(err as Error).message}`);
  }
  const mandate = Mandate.parse(JSON.parse(new TextDecoder().decode(payload)));
  return { mandate, jws, digest: digest(mandate) };
}

export function sumApproved(t: MandateTerms): number {
  const items = t.items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  const fees = t.fees.reduce((s, f) => s + f.amount, 0);
  return items + fees + t.fulfillment.cost;
}
