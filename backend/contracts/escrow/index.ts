/**
 * backend/contracts/escrow/index.ts
 *
 * Typed client for the PayFi escrow contract (`contracts/escrow/src/lib.rs`).
 *
 * The backend talks to Soroban through `soroban_invoke` payloads, which take a
 * free-form method name and a positional `xdr.ScVal[]`. A typo in the method
 * name or a missing / mis-typed argument only surfaced at simulation time.
 * This module pins every escrow entry point to a typed builder so those
 * mistakes become compile errors instead:
 *
 * ```ts
 * // Build a soroban_invoke payload
 * await agent.run({
 *   type: 'soroban_invoke',
 *   payload: { contractId, ...escrowCall.release({ arbiter }), simulateOnly: false },
 * });
 *
 * // Or drive a SorobanInvokeTool directly
 * const escrow = new EscrowClient(contractId, new SorobanInvokeTool(arbiterSigner));
 * await escrow.release({ arbiter });
 * ```
 *
 * `ESCROW_METHODS` is checked against the official Stellar CLI bindings
 * (`stellar contract bindings typescript`) by
 * `scripts/generate_escrow_bindings.sh`, which runs in CI, so the contract and
 * this client cannot drift apart silently.
 */

import { nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { SorobanInvokeResult } from '../../tools/SorobanInvokeTool';

// ─── Contract surface ─────────────────────────────────────────────────────────

/** Every public function exported by the escrow contract. */
export const ESCROW_METHODS = [
  'initialize',
  'initialize_with_fee',
  'get_fee_config',
  'release',
  'refund',
  'get_state',
  'release_partial',
  'cancel',
  'release_by_depositor',
  'refund_by_recipient',
  'propose_new_arbiter',
  'accept_arbiter_rotation',
] as const;

export type EscrowMethod = (typeof ESCROW_METHODS)[number];

/** Mirrors `EscrowError` in the contract (`Error(Contract, #n)` on-chain). */
export enum EscrowErrorCode {
  AlreadyInitialized = 1,
  AlreadyReleased = 2,
  NotExpired = 3,
  NotArbiter = 4,
  NotDepositor = 5,
  InvalidAmount = 6,
  InvalidExpiry = 7,
  NotInitialized = 8,
  InvalidParties = 9,
  RotationLocked = 10,
  NoPendingRotation = 11,
  InvalidFee = 12,
  NotRecipient = 13,
}

/** Mirrors `MAX_FEE_BPS` in the contract (10%). */
export const ESCROW_MAX_FEE_BPS = 1_000;

// ─── Argument types ───────────────────────────────────────────────────────────

/** A Stellar account (`G…`) or contract (`C…`) address. */
export type StellarAddress = string;

export interface InitializeArgs {
  depositor: StellarAddress;
  recipient: StellarAddress;
  arbiter: StellarAddress;
  /** SAC token contract address. */
  token: StellarAddress;
  /** Amount in the token's base units (stroops for XLM). */
  amount: bigint;
  /** Unix timestamp (seconds) after which the depositor may refund. */
  expiry: bigint;
}

export interface InitializeWithFeeArgs extends InitializeArgs {
  /** Platform fee in basis points, `0..=ESCROW_MAX_FEE_BPS`. */
  feeBps: number;
  feeRecipient: StellarAddress;
}

export interface ArbiterArgs {
  arbiter: StellarAddress;
}

export interface DepositorArgs {
  depositor: StellarAddress;
}

export interface RecipientArgs {
  recipient: StellarAddress;
}

export interface ReleasePartialArgs extends ArbiterArgs {
  releaseAmount: bigint;
}

export interface CancelArgs extends DepositorArgs, ArbiterArgs {}

export interface ProposeArbiterArgs extends DepositorArgs {
  newArbiter: StellarAddress;
}

export interface EscrowState {
  depositor: StellarAddress;
  recipient: StellarAddress;
  arbiter: StellarAddress;
  token: StellarAddress;
  amount: bigint;
  expiry: bigint;
  released: boolean;
  initializedAt: bigint;
}

export interface FeeConfig {
  feeBps: number;
  feeRecipient: StellarAddress | null;
}

/** A method name plus its encoded arguments — spreads into a `soroban_invoke` payload. */
export interface EscrowCall<M extends EscrowMethod = EscrowMethod> {
  method: M;
  args: xdr.ScVal[];
}

// ─── Encoders ─────────────────────────────────────────────────────────────────

const address = (value: StellarAddress): xdr.ScVal => nativeToScVal(value, { type: 'address' });
const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: 'i128' });
const u64 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: 'u64' });
const u32 = (value: number): xdr.ScVal => nativeToScVal(value, { type: 'u32' });

function initializeArgs(a: InitializeArgs): xdr.ScVal[] {
  return [
    address(a.depositor),
    address(a.recipient),
    address(a.arbiter),
    address(a.token),
    i128(a.amount),
    u64(a.expiry),
  ];
}

/**
 * Typed builders for every escrow entry point. Argument order matches the
 * contract signature exactly; `satisfies` guarantees one builder per method in
 * {@link ESCROW_METHODS}.
 */
export const escrowCall = {
  initialize: (a: InitializeArgs): EscrowCall<'initialize'> => ({
    method: 'initialize',
    args: initializeArgs(a),
  }),

  initialize_with_fee: (a: InitializeWithFeeArgs): EscrowCall<'initialize_with_fee'> => {
    if (!Number.isInteger(a.feeBps) || a.feeBps < 0 || a.feeBps > ESCROW_MAX_FEE_BPS) {
      throw new RangeError(
        `feeBps must be an integer between 0 and ${ESCROW_MAX_FEE_BPS}, got ${a.feeBps}`
      );
    }
    return {
      method: 'initialize_with_fee',
      args: [...initializeArgs(a), u32(a.feeBps), address(a.feeRecipient)],
    };
  },

  get_fee_config: (): EscrowCall<'get_fee_config'> => ({ method: 'get_fee_config', args: [] }),

  release: (a: ArbiterArgs): EscrowCall<'release'> => ({
    method: 'release',
    args: [address(a.arbiter)],
  }),

  refund: (a: DepositorArgs): EscrowCall<'refund'> => ({
    method: 'refund',
    args: [address(a.depositor)],
  }),

  get_state: (): EscrowCall<'get_state'> => ({ method: 'get_state', args: [] }),

  release_partial: (a: ReleasePartialArgs): EscrowCall<'release_partial'> => ({
    method: 'release_partial',
    args: [address(a.arbiter), i128(a.releaseAmount)],
  }),

  cancel: (a: CancelArgs): EscrowCall<'cancel'> => ({
    method: 'cancel',
    args: [address(a.depositor), address(a.arbiter)],
  }),

  release_by_depositor: (a: DepositorArgs): EscrowCall<'release_by_depositor'> => ({
    method: 'release_by_depositor',
    args: [address(a.depositor)],
  }),

  refund_by_recipient: (a: RecipientArgs): EscrowCall<'refund_by_recipient'> => ({
    method: 'refund_by_recipient',
    args: [address(a.recipient)],
  }),

  propose_new_arbiter: (a: ProposeArbiterArgs): EscrowCall<'propose_new_arbiter'> => ({
    method: 'propose_new_arbiter',
    args: [address(a.depositor), address(a.newArbiter)],
  }),

  accept_arbiter_rotation: (): EscrowCall<'accept_arbiter_rotation'> => ({
    method: 'accept_arbiter_rotation',
    args: [],
  }),
} satisfies { [M in EscrowMethod]: (...args: never[]) => EscrowCall<M> };

// ─── Decoders ─────────────────────────────────────────────────────────────────

/** Decode the `EscrowState` struct returned by `get_state`. */
export function decodeEscrowState(value: xdr.ScVal): EscrowState {
  const raw = scValToNative(value) as Record<string, unknown>;
  return {
    depositor: String(raw.depositor),
    recipient: String(raw.recipient),
    arbiter: String(raw.arbiter),
    token: String(raw.token),
    amount: BigInt(raw.amount as bigint),
    expiry: BigInt(raw.expiry as bigint),
    released: Boolean(raw.released),
    initializedAt: BigInt(raw.initialized_at as bigint),
  };
}

/** Decode the `(fee_bps, Option<fee_recipient>)` tuple returned by `get_fee_config`. */
export function decodeFeeConfig(value: xdr.ScVal): FeeConfig {
  const [feeBps, feeRecipient] = scValToNative(value) as [number, string | null | undefined];
  return { feeBps: Number(feeBps), feeRecipient: feeRecipient ?? null };
}

// ─── Client ───────────────────────────────────────────────────────────────────

/** Anything that executes a `soroban_invoke` input — e.g. `SorobanInvokeTool`. */
export interface SorobanInvoker {
  execute(input: unknown): Promise<SorobanInvokeResult>;
}

export interface EscrowInvokeOptions {
  /** Simulate only, never broadcast. Defaults to `false`. */
  simulateOnly?: boolean;
}

/**
 * Typed wrapper around a {@link SorobanInvoker} bound to one escrow instance.
 * The invoker's signer is the party authorising the call (depositor, arbiter
 * or recipient), so construct one client per signing party.
 */
export class EscrowClient {
  readonly contractId: string;
  private readonly invoker: SorobanInvoker;

  constructor(contractId: string, invoker: SorobanInvoker) {
    this.contractId = contractId;
    this.invoker = invoker;
  }

  /** Execute a pre-built {@link EscrowCall} against this contract. */
  invoke(call: EscrowCall, options: EscrowInvokeOptions = {}): Promise<SorobanInvokeResult> {
    return this.invoker.execute({
      contractId: this.contractId,
      method: call.method,
      args: call.args,
      simulateOnly: options.simulateOnly ?? false,
    });
  }

  initialize(a: InitializeArgs, options?: EscrowInvokeOptions): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.initialize(a), options);
  }

  initializeWithFee(
    a: InitializeWithFeeArgs,
    options?: EscrowInvokeOptions
  ): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.initialize_with_fee(a), options);
  }

  release(a: ArbiterArgs, options?: EscrowInvokeOptions): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.release(a), options);
  }

  releasePartial(
    a: ReleasePartialArgs,
    options?: EscrowInvokeOptions
  ): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.release_partial(a), options);
  }

  releaseByDepositor(
    a: DepositorArgs,
    options?: EscrowInvokeOptions
  ): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.release_by_depositor(a), options);
  }

  refund(a: DepositorArgs, options?: EscrowInvokeOptions): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.refund(a), options);
  }

  refundByRecipient(a: RecipientArgs, options?: EscrowInvokeOptions): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.refund_by_recipient(a), options);
  }

  cancel(a: CancelArgs, options?: EscrowInvokeOptions): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.cancel(a), options);
  }

  proposeNewArbiter(
    a: ProposeArbiterArgs,
    options?: EscrowInvokeOptions
  ): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.propose_new_arbiter(a), options);
  }

  acceptArbiterRotation(options?: EscrowInvokeOptions): Promise<SorobanInvokeResult> {
    return this.invoke(escrowCall.accept_arbiter_rotation(), options);
  }
}
