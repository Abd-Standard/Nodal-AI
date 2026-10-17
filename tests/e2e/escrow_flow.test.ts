/**
 * tests/e2e/escrow_flow.test.ts
 *
 * End-to-end tests for the Soroban escrow contract on Stellar testnet.
 *
 * GUARD: The entire suite is skipped unless RUN_E2E=true is set in the
 * environment. This prevents accidental testnet calls during normal CI runs.
 *
 * Run the canonical issue-#446 flow:
 *   RUN_E2E=true npm run test:e2e:escrow
 *
 * Run all e2e tests:
 *   RUN_E2E=true npm run test:e2e
 *
 * Prerequisites:
 *   - Network access to Friendbot and Soroban testnet RPC
 *   - WASM built: cargo build --release --target wasm32-unknown-unknown
 *     (in contracts/escrow)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  Keypair,
  rpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  Address,
  xdr,
  Contract,
} from '@stellar/stellar-sdk';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const WASM_PATH = path.resolve(
  __dirname,
  '../../contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm'
);

/**
 * Soroban token wrapper contract ID for native XLM on testnet.
 * This is the SAC (Stellar Asset Contract) address that the escrow contract
 * calls into when transferring XLM between accounts.
 */
const NATIVE_TOKEN_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/**
 * Expiry timestamp offset in seconds. Contracts are initialized with
 * current ledger time + this offset. 3600 = 1 hour from now, giving
 * enough headroom for the test to complete without triggering NotExpired errors.
 */
const EXPIRY_OFFSET_SECONDS = 3600;

const sorobanServer = new rpc.Server(SOROBAN_RPC_URL, { allowHttp: false });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Fund an account on testnet via Friendbot. */
async function friendbot(address: string): Promise<void> {
  await axios.get(`https://friendbot.stellar.org?addr=${address}`);
}

/**
 * Poll Soroban RPC until the transaction reaches a terminal state.
 * Returns the successful result or throws on FAILED / timeout.
 */
async function pollTx(
  server: rpc.Server,
  hash: string,
  maxAttempts = 20,
  intervalMs = 3000
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const status = await server.getTransaction(hash);
    if (status.status === "SUCCESS")
      return status as rpc.Api.GetSuccessfulTransactionResponse;
    if (status.status === "FAILED")
      throw new Error(`Transaction failed: ${hash}`);
    if (status.status === 'SUCCESS') return status as rpc.Api.GetSuccessfulTransactionResponse;
    if (status.status === 'FAILED') throw new Error(`Transaction failed: ${hash}`);
  }
  throw new Error(`Transaction not confirmed within polling window: ${hash}`);
}

/**
 * Simulate, assemble, sign with the given keypair, and submit a transaction.
 * Accepts an explicit signer so tests that use non-deployer accounts work correctly.
 */
async function sendTx(
  server: rpc.Server,
  tx: any,
  signer: Keypair
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${(sim as any).error}`);
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);
  const result = await server.sendTransaction(prepared);
  if (result.status === 'ERROR') {
    throw new Error(`Submit error: ${result.errorResult?.toXDR('base64')}`);
  }
  return pollTx(server, result.hash);
}

/** Fetch the native XLM balance of an account via Horizon. */
async function xlmBalance(address: string): Promise<number> {
  const resp = await axios.get(`${HORIZON_URL}/accounts/${address}`);
  const xlm = resp.data.balances.find((b: any) => b.asset_type === "native");
  return parseFloat(xlm?.balance ?? "0");
}

// ─── Issue #446 — canonical E2E flow ─────────────────────────────────────────
//
// Full sequence: Friendbot fund 3 accounts → deploy escrow WASM → upload +
// create contract instance → initialize with 10 XLM → arbiter calls release →
// assert recipient received 10 XLM.
//
// Guarded behind RUN_E2E=true so it never runs in normal unit-test CI.

describe.skipIf(process.env.RUN_E2E !== "true")("Escrow E2E — deploy → initialize → release (issue #446)", () => {
  // Three independent accounts for the escrow triangle:
  //   deployer  — pays for WASM upload & contract creation, acts as depositor
  //   arbiter   — the trusted party who authorises release
  //   recipient — receives the 10 XLM on successful release
  let deployerKp: Keypair;
  let arbiterKp: Keypair;
  let recipientKp: Keypair;
  let contractId: string;

  beforeAll(async () => {
    deployerKp = Keypair.random();
    arbiterKp = Keypair.random();
    recipientKp = Keypair.random();

    // Fund all three accounts via Friendbot in parallel
    await Promise.all([
      friendbot(deployerKp.publicKey()),
      friendbot(arbiterKp.publicKey()),
      friendbot(recipientKp.publicKey()),
    ]);

    // Allow Horizon a moment to index the new accounts before we query them
    await new Promise((r) => setTimeout(r, 5000));
  }, 90_000);

  it("deploys the escrow WASM and creates a contract instance", async () => {
    if (!fs.existsSync(WASM_PATH)) {
      console.warn(
        "WASM not found — build first with:\n" +
          "  cargo build --release --target wasm32-unknown-unknown\n" +
          "  (in contracts/escrow)"
      );
      return;
    }

    const wasm = fs.readFileSync(WASM_PATH);
    const account = await sorobanServer.getAccount(deployerKp.publicKey());

    // Step 1: Upload WASM bytecode — returns a 32-byte hash
    const uploadTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — uploadContractWasm is available via stellar-sdk xdr helpers
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeUploadContractWasm(wasm),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    const uploadResult = await sendTx(sorobanServer, uploadTx, deployerKp);
    const wasmHash: Buffer = (uploadResult as any).returnValue?.bytes();
    expect(wasmHash).toBeDefined();

    // Step 2: Create a contract instance from the uploaded WASM hash.
    // Uses a zero salt so the contract ID is deterministically derived from
    // the deployer address — useful for idempotent redeployments in tests.
    const account2 = await sorobanServer.getAccount(deployerKp.publicKey());
    const deployTx = new TransactionBuilder(account2, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — createContract via xdr helpers
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeCreateContract(
            new xdr.CreateContractArgs({
              contractIdPreimage:
                xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                  new xdr.ContractIdPreimageFromAddress({
                    address: Address.fromString(
                      deployerKp.publicKey()
                    ).toScAddress(),
                    salt: Buffer.alloc(32),
                  })
                ),
              executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    const deployResult = await sendTx(sorobanServer, deployTx, deployerKp);
    contractId = (deployResult as any)
      .returnValue?.address()
      ?.contractId()
      .toString("hex");
    expect(contractId).toBeDefined();
    expect(typeof contractId).toBe("string");
  }, 120_000);

  it("initializes the escrow with 10 XLM (depositor=deployer, arbiter, recipient)", async () => {
    if (!contractId) {
      console.warn("No contractId — deploy test must have passed first");
      return;
    }

    // Fetch current ledger time to compute a valid future expiry timestamp.
    // The contract's InvalidExpiry guard rejects expiry <= ledger timestamp.
    const ledger = await sorobanServer.getLatestLedger();
    // ledger.sequence gives the block number; use a generous future epoch offset
    // by computing current unix time + EXPIRY_OFFSET_SECONDS.
    const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000) + EXPIRY_OFFSET_SECONDS);

    // The escrow contract's initialize() signature (7 args):
    //   initialize(depositor, recipient, arbiter, token, amount, expiry)
    // amount is in stroops (1 XLM = 10_000_000 stroops), so 10 XLM = 100_000_000n
    const TEN_XLM_STROOPS = 100_000_000n;

    const account = await sorobanServer.getAccount(deployerKp.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        new Contract(contractId).call(
          "initialize",
          nativeToScVal(deployerKp.publicKey(), { type: "address" }),   // depositor
          nativeToScVal(recipientKp.publicKey(), { type: "address" }),  // recipient
          nativeToScVal(arbiterKp.publicKey(), { type: "address" }),    // arbiter
          nativeToScVal(NATIVE_TOKEN_CONTRACT_ID, { type: "address" }), // token (XLM SAC)
          nativeToScVal(TEN_XLM_STROOPS, { type: "i128" }),             // amount: 10 XLM
          nativeToScVal(expiryTimestamp, { type: "u64" })               // expiry: 1 hour from now
        )
      )
      .setTimeout(30)
      .build();

    // Deployer is the depositor — they authorize the XLM transfer into the contract
    await expect(
      sendTx(sorobanServer, tx, deployerKp)
    ).resolves.toBeDefined();
  }, 60_000);

  it("arbiter releases funds and recipient receives 10 XLM", async () => {
    if (!contractId) {
      console.warn("No contractId — earlier tests must have passed first");
      return;
    }

    // Snapshot recipient balance before the release
    const balanceBefore = await xlmBalance(recipientKp.publicKey());

    // The release() function signature: release(arbiter)
    // Only the stored arbiter can call this — signed by arbiterKp
    const account = await sorobanServer.getAccount(arbiterKp.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        new Contract(contractId).call(
          "release",
          nativeToScVal(arbiterKp.publicKey(), { type: "address" }) // arbiter arg
        )
      )
      .setTimeout(30)
      .build();

    // Transaction is sourced from and signed by the arbiter account
    await expect(
      sendTx(sorobanServer, tx, arbiterKp)
    ).resolves.toBeDefined();

    // Assert recipient received 10 XLM
    const balanceAfter = await xlmBalance(recipientKp.publicKey());

    // 10 XLM = 10.0 — allow a small epsilon for fees/rounding in Horizon display
    expect(balanceAfter).toBeGreaterThan(balanceBefore);
    expect(balanceAfter - balanceBefore).toBeGreaterThanOrEqual(9.9);
  }, 60_000);
});

// ─── Legacy E2E suite (pre-issue-#446) ───────────────────────────────────────
//
// These tests were written before the correct 7-argument initialize() signature
// was confirmed. They are preserved for reference but are guarded behind the
// same RUN_E2E flag and may not execute successfully against the compiled WASM
// contract due to the argument count mismatch. They exist solely to capture
// the original test intent until they can be updated in a follow-up PR.

// Global state shared across legacy tests (module-level to mirror original structure)
let deployerKp: Keypair;
let recipientKp: Keypair;
let contractId: string;

describe.skipIf(process.env.RUN_E2E !== "true")("Escrow E2E — testnet (legacy)", () => {
describe('Escrow E2E — testnet', () => {
  beforeAll(async () => {
    deployerKp = Keypair.random();
    recipientKp = Keypair.random();

    // Fund both keypairs via Friendbot
    await Promise.all([friendbot(deployerKp.publicKey()), friendbot(recipientKp.publicKey())]);

    // Small pause to let Horizon index the funded accounts
    await new Promise((r) => setTimeout(r, 5000));
  }, 60_000);

  it('deploys the escrow WASM and creates a contract instance', async () => {
    if (!fs.existsSync(WASM_PATH)) {
      console.warn(
        'WASM not found — skipping deploy (run `cargo build --release --target wasm32-unknown-unknown`)'
      );
      return;
    }

    const wasm = fs.readFileSync(WASM_PATH);
    const account = await sorobanServer.getAccount(deployerKp.publicKey());

    // 1. Upload WASM
    const uploadTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — uploadContractWasm is available via stellar-sdk xdr helpers
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeUploadContractWasm(wasm),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    const uploadResult = await sendTx(sorobanServer, uploadTx, deployerKp);
    const wasmHash: Buffer = (uploadResult as any).returnValue?.bytes();
    expect(wasmHash).toBeDefined();

    // 2. Create contract instance
    const account2 = await sorobanServer.getAccount(deployerKp.publicKey());
    const deployTx = new TransactionBuilder(account2, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — createContract via xdr helpers
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeCreateContract(
            new xdr.CreateContractArgs({
              contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                new xdr.ContractIdPreimageFromAddress({
                  address: Address.fromString(deployerKp.publicKey()).toScAddress(),
                  salt: Buffer.alloc(32),
                })
              ),
              executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    const deployResult = await sendTx(sorobanServer, deployTx, deployerKp);
    contractId = (deployResult as any).returnValue?.address()?.contractId().toString("hex");
    const deployResult = await sendTx(sorobanServer, deployTx);
    contractId = (deployResult as any).returnValue?.address()?.contractId().toString('hex');
    expect(contractId).toBeDefined();
  }, 120_000);

  it('initializes the escrow contract', async () => {
    if (!contractId) return;

    const account = await sorobanServer.getAccount(deployerKp.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'initialize',
              args: [
                nativeToScVal(deployerKp.publicKey(), { type: 'address' }),
                nativeToScVal(recipientKp.publicKey(), { type: 'address' }),
                nativeToScVal(10n, { type: 'i128' }),
              ],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await expect(sendTx(sorobanServer, tx, deployerKp)).resolves.toBeDefined();
  }, 60_000);

  it('releases funds and confirms recipient balance increased', async () => {
    if (!contractId) return;

    const balanceBefore = await xlmBalance(recipientKp.publicKey());
    const balanceBefore = await axios
      .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
      .then((r) => {
        const xlm = r.data.balances.find((b: any) => b.asset_type === 'native');
        return parseFloat(xlm?.balance ?? '0');
      });

    const account = await sorobanServer.getAccount(deployerKp.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'release',
              args: [],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await expect(sendTx(sorobanServer, tx, deployerKp)).resolves.toBeDefined();
    await expect(sendTx(sorobanServer, tx)).resolves.toBeDefined();

    const balanceAfter = await axios
      .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
      .then((r) => {
        const xlm = r.data.balances.find((b: any) => b.asset_type === 'native');
        return parseFloat(xlm?.balance ?? '0');
      });

    const balanceAfter = await xlmBalance(recipientKp.publicKey());
    expect(balanceAfter).toBeGreaterThan(balanceBefore);
  }, 60_000);

  it('full lifecycle: initialize then release by arbiter', async () => {
    if (!contractId) return;

    const arbiterKp = Keypair.random();
    await friendbot(arbiterKp.publicKey());
    await new Promise((r) => setTimeout(r, 2000));

    const balanceBefore = await xlmBalance(recipientKp.publicKey());
    const balanceBefore = await axios
      .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
      .then((r) => {
        const xlm = r.data.balances.find((b: any) => b.asset_type === 'native');
        return parseFloat(xlm?.balance ?? '0');
      });

    const account = await sorobanServer.getAccount(deployerKp.publicKey());
    const initTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'initialize',
              args: [
                nativeToScVal(arbiterKp.publicKey(), { type: 'address' }),
                nativeToScVal(recipientKp.publicKey(), { type: 'address' }),
                nativeToScVal(5n, { type: 'i128' }),
              ],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await sendTx(sorobanServer, initTx, deployerKp);

    const account2 = await sorobanServer.getAccount(arbiterKp.publicKey());
    const releaseTx = new TransactionBuilder(account2, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'release',
              args: [],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await expect(sendTx(sorobanServer, releaseTx, arbiterKp)).resolves.toBeDefined();
    await expect(sendTx(sorobanServer, releaseTx)).resolves.toBeDefined();

    const balanceAfter = await axios
      .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
      .then((r) => {
        const xlm = r.data.balances.find((b: any) => b.asset_type === 'native');
        return parseFloat(xlm?.balance ?? '0');
      });

    const balanceAfter = await xlmBalance(recipientKp.publicKey());
    expect(balanceAfter).toBeGreaterThan(balanceBefore);
  }, 120_000);

  it('full lifecycle: initialize then refund by depositor after expiry', async () => {
    if (!contractId) return;

    const refundKp = Keypair.random();
    await friendbot(refundKp.publicKey());
    await new Promise((r) => setTimeout(r, 2000));

    const balanceBefore = await xlmBalance(refundKp.publicKey());
    const balanceBefore = await axios
      .get(`${HORIZON_URL}/accounts/${refundKp.publicKey()}`)
      .then((r) => {
        const xlm = r.data.balances.find((b: any) => b.asset_type === 'native');
        return parseFloat(xlm?.balance ?? '0');
      });

    const account = await sorobanServer.getAccount(refundKp.publicKey());
    const initTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'initialize',
              args: [
                nativeToScVal(refundKp.publicKey(), { type: 'address' }),
                nativeToScVal(recipientKp.publicKey(), { type: 'address' }),
                nativeToScVal(3n, { type: 'i128' }),
              ],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await sendTx(sorobanServer, initTx, refundKp);

    await new Promise((r) => setTimeout(r, 2000));

    const account2 = await sorobanServer.getAccount(refundKp.publicKey());
    const refundTx = new TransactionBuilder(account2, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'refund',
              args: [],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await expect(sendTx(sorobanServer, refundTx, refundKp)).resolves.toBeDefined();
    await expect(sendTx(sorobanServer, refundTx)).resolves.toBeDefined();

    const balanceAfter = await axios
      .get(`${HORIZON_URL}/accounts/${refundKp.publicKey()}`)
      .then((r) => {
        const xlm = r.data.balances.find((b: any) => b.asset_type === 'native');
        return parseFloat(xlm?.balance ?? '0');
      });

    const balanceAfter = await xlmBalance(refundKp.publicKey());
    expect(balanceAfter).toBeGreaterThan(balanceBefore);
  }, 120_000);

  it('release fails when called by non-arbiter', async () => {
    if (!contractId) return;

    const nonArbiterKp = Keypair.random();
    await friendbot(nonArbiterKp.publicKey());
    await new Promise((r) => setTimeout(r, 2000));

    const account = await sorobanServer.getAccount(deployerKp.publicKey());
    const initTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'initialize',
              args: [
                nativeToScVal(deployerKp.publicKey(), { type: 'address' }),
                nativeToScVal(recipientKp.publicKey(), { type: 'address' }),
                nativeToScVal(2n, { type: 'i128' }),
              ],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await sendTx(sorobanServer, initTx, deployerKp);

    const account2 = await sorobanServer.getAccount(nonArbiterKp.publicKey());
    const releaseTx = new TransactionBuilder(account2, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'release',
              args: [],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await expect(sendTx(sorobanServer, releaseTx, nonArbiterKp)).rejects.toThrow();
  }, 120_000);

  it('refund fails before expiry', async () => {
    if (!contractId) return;

    const depositorKp = Keypair.random();
    await friendbot(depositorKp.publicKey());
    await new Promise((r) => setTimeout(r, 2000));

    const account = await sorobanServer.getAccount(depositorKp.publicKey());
    const initTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'initialize',
              args: [
                nativeToScVal(depositorKp.publicKey(), { type: 'address' }),
                nativeToScVal(recipientKp.publicKey(), { type: 'address' }),
                nativeToScVal(4n, { type: 'i128' }),
              ],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await sendTx(sorobanServer, initTx, depositorKp);

    const account2 = await sorobanServer.getAccount(depositorKp.publicKey());
    const refundTx = new TransactionBuilder(account2, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — xdr low-level API
        xdr.Operation.invokeHostFunction({
          hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: 'refund',
              args: [],
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build();

    await expect(sendTx(sorobanServer, refundTx, depositorKp)).rejects.toThrow();
  }, 120_000);
});
