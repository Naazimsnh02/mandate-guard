/**
 * All amounts inside Mandate Guard are integers in MINOR units (cents, paise)
 * to avoid floating point drift. Convert at the edges only.
 *
 * Note: Airwallex REST APIs use MAJOR units — convert with toMajor() before calling them.
 */
const DECIMALS: Record<string, number> = { JPY: 0, KRW: 0 };

export function decimalsFor(currency: string): number {
  return DECIMALS[currency.toUpperCase()] ?? 2;
}

export function toMinor(major: number | string, currency: string): number {
  const d = decimalsFor(currency);
  const n = typeof major === "string" ? Number(major.replace(/[^0-9.\-]/g, "")) : major;
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${major}`);
  return Math.round(n * 10 ** d);
}

export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** decimalsFor(currency);
}

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    toMajor(minor, currency),
  );
}
