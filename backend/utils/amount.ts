/**
 * backend/utils/amount.ts
 *
 * Utilities and schemas for Stellar amount handling and stroop conversions.
 * Stellar's smallest base unit is the stroop: 1 XLM = 10,000,000 stroops (7 decimal places).
 * Integer math in stroops (BigInt) prevents precision loss and floating-point errors.
 */

import { z } from 'zod';

/** 1 unit = 10,000,000 stroops (7 decimal places) */
export const STROOP_SCALE = 10_000_000n;
export const MAX_DECIMAL_PLACES = 7;

/**
 * Regex for valid non-negative Stellar amounts with up to 7 decimal places.
 * Rejects negative numbers, scientific notation (exponent), non-numeric chars,
 * and numbers with >7 decimal places.
 */
export const STELLAR_AMOUNT_REGEX = /^\d+(\.\d{1,7})?$/;

/**
 * Regex for strictly positive Stellar amounts (rejects 0, 0.0, 0.0000000).
 */
export const POSITIVE_STELLAR_AMOUNT_REGEX = /^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/;

/**
 * Convert a decimal string representation of an amount into stroops (BigInt).
 *
 * @param decimal - String representation of the amount (e.g. "10", "1.5000000").
 * @returns Amount in stroops as a BigInt.
 * @throws {TypeError} If `decimal` is not a string.
 * @throws {Error} If `decimal` is negative, exponent notation, NaN, non-numeric,
 *                 or has more than 7 decimal places.
 */
export function toStroops(decimal: string): bigint {
  if (typeof decimal !== 'string') {
    throw new TypeError(`Amount must be a string, got ${typeof decimal}`);
  }

  // Explicit rejections with clear messages
  if (decimal.includes('e') || decimal.includes('E')) {
    throw new Error(`Invalid amount: exponent notation is not supported ("${decimal}")`);
  }
  if (decimal.includes('-')) {
    throw new Error(`Invalid amount: negative amounts are not allowed ("${decimal}")`);
  }
  if (decimal === 'NaN' || Number.isNaN(Number(decimal))) {
    throw new Error(`Invalid amount: non-numeric or NaN value ("${decimal}")`);
  }
  if (decimal.includes('.')) {
    const parts = decimal.split('.');
    if (parts.length !== 2) {
      throw new Error(`Invalid amount: multiple decimal points found in ("${decimal}")`);
    }
    if (parts[1]!.length > MAX_DECIMAL_PLACES) {
      throw new Error(
        `Invalid amount: exceeds maximum ${MAX_DECIMAL_PLACES} decimal places ("${decimal}")`
      );
    }
  }

  if (!STELLAR_AMOUNT_REGEX.test(decimal)) {
    throw new Error(`Invalid amount format: "${decimal}"`);
  }

  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole) * STROOP_SCALE + BigInt(fraction.padEnd(MAX_DECIMAL_PLACES, '0'));
}

/**
 * Convert an amount in stroops (BigInt) to a canonical 7-decimal-place string.
 *
 * @param stroops - Amount in stroops as a non-negative BigInt.
 * @returns 7-decimal-place string (e.g. 10_000_000n -> "1.0000000").
 * @throws {TypeError} If `stroops` is not a bigint.
 * @throws {RangeError} If `stroops` is negative.
 */
export function fromStroops(stroops: bigint): string {
  if (typeof stroops !== 'bigint') {
    throw new TypeError(`stroops must be a bigint, got ${typeof stroops}`);
  }
  if (stroops < 0n) {
    throw new RangeError(`stroops cannot be negative, got ${stroops}`);
  }
  const whole = stroops / STROOP_SCALE;
  const fraction = stroops % STROOP_SCALE;
  return `${whole}.${fraction.toString().padStart(MAX_DECIMAL_PLACES, '0')}`;
}

/**
 * Compare two valid decimal amount strings.
 * Returns -1 if a < b, 0 if a == b, and 1 if a > b.
 *
 * @throws If either `a` or `b` cannot be converted to stroops.
 */
export function compareAmounts(a: string, b: string): number {
  const stroopsA = toStroops(a);
  const stroopsB = toStroops(b);
  if (stroopsA < stroopsB) return -1;
  if (stroopsA > stroopsB) return 1;
  return 0;
}

/**
 * Check if a string is a valid non-negative Stellar amount with up to 7 decimal places.
 */
export function isValidAmount(decimal: string): boolean {
  try {
    toStroops(decimal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely attempt to parse an amount to stroops, returning null if invalid.
 */
export function tryToStroops(decimal: string): bigint | null {
  try {
    return toStroops(decimal);
  } catch {
    return null;
  }
}

/**
 * Zod schema for validating a positive Stellar payment amount.
 */
export const positiveAmountSchema = z
  .string()
  .regex(POSITIVE_STELLAR_AMOUNT_REGEX, 'Amount must be a valid Stellar decimal')
  .refine((v) => parseFloat(v) > 0, 'Amount must be greater than zero');
