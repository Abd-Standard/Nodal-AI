/**
 * backend/errors.ts
 *
 * Typed error classes for tool failures and system errors.
 * Allows callers to programmatically distinguish between error types
 * rather than relying on brittle string matching.
 */

export enum ErrorType {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  NetworkTimeout = 'NETWORK_TIMEOUT',
  ValidationError = 'VALIDATION_ERROR',
  RateLimitError = 'RATE_LIMIT_ERROR',
  UnauthorizedError = 'UNAUTHORIZED_ERROR',
  ContractError = 'CONTRACT_ERROR',
  /**
   * A simulation exceeded its resource budget (Issue #569).
   *
   * Separate from ContractError because the caller's response differs: a
   * budget overrun is retryable with a larger budget or a smaller call, while
   * a contract error usually is not. Sharing one type forced callers to
   * string-match the message, which is exactly what errorType exists to avoid.
   */
  SimulationBudgetExceeded = 'SIMULATION_BUDGET_EXCEEDED',
  TransactionFailure = 'TRANSACTION_FAILURE',
  ConfigError = 'CONFIG_ERROR',
  /** The operator kill switch is engaged; value-moving tasks are halted. */
  AgentPaused = 'AGENT_PAUSED',
  /** The task exceeds APPROVAL_THRESHOLD and is waiting for a human decision. */
  PendingApproval = 'PENDING_APPROVAL',
  /** The payment destination is not permitted by PAYMENT_DESTINATION_POLICY. */
  PolicyViolation = 'POLICY_VIOLATION',
  UnknownError = 'UNKNOWN_ERROR',
}

export class StructuredError extends Error {
  readonly errorType: ErrorType;
  readonly cause?: unknown;

  constructor(message: string, errorType: ErrorType, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.errorType = errorType;
    this.cause = cause;
    Object.setPrototypeOf(this, StructuredError.prototype);
  }
}

export class InsufficientFundsError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.InsufficientFunds, cause);
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

export class NetworkTimeoutError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.NetworkTimeout, cause);
    Object.setPrototypeOf(this, NetworkTimeoutError.prototype);
  }
}

export class ValidationError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.ValidationError, cause);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class RateLimitError extends StructuredError {
  readonly retryAfterSeconds: number | undefined;
  readonly retryAfterSeconds?: number | undefined;

  constructor(message: string, retryAfterSeconds?: number, cause?: unknown) {
    super(message, ErrorType.RateLimitError, cause);
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class UnauthorizedError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.UnauthorizedError, cause);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

export class ContractError extends StructuredError {
  readonly contractId: string | undefined;
  readonly contractId?: string | undefined;

  constructor(message: string, contractId?: string, cause?: unknown) {
    super(message, ErrorType.ContractError, cause);
    if (contractId !== undefined) this.contractId = contractId;
    Object.setPrototypeOf(this, ContractError.prototype);
  }
}

export class TransactionFailureError extends StructuredError {
  readonly txHash: string | undefined;
  readonly txHash?: string | undefined;

  constructor(message: string, txHash?: string, cause?: unknown) {
    super(message, ErrorType.TransactionFailure, cause);
    if (txHash !== undefined) this.txHash = txHash;
    Object.setPrototypeOf(this, TransactionFailureError.prototype);
  }
}

export class ConfigError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.ConfigError, cause);
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

export class SimulationBudgetError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.SimulationBudgetExceeded, cause);
    Object.setPrototypeOf(this, SimulationBudgetError.prototype);
  }
}

export class AgentPausedError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.AgentPaused, cause);
    Object.setPrototypeOf(this, AgentPausedError.prototype);
  }
}

export class PolicyViolationError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.PolicyViolation, cause);
    Object.setPrototypeOf(this, PolicyViolationError.prototype);
  }
}

// ─── Destination pre-flight errors (#788) ────────────────────────────────────
// Raised before signing, so the payment never reaches the network. All three
// are ValidationErrors (the request cannot succeed as given) with their own
// class so callers can tell which check failed without string-matching.

/** The destination account does not exist on the network. */
export class DestinationNotFoundError extends ValidationError {
  readonly destination: string;

  constructor(message: string, destination: string, cause?: unknown) {
    super(message, cause);
    this.destination = destination;
    Object.setPrototypeOf(this, DestinationNotFoundError.prototype);
  }
}

/** The destination has no trustline for the non-native asset being sent. */
export class MissingTrustlineError extends ValidationError {
  readonly destination: string;
  readonly asset: string;

  constructor(message: string, destination: string, asset: string, cause?: unknown) {
    super(message, cause);
    this.destination = destination;
    this.asset = asset;
    Object.setPrototypeOf(this, MissingTrustlineError.prototype);
  }
}

/** The destination requires a memo (SEP-29 `config.memo_required`) and none was given. */
export class MemoRequiredError extends ValidationError {
  readonly destination: string;

  constructor(message: string, destination: string, cause?: unknown) {
    super(message, cause);
    this.destination = destination;
    Object.setPrototypeOf(this, MemoRequiredError.prototype);
  }
}

function getErrorType(error: unknown): ErrorType {
  if (error instanceof StructuredError) {
    return error.errorType;
  }
  return ErrorType.UnknownError;
}

export { getErrorType };

const SENSITIVE_CAUSE_KEYS = new Set(['secretKey', 'privateKey', 'seed', '_secretKey']);

/**
 * Recursively strips keys that may carry Stellar signing material (secretKey,
 * privateKey, seed, _secretKey) from an error cause before it is attached to
 * a thrown error, so it can't be exfiltrated via JSON-serialised logs/webhooks.
 */
export function sanitizeCause(cause: unknown): unknown {
  if (Array.isArray(cause)) {
    return cause.map(sanitizeCause);
  }
  if (cause !== null && typeof cause === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cause)) {
      if (SENSITIVE_CAUSE_KEYS.has(key)) continue;
      sanitized[key] = sanitizeCause(value);
    }
    return sanitized;
  }
  return cause;
}
