/**
 * backend/ai/explain.ts
 *
 * Human-readable explanations for Stellar Horizon and Soroban result codes.
 *
 * Why this exists
 * ───────────────
 * Stellar result codes like op_underfunded or tx_bad_seq are terse machine
 * identifiers that confuse end-users and make automated recovery harder.
 * This module provides:
 *
 *  1. explainError(code) – Returns a plain-English description plus a
 *     suggested fix for the top-25 most common result codes.
 *
 *  2. explainResultCodes(resultCodes) – Maps an array of result-code strings
 *     (from a Horizon SubmitTransactionResponse) into a structured summary.
 *
 * The mapping table covers:
 *   - Transaction-level codes (tx_*)
 *   - Operation-level codes (op_*)
 *   - Soroban / RPC error codes (Error_* / HOST_VALUE_*)
 */

// ─── Result-code entry ────────────────────────────────────────────────────────

export interface ResultCodeEntry {
  /** Machine-readable result code (e.g. "op_underfunded"). */
  code: string;
  /** Plain-English description of what happened. */
  description: string;
  /** Actionable suggestion for the user or automated planner. */
  suggestedFix: string;
}

// ─── Mapping table (top 25 codes) ─────────────────────────────────────────────

const RESULT_CODE_TABLE: Record<string, Omit<ResultCodeEntry, 'code'>> = {
  // ── Transaction-level ─────────────────────────────────────────────────────
  tx_success: {
    description: 'The transaction was included in the ledger and all operations succeeded.',
    suggestedFix: 'No action needed.',
  },
  tx_failed: {
    description:
      'The transaction was included in the ledger but one or more operations failed. ' +
      'Check the individual operation result codes for details.',
    suggestedFix: 'Inspect op_* codes in the result and correct the failing operation.',
  },
  tx_bad_seq: {
    description:
      'The sequence number on the transaction does not match the account sequence number ' +
      'on the ledger. This happens when another transaction from the same account was ' +
      'submitted concurrently or the account state changed.',
    suggestedFix:
      'Fetch the current sequence number from Horizon, rebuild the transaction with the ' +
      'correct sequence number, and resubmit.',
  },
  tx_bad_auth: {
    description:
      'The transaction has too few valid signatures, or the signatures presented do not ' +
      'meet the required thresholds for the operations requested.',
    suggestedFix:
      'Ensure all required signers have signed the transaction and that their weights ' +
      'meet the low/medium/high threshold for the operations.',
  },
  tx_insufficient_balance: {
    description:
      'The source account does not have sufficient XLM to pay the transaction fee and ' +
      'maintain the minimum reserve after debiting the fee.',
    suggestedFix:
      'Fund the source account with additional XLM before resubmitting, or reduce the ' +
      'transaction fee.',
  },
  tx_no_source_account: {
    description: 'The source account specified in the transaction does not exist on the ledger.',
    suggestedFix:
      'Create the source account first (via Friendbot on testnet, or a funded transfer ' +
      'on mainnet) before submitting this transaction.',
  },
  tx_insufficient_fee: {
    description:
      'The fee bid on the transaction is below the network base fee for the current surge ' +
      'pricing window.',
    suggestedFix:
      'Fetch the current base fee from Horizon (/fee_stats) and resubmit with a fee at ' +
      'or above the recommended value.',
  },
  tx_bad_auth_extra: {
    description:
      'The transaction contains more signatures than required. Stellar disallows extra ' +
      'signatures to prevent signature stuffing attacks.',
    suggestedFix: 'Remove excess signatures and resubmit.',
  },
  tx_internal_error: {
    description:
      'An internal Stellar Core error occurred while processing the transaction. This is ' +
      'rare and usually transient.',
    suggestedFix: 'Wait a moment and retry. If it persists, contact Stellar network support.',
  },
  tx_not_supported: {
    description: 'The transaction type or an operation type is not supported on this network.',
    suggestedFix:
      'Verify you are targeting the correct network (testnet/mainnet/futurenet) and that ' +
      'the operation is available on it.',
  },

  // ── Operation-level ───────────────────────────────────────────────────────
  op_success: {
    description: 'The operation succeeded.',
    suggestedFix: 'No action needed.',
  },
  op_underfunded: {
    description:
      'The source account does not hold enough of the asset being sent to complete the ' +
      'operation after accounting for fees and minimum reserve.',
    suggestedFix:
      'Check the account balance for the relevant asset. Add funds or reduce the send ' +
      'amount.',
  },
  op_src_no_trust: {
    description:
      'The source account does not have a trustline for the asset it is trying to send.',
    suggestedFix:
      'Establish a trustline to the asset issuer from the source account before sending.',
  },
  op_no_trust: {
    description:
      'The destination account does not have a trustline for the asset being received.',
    suggestedFix:
      'Ask the destination account holder to establish a trustline to the asset issuer ' +
      'before sending.',
  },
  op_not_authorized: {
    description:
      'The asset issuer has not authorised the source or destination account to hold the ' +
      'asset (required trust flag is set).',
    suggestedFix:
      'Contact the asset issuer to grant authorization to the relevant account, or use a ' +
      'different asset.',
  },
  op_no_destination: {
    description: 'The destination account does not exist on the ledger.',
    suggestedFix:
      'Create the destination account first (fund it with at least the minimum reserve ' +
      'in XLM), then retry.',
  },
  op_line_full: {
    description:
      'The destination account already holds the maximum allowed amount of the asset ' +
      '(trustline limit reached).',
    suggestedFix:
      'Ask the destination account holder to increase their trustline limit or send a ' +
      'smaller amount.',
  },
  op_too_many_subentries: {
    description:
      'The account has reached the maximum number of sub-entries (trustlines, offers, ' +
      'data entries, signers). Each sub-entry requires an additional 0.5 XLM reserve.',
    suggestedFix:
      'Remove unused trustlines, offers, or data entries, or fund the account with ' +
      'additional XLM to raise its available reserve.',
  },
  op_bad_auth: {
    description: 'The operation lacks sufficient authorisation from the required signers.',
    suggestedFix:
      'Check that all required signers for this specific operation have signed and that ' +
      'their weights meet the required threshold.',
  },
  op_malformed: {
    description: 'One or more operation fields are invalid or out of allowed range.',
    suggestedFix:
      'Review the operation parameters (amounts, asset codes, addresses) and correct ' +
      'any invalid values.',
  },
  op_low_reserve: {
    description:
      'The operation would cause the account balance to drop below the minimum XLM ' +
      'reserve required for its current sub-entries.',
    suggestedFix:
      'Fund the account with additional XLM to cover the minimum reserve before ' +
      'performing this operation.',
  },
  op_offer_not_found: {
    description: 'The offer being modified or deleted was not found on the order book.',
    suggestedFix: 'Fetch the current offers for the account and use the correct offer ID.',
  },
  op_sell_no_trust: {
    description: 'The selling account does not have a trustline for the asset being sold.',
    suggestedFix: 'Establish a trustline for the sell asset before placing the offer.',
  },
  op_buy_no_trust: {
    description: 'The buying account does not have a trustline for the asset being bought.',
    suggestedFix: 'Establish a trustline for the buy asset before placing the offer.',
  },

  // ── Soroban / RPC ─────────────────────────────────────────────────────────
  Error_Contract: {
    description:
      'A Soroban smart-contract returned an error from its own logic (e.g. a panic, ' +
      'assertion failure, or explicit error value).',
    suggestedFix:
      'Inspect the contract diagnostic events for the specific error value. Check that ' +
      'all preconditions required by the contract are met.',
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up a single result code and return a structured explanation.
 *
 * @param code - A Stellar/Soroban result code string (e.g. "op_underfunded").
 * @returns A {@link ResultCodeEntry} with a human-readable description and
 *   suggested fix. When the code is not in the table, a generic "unknown code"
 *   entry is returned so callers always get a safe, non-null value.
 */
export function explainError(code: string): ResultCodeEntry {
  const entry = RESULT_CODE_TABLE[code];
  if (entry) {
    return { code, ...entry };
  }

  return {
    code,
    description: `Unknown result code "${code}". This may be a new or undocumented code.`,
    suggestedFix:
      'Consult the Stellar Developers documentation at https://developers.stellar.org/docs ' +
      'for the latest list of result codes.',
  };
}

/**
 * Map an array of result-code strings into a structured explanation summary.
 *
 * Horizon's SubmitTransactionResponse carries result codes at two levels:
 *   - transaction: a single tx_* string
 *   - operations: an array of op_* strings (one per operation in the envelope)
 *
 * This function accepts either form.
 *
 * @param resultCodes - Array of result-code strings to explain.
 * @returns An object with:
 *   - `codes`   – The original array, preserved for reference.
 *   - `entries` – One {@link ResultCodeEntry} per code.
 *   - `summary` – A single human-readable sentence summarising all failures.
 */
export function explainResultCodes(resultCodes: string[]): {
  codes: string[];
  entries: ResultCodeEntry[];
  summary: string;
} {
  const entries = resultCodes.map(explainError);
  const failures = entries.filter((e) => e.code !== 'tx_success' && e.code !== 'op_success');

  const summary =
    failures.length === 0
      ? 'All operations succeeded.'
      : failures.map((e) => `${e.code}: ${e.description}`).join(' | ');

  return { codes: resultCodes, entries, summary };
}
