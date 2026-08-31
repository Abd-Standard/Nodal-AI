/**
 * tests/soroban_invoke.test.ts
 *
 * Comprehensive test suite for SorobanInvokeTool.
 * Covers: simulation gate, happy path, ERROR/FAILED status handling,
 * polling timeout, invalid inputs, and dry-run mode.
 *
 * ## Mock Architecture
 *
 * This suite uses vi.mock() at the module level to mock two critical dependencies:
 *
 * 1. **rpcClient**: The RPC abstraction layer that communicates with Horizon and Soroban.
 *    - Allows us to test SorobanInvokeTool in complete isolation from network calls.
 *    - Each test configures the mock's return values to simulate different network scenarios
 *      (SUCCESS, FAILED, NOT_FOUND, ERROR statuses, timeouts, etc.).
 *    - The mock is cleared before each test via vi.clearAllMocks() (from vitest.config.ts).
 *
 * 2. **config**: The environment configuration (network URLs, agent keypair, thresholds).
 *    - Mocked to return predictable, test-friendly values.
 *    - Prevents the test from requiring actual environment variables or .env files.
 *
 * ## Why isolate: true Matters Here
 *
 * With vitest.config.ts set to isolate: true, each test file gets its own V8 context:
 * - Mock definitions (vi.mock()) apply only to this test file.
 * - Other test files can mock the same modules differently without interference.
 * - Global state (vi.clearAllMocks(), test instance) is not shared between files.
 *
 * Example: If balance_check.test.ts also mocks rpcClient, it won't affect this file's mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  SorobanInvokeTool,
  SorobanInvokeInputSchema,
  SOROBAN_TX_TIMEOUT,
} from '../backend/tools/SorobanInvokeTool';
import * as rpcClient from '../backend/rpc_client';
import { ContractError } from '../backend/errors';
import { spendingTracker } from '../backend/spending_tracker';

// ─── Module mock ──────────────────────────────────────────────────────────────
/**
 * Mock the rpc_client module to intercept all calls to Horizon and Soroban RPC.
 *
 * Each function (loadAccount, prepareSorobanTx, etc.) is mocked with vi.fn(),
 * allowing tests to define return values or rejection behavior on a per-test basis.
 *
 * The sorobanServer object contains sendTransaction and getTransaction, which are
 * critical for the polling mechanism that confirms transaction settlement.
 */

vi.mock('../backend/rpc_client', async () => {
  const { Networks } = await import('@stellar/stellar-sdk');
  return {
    loadAccount: vi.fn(),
    submitTransaction: vi.fn(),
    simulateSorobanTx: vi.fn(),
    prepareSorobanTx: vi.fn(),
    prepareSorobanTxWithEvents: vi.fn(),
    resolveNetworkPassphrase: (_network: string) => Networks.TESTNET,
    horizonServer: {},
    sorobanServer: {
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    },
  };
});

// The tool records simulated SAC transfers into the shared spending window.
// Mock the singleton so assertions stay in-process and no real DB is touched.
vi.mock('../backend/spending_tracker', () => ({
  spendingTracker: {
    record: vi.fn(),
    total: vi.fn(() => 0),
    clear: vi.fn(),
  },
}));

vi.mock('../backend/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../backend/utils/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  generateCorrelationId: vi.fn(() => 'mock-correlation-id'),
}));

/**
 * Mock the config module to provide a predictable environment.
 *
 * In real use, config.ts reads from process.env or .env files.
 * Here, we statically return test credentials and thresholds.
 *
 * Note: The AGENT_SECRET_KEY is a Stellar secret key used in tests only.
 * It is never used in actual signed transactions in this test suite
 * because all RPC calls are mocked.
 */

// Mutable knobs for the spending-limit tests: the tool reads these at call
// time, so expose them as getters over a hoisted state object.
const { configState } = vi.hoisted(() => ({
  configState: { STELLAR_NETWORK: 'testnet', AGENT_SPENDING_LIMIT: '100' },
}));

vi.mock('../backend/config', () => {
  const { Keypair } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      get STELLAR_NETWORK() {
        return configState.STELLAR_NETWORK;
      },
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_SECRET_KEY: secret,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      get AGENT_SPENDING_LIMIT() {
        return configState.AGENT_SPENDING_LIMIT;
      },
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      MAX_X402_PAYMENTS_PER_MINUTE: 10,
      MAX_SOROBAN_FEE_STROOPS: 1_000_000,
    },
    MAINNET_SPENDING_CAP: 10_000,
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────
/**
 * Test fixtures: reusable constants and helper functions.
 */

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const VALID_CONTRACT = 'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH';

/**
 * makeMockAccount(publicKey): Constructs a mock Stellar account object.
 *
 * SorobanInvokeTool calls rpcClient.loadAccount() to fetch the agent's
 * current account details from Horizon. This mock account satisfies
 * that interface without hitting the network.
 *
 * Fields like sequenceNumber, thresholds, and signers are required
 * by the Stellar SDK's transaction building logic.
 */
function makeMockAccount(publicKey: string) {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
    },
    balances: [],
    signers: [],
    data_attr: {},
    subentry_count: 0,
  };
}

/**
 * Creates a mock prepared transaction that satisfies the post-sign signature guard.
 * sign() mutates `signatures` in place (matching real Stellar SDK behaviour).
 */
function makeMockPreparedTx(): any {
  const obj: any = {
    signatures: [],
    timeBounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
    fee: "100",
  };
function makeMockPreparedTx(fee = 500_000): any {
  const obj: any = { signatures: [], fee, timeBounds: {} };
  obj.sign = vi.fn().mockImplementation(() => {
    obj.signatures.push({ hint: () => Buffer.alloc(4), signature: () => Buffer.alloc(64) });
  });
  return obj;
}

/**
 * Build a real `xdr.DiagnosticEvent` shaped like a Stellar Asset Contract
 * value-out event (transfer / transfer_from / burn) so the tool's simulated-
 * event extraction is exercised against genuine XDR.
 *
 * Topic layout mirrors the SAC token interface:
 * - transfer:       [Symbol("transfer"), from, to]
 * - transfer_from:  [Symbol("transfer_from"), from, to, spender]
 * - burn:           [Symbol("burn"), from]
 * with the amount as an i128 in the event data.
 */
function makeSacTransferEvent(opts: {
  name: 'transfer' | 'transfer_from' | 'burn';
  from: string;
  to?: string;
  spender?: string;
  amount: bigint;
  successful?: boolean;
}): xdr.DiagnosticEvent {
  const topics = [nativeToScVal(opts.name, { type: 'symbol' })];
  topics.push(nativeToScVal(opts.from, { type: 'address' }));
  if (opts.to) topics.push(nativeToScVal(opts.to, { type: 'address' }));
  if (opts.spender) topics.push(nativeToScVal(opts.spender, { type: 'address' }));

  const v0 = new xdr.ContractEventV0({
    topics,
    data: nativeToScVal(opts.amount, { type: 'i128' }),
  });
  // js-xdr unions have no typed constructor in the shipped .d.ts, so the
  // (switchValue, armValue) constructor needs an explicit cast.
  const BodyCtor = xdr.ContractEventBody as unknown as new (
    switchValue: number,
    value: xdr.ContractEventV0
  ) => xdr.ContractEventBody;
  const ExtCtor = xdr.ExtensionPoint as unknown as new (switchValue: number) => xdr.ExtensionPoint;

  const contractEvent = new xdr.ContractEvent({
    ext: new ExtCtor(0),
    contractId: Buffer.alloc(32),
    type: xdr.ContractEventType.diagnostic(),
    body: new BodyCtor(0, v0),
  });
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: opts.successful ?? true,
    event: contractEvent,
  });
}

/** Mock the simulation gate to return a prepared tx plus the given events. */
function mockPreparedWithEvents(events: xdr.DiagnosticEvent[] = []): void {
  vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
    tx: makeMockPreparedTx(),
    events,
  } as any);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SorobanInvokeTool', () => {
  let tool: SorobanInvokeTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new SorobanInvokeTool();
  });

  // ── Timeout constant validation ────────────────────────────────────────────

  it('SOROBAN_TX_TIMEOUT is within valid range [1, 300]', () => {
    expect(SOROBAN_TX_TIMEOUT).toBeGreaterThan(0);
    expect(SOROBAN_TX_TIMEOUT).toBeLessThanOrEqual(300);
  });

  // ── Input validation ────────────────────────────────────────────────────────
  /**
   * Input validation tests: ensure SorobanInvokeTool rejects malformed inputs
   * before any network call is attempted.
   *
   * These are fast unit tests that don't need mocked RPC calls since they
   * reject at the parameter validation layer.
   */

  describe('Input validation', () => {
    it('rejects a contractId that is too short', async () => {
      await expect(
        tool.execute({ contractId: 'bad_id', method: 'release', args: [] })
      ).rejects.toThrow(/Invalid Stellar contract ID/);
    });

    it('rejects a contractId that is too long (57 chars)', async () => {
      await expect(
        tool.execute({
          contractId: 'C'.padEnd(57, 'A'),
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(/Invalid Stellar contract ID/);
    });

    it('rejects an empty method name', async () => {
      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: '', args: [] })
      ).rejects.toThrow();
    });

    it('rejects missing contractId', async () => {
      await expect(tool.execute({ method: 'release', args: [] })).rejects.toThrow();
    });
  });

  // ── Simulation gate (mandatory) ─────────────────────────────────────────────
  /**
   * Simulation gate tests: the core safety mechanism of SorobanInvokeTool.
   *
   * Every Soroban invocation must first run through prepareSorobanTx(), which
   * performs a dry-run simulation on the Soroban RPC server. Only if the
   * simulation succeeds (no errors) does the transaction proceed to broadcast.
   *
   * This prevents:
   * - Submitting transactions that will fail on-chain (wasting fees).
   * - Executing unauthorized contract calls or insufficient balance scenarios.
   * - Introducing bad state in the contract due to failed side effects.
   *
   * Tests here verify:
   * 1. prepareSorobanTx is ALWAYS called before submission.
   * 2. If simulation fails, submission is SKIPPED and an error is thrown.
   * 3. Dry-run mode (simulateOnly=true) runs the simulation but skips broadcast.
   */

  describe('Simulation gate', () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5') as any
      );
    });

    it('calls prepareSorobanTx before any submission', async () => {
      mockPreparedWithEvents();
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'sim_test_hash',
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: 'SUCCESS',
      });

      await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
      });

      expect(rpcClient.prepareSorobanTxWithEvents).toHaveBeenCalledOnce();
    });

    it('throws and does NOT submit when simulation fails', async () => {
      vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockRejectedValue(
        new Error('Soroban simulation failed: insufficient balance')
      );

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(/simulation failed/);

      expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('throws when simulation fails with contract error code', async () => {
      vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockRejectedValue(
        new Error('Soroban simulation failed: Error(Contract, #3)')
      );

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(/simulation failed/);
    });

    it('preserves simulation error detail in ContractError message when simulation fails', async () => {
      const errorDetail = 'HostError: Error(Contract, #123) custom_revert_reason';
      vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockRejectedValue(
        new ContractError(`Soroban simulation failed: ${errorDetail}`, undefined, errorDetail)
      );

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(`Soroban simulation failed: ${errorDetail}`);
    });

    it('throws when Soroban fee exceeds MAX_SOROBAN_FEE_STROOPS', async () => {
      vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
        tx: { sign: vi.fn(), fee: 2_000_000 } as any,
        events: [],
      } as any);

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(/Soroban fee.*exceeds MAX_SOROBAN_FEE_STROOPS/);

      expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects when the prepared fee is not numeric', async () => {
      vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
        tx: { sign: vi.fn(), fee: 'not-a-number' } as any,
        events: [],
      } as any);

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(/invalid Soroban fee/i);

      expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('allows execution when Soroban fee is within MAX_SOROBAN_FEE_STROOPS', async () => {
      vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
        tx: makeMockPreparedTx(500_000),
        events: [],
      } as any);
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'fee_within_cap_hash',
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: 'SUCCESS',
      });

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
      });
      expect(result.txHash).toBe('fee_within_cap_hash');
    });

    it('does NOT call sendTransaction when simulateOnly=true', async () => {
      const mockPreparedTx = { sign: vi.fn() };
      vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
        tx: mockPreparedTx as any,
        events: [],
      } as any);

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
        simulateOnly: true,
      });

      expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
      // Discriminated union: simulationResult must be present, txHash must be absent
      expect(result.simulationResult).toBeDefined();
      expect(result.simulationResult).toBe(mockPreparedTx);
      expect(result.txHash).toBeUndefined();
    });
  });

  // ── Submission and confirmation polling ─────────────────────────────────────
  /**
   * Submission and confirmation polling tests: verify transaction lifecycle after
   * a successful simulation.
   *
   * After prepareSorobanTx succeeds, the transaction envelope is signed and
   * submitted to sorobanServer.sendTransaction(). The submission returns a
   * PENDING status and a txHash. SorobanInvokeTool then polls sorobanServer.getTransaction()
   * repeatedly until the transaction reaches a terminal state (SUCCESS, FAILED, ERROR).
   *
   * Tests here cover:
   * 1. Happy path: immediate confirmation on the first poll.
   * 2. Retries: transaction confirmed after multiple NOT_FOUND polls.
   * 3. Failure: on-chain FAILED or ERROR statuses are caught and re-thrown.
   * 4. Timeout: polling window exhausted without reaching a terminal state.
   *
   * The polling interval and retry count are defined in config (RETRY_DELAY_MS).
   */

  describe('Submission and confirmation polling', () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5') as any
      );
      mockPreparedWithEvents();
    });

    it('returns txHash after a successful confirmation on first poll', async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'confirmed_hash',
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: 'SUCCESS',
      });

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
      });

      expect(result.txHash).toBe('confirmed_hash');
    });

    it('polls multiple times before SUCCESS', async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'slow_confirm_hash',
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any)
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockResolvedValueOnce({ status: 'SUCCESS' });

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
      });

      expect(result.txHash).toBe('slow_confirm_hash');
      expect(rpcClient.sorobanServer.getTransaction).toHaveBeenCalledTimes(3);
    });

    it('throws when on-chain status is FAILED', async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'failed_on_chain_hash',
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: 'FAILED',
      });

      let error: Error | undefined;
      try {
        await tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        });
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/failed on-chain/);
      expect(error!.message).toContain('failed_on_chain_hash');
    });

    it('throws when sendTransaction returns ERROR status', async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'ERROR',
        errorResult: { toXDR: () => 'base64_error_xdr' },
        hash: 'error_hash',
      });

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(/Soroban submit failed/);
    });

    it('throws when polling window is exhausted (timeout)', async () => {
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'never_confirms_hash',
      });
      // Always return NOT_FOUND — simulates a stalled transaction
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: 'NOT_FOUND',
      });

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(/not confirmed within polling window/);
    }, 5_000); // RETRY_DELAY_MS=100 → intervalMs=200ms × 10 attempts ≈ 2s
  });

  // ── Network error handling ──────────────────────────────────────────────────
  /**
   * Network error handling tests: ensure SorobanInvokeTool gracefully surfaces
   * network-level failures.
   *
   * These tests mock network errors (timeouts, 404s) at various points in the
   * call chain (account load, simulation, submission) and verify that they
   * propagate to the caller without being swallowed or retried indefinitely.
   *
   * This is important for user code to distinguish between:
   * - Transient network glitches (worth retrying at the application level).
   * - Permanent errors like "account not found" (require manual intervention).
   */

  describe('Network error handling', () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5') as any
      );
    });

    it('propagates network timeout on prepareSorobanTx', async () => {
      vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockRejectedValue(
        new Error('ECONNABORTED: network timeout')
      );

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(/timeout/);
    });

    it('propagates account load failure', async () => {
      vi.mocked(rpcClient.loadAccount).mockRejectedValue(
        new Error('Horizon: account not found (404)')
      );

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow(/not found/);
    });
  });

  // ── Signature assertion (issue #99) ────────────────────────────────────────
  /**
   * Post-sign guard: verifies that the transaction has at least one signature
   * before submission. A no-op sign() call (e.g., mutated Keypair behaviour
   * in a future SDK version) would cause an empty signatures array, which the
   * Stellar network rejects immediately. The guard catches this early.
   */

  describe('Post-sign signature assertion', () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5') as any
      );
    });

    it("throws 'Transaction signing produced no signatures' when sign() is a no-op", async () => {
      // Mock prepareSorobanTx to return a transaction whose sign() does nothing,
      // leaving the signatures array empty. timeBounds is set so the time-bounds
      // guard passes and the signature guard fires.
      vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue({
        sign: vi.fn(), // no-op — does NOT push to signatures
        signatures: [], // empty signatures list — guard must catch this
        timeBounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
        fee: "100",
      // leaving the signatures array empty.
      vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
        tx: {
          sign: vi.fn(), // no-op — does NOT push to signatures
          signatures: [], // empty signatures list — guard must catch this
          fee: 500_000,
          timeBounds: {},
        } as any,
        events: [],
      } as any);

      await expect(
        tool.execute({
          contractId: VALID_CONTRACT,
          method: 'release',
          args: [],
        })
      ).rejects.toThrow('Transaction signing produced no signatures');

      // sendTransaction must NOT have been called when signing failed
      expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('submits successfully when sign() populates signatures', async () => {
      // Use makeMockPreparedTx so sign() adds a signature entry
      mockPreparedWithEvents();

      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'signed_ok_hash',
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: 'SUCCESS',
      });

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
      });

      expect(result.txHash).toBe('signed_ok_hash');
    });
  });

  describe('args validation', () => {
    it('rejects plain JavaScript object in args array', () => {
      const result = SorobanInvokeInputSchema.safeParse({
        contractId: VALID_CONTRACT,
        method: 'test',
        args: [{}],
      });
      expect(result.success).toBe(false);
    });

    it('accepts xdr.ScVal instance from nativeToScVal', () => {
      const scVal = nativeToScVal(42, { type: 'u32' });
      const result = SorobanInvokeInputSchema.safeParse({
        contractId: VALID_CONTRACT,
        method: 'test',
        args: [scVal],
      });
      expect(result.success).toBe(true);
      expect(result.data?.args).toHaveLength(1);
    });

    it('rejects null args', () => {
      const result = SorobanInvokeInputSchema.safeParse({
        contractId: VALID_CONTRACT,
        method: 'test',
        args: null,
      });
      expect(result.success).toBe(false);
    });

    it('accepts empty args array as default', () => {
      const result = SorobanInvokeInputSchema.safeParse({
        contractId: VALID_CONTRACT,
        method: 'test',
      });
      expect(result.success).toBe(true);
      expect(result.data?.args).toEqual([]);
    });

    it('accepts multiple xdr.ScVal instances', () => {
      const arg1 = nativeToScVal(100n, { type: 'i128' });
      // Use a real 56-char G-address; "GABC" is not a valid Stellar address
      const arg2 = nativeToScVal('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', {
        type: 'address',
      });
      const result = SorobanInvokeInputSchema.safeParse({
        contractId: VALID_CONTRACT,
        method: 'test',
        args: [arg1, arg2],
      });
      expect(result.success).toBe(true);
      expect(result.data?.args).toHaveLength(2);
    });
  });

  // ── Spending-limit guard on simulated internal SAC transfers ─────────────
  /**
   * A contract invocation can move funds internally via the Stellar Asset
   * Contract (transfer / transfer_from / burn). Those moves are only visible
   * after the mandatory simulation, so the spending cap is enforced against
   * the simulated diagnostic events: reject over-limit invocations before
   * broadcast, and record within-limit spends into the cumulative window.
   */
  describe('Spending-limit guard on simulated SAC transfers', () => {
    // The tool debits `this.keypair.publicKey()`, which derives from the mocked
    // TEST_SECRET — so AGENT must be that derived key, not a literal.
    const AGENT = Keypair.fromSecret(TEST_SECRET).publicKey();
    const OTHER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

    beforeEach(() => {
      configState.STELLAR_NETWORK = 'testnet';
      configState.AGENT_SPENDING_LIMIT = '100';
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(AGENT) as any);
    });

    it('rejects and does not broadcast when simulated SAC transfers exceed AGENT_SPENDING_LIMIT', async () => {
      mockPreparedWithEvents([
        // 2,000,000,000 raw units = 200.0000000 > limit 100
        makeSacTransferEvent({ name: 'transfer', from: AGENT, to: OTHER, amount: 2_000_000_000n }),
      ]);

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: 'release', args: [] })
      ).rejects.toThrow(/exceeds AGENT_SPENDING_LIMIT/);

      expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('sums multiple SAC transfers before applying the limit', async () => {
      mockPreparedWithEvents([
        makeSacTransferEvent({ name: 'transfer', from: AGENT, to: OTHER, amount: 600_000_000n }), // 60.0000000
        makeSacTransferEvent({
          name: 'transfer_from',
          from: AGENT,
          to: OTHER,
          spender: OTHER,
          amount: 500_000_000n, // 50.0000000 — 60 + 50 = 110 > 100
        }),
      ]);

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: 'release', args: [] })
      ).rejects.toThrow(/exceeds AGENT_SPENDING_LIMIT/);
    });

    it('accepts and records to the spending tracker when within the limit', async () => {
      mockPreparedWithEvents([
        makeSacTransferEvent({ name: 'transfer', from: AGENT, to: OTHER, amount: 400_000_000n }), // 40.0000000
      ]);
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'spend_ok_hash',
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: 'SUCCESS',
      });

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
      });
      expect(result.txHash).toBe('spend_ok_hash');
      expect(spendingTracker.record).toHaveBeenCalledWith('40.0000000');
    });

    it('counts burn events that debit the agent toward the cap', async () => {
      mockPreparedWithEvents([
        makeSacTransferEvent({ name: 'burn', from: AGENT, amount: 400_000_000n }), // 40.0000000
      ]);
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'burn_hash',
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: 'SUCCESS',
      });

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
      });
      expect(result.txHash).toBe('burn_hash');
      expect(spendingTracker.record).toHaveBeenCalledWith('40.0000000');
    });

    it('ignores events that do not debit the agent (incoming / third-party transfers)', async () => {
      mockPreparedWithEvents([
        // Incoming and third-party transfers must not consume the agent's cap.
        makeSacTransferEvent({ name: 'transfer', from: OTHER, to: AGENT, amount: 9_000_000_000n }),
        makeSacTransferEvent({ name: 'transfer', from: OTHER, to: OTHER, amount: 9_000_000_000n }),
      ]);
      vi.mocked(rpcClient.sorobanServer.sendTransaction as any).mockResolvedValue({
        status: 'PENDING',
        hash: 'incoming_hash',
      });
      vi.mocked(rpcClient.sorobanServer.getTransaction as any).mockResolvedValue({
        status: 'SUCCESS',
      });

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
      });
      expect(result.txHash).toBe('incoming_hash');
      expect(spendingTracker.record).not.toHaveBeenCalled();
    });

    it('enforces the mainnet spending cap on mainnet', async () => {
      configState.STELLAR_NETWORK = 'mainnet';
      configState.AGENT_SPENDING_LIMIT = '999999'; // only the mainnet cap should trip
      mockPreparedWithEvents([
        // 200,000.0000000 > MAINNET_SPENDING_CAP (10,000)
        makeSacTransferEvent({
          name: 'transfer',
          from: AGENT,
          to: OTHER,
          amount: 2_000_000_000_000n,
        }),
      ]);

      await expect(
        tool.execute({ contractId: VALID_CONTRACT, method: 'release', args: [] })
      ).rejects.toThrow(/mainnet spending cap/);

      expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('does not record spending for simulateOnly dry-runs', async () => {
      mockPreparedWithEvents([
        makeSacTransferEvent({ name: 'transfer', from: AGENT, to: OTHER, amount: 400_000_000n }),
      ]);

      const result = await tool.execute({
        contractId: VALID_CONTRACT,
        method: 'release',
        args: [],
        simulateOnly: true,
      });

      expect(result.simulationResult).toBeDefined();
      expect(spendingTracker.record).not.toHaveBeenCalled();
    });
  });
});
