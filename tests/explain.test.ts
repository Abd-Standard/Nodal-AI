/**
 * tests/explain.test.ts
 *
 * Unit tests for backend/ai/explain.ts
 *
 * Acceptance criteria
 * ───────────────────
 *  ✓ Top 25 Horizon/Soroban result codes are mapped
 *  ✓ Each entry has a non-empty description and suggestedFix
 *  ✓ Unknown codes return a safe fallback (not undefined/null)
 *  ✓ explainResultCodes produces a valid summary
 */

import { describe, it, expect } from 'vitest';
import { explainError, explainResultCodes, ResultCodeEntry } from '../backend/ai/explain';

// ─── Known codes that must be in the mapping table ────────────────────────────

const TOP_25_CODES = [
  // Transaction-level
  'tx_success',
  'tx_failed',
  'tx_bad_seq',
  'tx_bad_auth',
  'tx_insufficient_balance',
  'tx_no_source_account',
  'tx_insufficient_fee',
  'tx_bad_auth_extra',
  'tx_internal_error',
  'tx_not_supported',
  // Operation-level
  'op_success',
  'op_underfunded',
  'op_src_no_trust',
  'op_no_trust',
  'op_not_authorized',
  'op_no_destination',
  'op_line_full',
  'op_too_many_subentries',
  'op_bad_auth',
  'op_malformed',
  'op_low_reserve',
  'op_offer_not_found',
  'op_sell_no_trust',
  'op_buy_no_trust',
  // Soroban
  'Error_Contract',
];

describe('explainError', () => {
  it('covers all 25 required result codes', () => {
    for (const code of TOP_25_CODES) {
      const entry = explainError(code);
      expect(entry.code).toBe(code);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(entry.suggestedFix.length).toBeGreaterThan(5);
    }
  });

  it('returns non-null entry for every known code', () => {
    for (const code of TOP_25_CODES) {
      const entry = explainError(code);
      expect(entry).not.toBeNull();
      expect(entry).not.toBeUndefined();
    }
  });

  it('returns a safe fallback for an unknown code', () => {
    const entry = explainError('totally_unknown_code_xyz');
    expect(entry).not.toBeNull();
    expect(entry.code).toBe('totally_unknown_code_xyz');
    expect(entry.description).toContain('Unknown result code');
    expect(entry.suggestedFix).toContain('stellar.org');
  });

  it('op_underfunded has actionable fix about balance', () => {
    const entry = explainError('op_underfunded');
    expect(entry.description.toLowerCase()).toContain('balance');
    expect(entry.suggestedFix.toLowerCase()).toMatch(/balance|funds/);
  });

  it('tx_bad_seq has actionable fix about sequence number', () => {
    const entry = explainError('tx_bad_seq');
    expect(entry.description.toLowerCase()).toContain('sequence');
    expect(entry.suggestedFix.toLowerCase()).toContain('sequence');
  });

  it('op_no_destination has fix about creating the account', () => {
    const entry = explainError('op_no_destination');
    expect(entry.suggestedFix.toLowerCase()).toContain('create');
  });

  it('entry shape matches ResultCodeEntry interface', () => {
    const entry: ResultCodeEntry = explainError('tx_failed');
    expect(typeof entry.code).toBe('string');
    expect(typeof entry.description).toBe('string');
    expect(typeof entry.suggestedFix).toBe('string');
  });
});

describe('explainResultCodes', () => {
  it('maps an empty array to all-success summary', () => {
    const result = explainResultCodes([]);
    expect(result.summary).toBe('All operations succeeded.');
    expect(result.entries).toHaveLength(0);
    expect(result.codes).toHaveLength(0);
  });

  it('maps a single tx_success correctly', () => {
    const result = explainResultCodes(['tx_success']);
    expect(result.summary).toBe('All operations succeeded.');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.code).toBe('tx_success');
  });

  it('maps multiple failure codes and builds a summary', () => {
    const result = explainResultCodes(['tx_bad_seq', 'op_underfunded']);
    expect(result.codes).toEqual(['tx_bad_seq', 'op_underfunded']);
    expect(result.entries).toHaveLength(2);
    expect(result.summary).toContain('tx_bad_seq');
    expect(result.summary).toContain('op_underfunded');
  });

  it('preserves original code order in entries', () => {
    const codes = ['op_no_destination', 'tx_bad_auth', 'op_malformed'];
    const result = explainResultCodes(codes);
    expect(result.entries.map((e) => e.code)).toEqual(codes);
  });

  it('handles unknown codes gracefully in a batch', () => {
    const result = explainResultCodes(['op_underfunded', 'unknown_code_99']);
    expect(result.entries[1]!.description).toContain('Unknown result code');
  });

  it('summary contains descriptions for failure codes only (not op_success)', () => {
    const result = explainResultCodes(['tx_success', 'op_success']);
    expect(result.summary).toBe('All operations succeeded.');
  });
});
