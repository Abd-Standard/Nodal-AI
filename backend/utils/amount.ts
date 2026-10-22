/**
 * backend/utils/amount.ts
 *
 * Strict integer (stroop) arithmetic for Stellar monetary values.
 *
 * Why BigInt?
 *   Stellar amounts have up to 7 decimal places (1 XLM = 10,000,000 stroops).
 *   Using IEEE-754 `number` accumulates rounding error past ~15 significant
 *   digits and silently accepts inputs like '1e3', '0x10', or ' 5 ' that
 *   Stellar would reject.  All comparisons and accumulation must happen in
 *   integer stroop space.
 *
 * Usage:
 *   import { toStroops, stroopsToString, STROOPS_PER_UNIT } from "./amount";
 *   const a = toStroops("9.9999999"); // 99_999_999n
 *   const b = toStroops("0.0000001"); //         1n
 *   a + b === 100_000_000n            // true — no float error
 *
 * Rejects (throws):
 *   - Scientific notation  ("1e3", "2.5E+4")
 *   - Hex literals          ("0x10")
 *   - Leading/trailing whitespace (" 5 ")
 *   - Negative values       ("-1")
 *   - More than 7 decimal places ("1.00000001")
 *   - Empty string, NaN, Infinity
 */

/** Number of stroops in one unit (1 XLM = 10_000_000 stroops). */
export const STROOPS_PER_UNIT = 10_000_000n;

/**
 * Strict amount pattern: one or more digits, optionally followed by a dot and
 * 1–7 digits.  No sign, no exponent, no hex, no whitespace.
 */
const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

/**
 * Convert a Stellar amount string to an integer stroop count (BigInt).
 *
 * @param amountStr - A non-negative decimal string with up to 7 decimal places
 *                    (e.g. "100", "9.9999999", "0.0000001").
 * @returns The equivalent number of stroops as a BigInt.
 * @throws {Error} If the string does not match the strict Stellar amount format.
 */
export function toStroops(amountStr: string): bigint {
  if (!AMOUNT_RE.test(amountStr)) {
    throw new Error(
      `Invalid Stellar amount "${amountStr}": must match /^\\d+(\\.\\d{1,7})?$/ ` +
      `(no scientific notation, hex, whitespace, or sign)`
    );
  }

  const dotIndex = amountStr.indexOf(".");
  if (dotIndex === -1) {
    // Whole number — multiply directly
    return BigInt(amountStr) * STROOPS_PER_UNIT;
  }

  const whole = amountStr.slice(0, dotIndex);
  const frac  = amountStr.slice(dotIndex + 1);

  // Pad fractional part on the right to exactly 7 digits so we can multiply
  // without floating-point intermediaries.
  const padded = frac.padEnd(7, "0");

  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(padded);
}

/**
 * Convert a stroop count back to a canonical 7-decimal-place string.
 * Useful for display and logging.
 *
 * @example stroopsToString(10_000_001n) === "1.0000001"
 * @example stroopsToString(            1n) === "0.0000001"
 */
export function stroopsToString(stroops: bigint): string {
  const units = stroops / STROOPS_PER_UNIT;
  const frac  = stroops % STROOPS_PER_UNIT;
  return `${units}.${String(frac).padStart(7, "0")}`;
}
