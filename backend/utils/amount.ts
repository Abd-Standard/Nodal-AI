/**
 * backend/utils/amount.ts
 *
 * Strict stroop-based arithmetic for Stellar amount strings.
 *
 * Stellar amounts are fixed-point decimals with up to 7 decimal places.
 * 1 stroop = 0.0000001 of the asset unit.
 *
 * Using BigInt avoids floating-point precision loss past ~15 significant
 * digits and rejects inputs (scientific notation, hex, whitespace) that
 * JavaScript's parseFloat would silently accept but Stellar would reject.
 */

/** Number of decimal places Stellar supports. */
export const STELLAR_DECIMAL_PLACES = 7;

/** Multiplier: 10^7 — converts a unit amount to stroops. */
export const STROOPS_PER_UNIT = BigInt(10_000_000);

/**
 * Strict regex: only unsigned decimals with at most 7 decimal places.
 * Scientific notation ("1e3"), hex ("0x10"), leading/trailing whitespace,
 * and negative values are all rejected.
 */
const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

/**
 * Convert a Stellar amount string to a BigInt count of stroops.
 *
 * @param str - A validated Stellar amount string (e.g. "10", "1.5000000").
 * @returns The amount expressed as a whole number of stroops (BigInt).
 * @throws {Error} If the string is not a valid Stellar amount.
 *
 * @example
 * toStroops("1")           // => 10_000_000n
 * toStroops("1.5")         // => 15_000_000n
 * toStroops("0.0000001")   // => 1n
 * toStroops("1e3")         // throws — scientific notation rejected
 * toStroops(" 5 ")         // throws — whitespace rejected
 * toStroops("0x10")        // throws — hex rejected
 */
export function toStroops(str: string): bigint {
  if (!AMOUNT_RE.test(str)) {
    throw new Error(
      `Invalid Stellar amount: "${str}". ` +
        `Must match /^\\d+(\\.\\d{1,7})?$/ (no scientific notation, hex, or whitespace).`
    );
  }

  const dotIndex = str.indexOf(".");
  if (dotIndex === -1) {
    // Integer part only — multiply by 10^7
    return BigInt(str) * STROOPS_PER_UNIT;
  }

  const intPart = str.slice(0, dotIndex);
  const fracPart = str.slice(dotIndex + 1);
  // Pad fractional part to exactly 7 digits (right-pad with zeroes)
  const fracPadded = fracPart.padEnd(STELLAR_DECIMAL_PLACES, "0");
  return BigInt(intPart) * STROOPS_PER_UNIT + BigInt(fracPadded);
}

/**
 * Convert a BigInt stroop count back to a canonical Stellar amount string
 * (7 decimal places, no trailing zeros stripped).
 *
 * @param stroops - Amount in stroops.
 * @returns A fixed-point decimal string with 7 decimal places (e.g. "1.5000000").
 *
 * @example
 * fromStroops(10_000_000n)  // => "1.0000000"
 * fromStroops(15_000_000n)  // => "1.5000000"
 * fromStroops(1n)           // => "0.0000001"
 */
export function fromStroops(stroops: bigint): string {
  if (stroops < 0n) {
    throw new Error(`Stroop value must be non-negative, got ${stroops}`);
  }
  const units = stroops / STROOPS_PER_UNIT;
  const remainder = stroops % STROOPS_PER_UNIT;
  const fracStr = remainder.toString().padStart(STELLAR_DECIMAL_PLACES, "0");
  return `${units}.${fracStr}`;
}

/**
 * Compare two Stellar amount strings.
 *
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 * @throws {Error} If either string is not a valid Stellar amount.
 */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  const sa = toStroops(a);
  const sb = toStroops(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/**
 * Add two Stellar amount strings, returning the result in stroops (BigInt).
 * Use fromStroops() to convert back to a string if needed.
 *
 * @throws {Error} If either string is not a valid Stellar amount.
 */
export function addAmounts(a: string, b: string): bigint {
  return toStroops(a) + toStroops(b);
}
