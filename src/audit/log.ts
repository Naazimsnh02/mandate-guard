import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalize, sha256Hex } from "../lib/canonical.js";

/**
 * Append-only, hash-chained audit log. Each entry commits to the previous
 * entry's hash, so editing or deleting any past record breaks verification.
 * Persisted as JSONL (one entry per line) when a path is given.
 *
 * Never log raw card data: callers pass last4 only.
 */
export interface AuditEntry {
  seq: number;
  ts: string;
  session_id: string;
  type: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(
    private path?: string,
    private clock: () => Date = () => new Date(),
  ) {
    if (path && existsSync(path)) {
      this.entries = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditEntry);
    } else if (path) {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  append(session_id: string, type: string, data: Record<string, unknown> = {}): AuditEntry {
    assertNoCardData(data);
    const prev = this.entries.at(-1);
    const body = {
      seq: (prev?.seq ?? 0) + 1,
      ts: this.clock().toISOString(),
      session_id,
      type,
      data,
      prev_hash: prev?.hash ?? GENESIS,
    };
    const entry: AuditEntry = { ...body, hash: sha256Hex(canonicalize(body)) };
    this.entries.push(entry);
    if (this.path) appendFileSync(this.path, JSON.stringify(entry) + "\n");
    return entry;
  }

  forSession(session_id: string): AuditEntry[] {
    return this.entries.filter((e) => e.session_id === session_id);
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }

  /** Recompute the whole chain. Returns the first broken seq, or null if intact. */
  verify(): { ok: true; count: number } | { ok: false; brokenAt: number; reason: string } {
    let prevHash = GENESIS;
    for (const e of this.entries) {
      const { hash, ...body } = e;
      if (e.prev_hash !== prevHash) return { ok: false, brokenAt: e.seq, reason: "prev_hash mismatch" };
      if (sha256Hex(canonicalize(body)) !== hash) return { ok: false, brokenAt: e.seq, reason: "hash mismatch" };
      prevHash = hash;
    }
    return { ok: true, count: this.entries.length };
  }
}

/** Defence in depth: refuse anything that looks like a full card number. */
function assertNoCardData(data: unknown): void {
  const s = JSON.stringify(data);
  for (const m of s.matchAll(/(?<![\w-])\d{15,16}(?![\w-])/g)) {
    if (luhn(m[0])) throw new Error("Refusing to write what looks like a card number to the audit log");
  }
}

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1 && (n *= 2) > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}
