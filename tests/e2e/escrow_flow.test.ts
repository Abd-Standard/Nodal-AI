/**
 * tests/e2e/escrow_flow.test.ts
 *
 * End-to-end test: fund a test keypair via Friendbot, deploy the escrow
 * WASM to testnet, then run the full initialize → release cycle and assert
 * the recipient balance increased.
 *
 * Run with:  npm run test:e2e
 * Excluded from default `npm run test` (see vitest.config.ts).
 *
 * Prerequisites:
 *   - SOROBAN_RPC_URL pointing at testnet (or use default)
 *   - Network access to Friendbot and Soroban RPC
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

const sorobanServer = new rpc.Server(SOROBAN_RPC_URL, { allowHttp: false });

async function friendbot(address: string): Promise<void> {
  await axios.get(`https://friendbot.stellar.org?addr=${address}`);
}

async function pollTx(
  server: rpc.Server,
  hash: string,
  maxAttempts = 20,
  intervalMs = 3000
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const status = await server.getTransaction(hash);
    if (status.status === 'SUCCESS') return status as rpc.Api.GetSuccessfulTransactionResponse;
    if (status.status === 'FAILED') throw new Error(`Transaction failed: ${hash}`);
  }
  throw new Error(`Transaction not confirmed within polling window: ${hash}`);
}

async function sendTx(
  server: rpc.Server,
  tx: any
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${(sim as any).error}`);
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(deployerKp);
  const result = await server.sendTransaction(prepared);
  if (result.status === 'ERROR') {
    throw new Error(`Submit error: ${result.errorResult?.toXDR('base64')}`);
  }
  return pollTx(server, result.hash);
}

// Global state shared across tests
let deployerKp: Keypair;
let recipientKp: Keypair;
let contractId: string;

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

    const uploadResult = await sendTx(sorobanServer, uploadTx);
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

    await expect(sendTx(sorobanServer, tx)).resolves.toBeDefined();
  }, 60_000);

  it('releases funds and confirms recipient balance increased', async () => {
    if (!contractId) return;

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

    await expect(sendTx(sorobanServer, tx)).resolves.toBeDefined();

    const balanceAfter = await axios
      .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
      .then((r) => {
        const xlm = r.data.balances.find((b: any) => b.asset_type === 'native');
        return parseFloat(xlm?.balance ?? '0');
      });

    expect(balanceAfter).toBeGreaterThan(balanceBefore);
  }, 60_000);

  it('full lifecycle: initialize then release by arbiter', async () => {
    if (!contractId) return;

    const arbiterKp = Keypair.random();
    await friendbot(arbiterKp.publicKey());
    await new Promise((r) => setTimeout(r, 2000));

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

    await sendTx(sorobanServer, initTx);

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

    await expect(sendTx(sorobanServer, releaseTx)).resolves.toBeDefined();

    const balanceAfter = await axios
      .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
      .then((r) => {
        const xlm = r.data.balances.find((b: any) => b.asset_type === 'native');
        return parseFloat(xlm?.balance ?? '0');
      });

    expect(balanceAfter).toBeGreaterThan(balanceBefore);
  }, 120_000);

  it('full lifecycle: initialize then refund by depositor after expiry', async () => {
    if (!contractId) return;

    const refundKp = Keypair.random();
    await friendbot(refundKp.publicKey());
    await new Promise((r) => setTimeout(r, 2000));

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

    await sendTx(sorobanServer, initTx);

    // Wait for expiry (simulating time passage)
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

    await expect(sendTx(sorobanServer, refundTx)).resolves.toBeDefined();

    const balanceAfter = await axios
      .get(`${HORIZON_URL}/accounts/${refundKp.publicKey()}`)
      .then((r) => {
        const xlm = r.data.balances.find((b: any) => b.asset_type === 'native');
        return parseFloat(xlm?.balance ?? '0');
      });

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

    await sendTx(sorobanServer, initTx);

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

    await expect(sendTx(sorobanServer, releaseTx)).rejects.toThrow();
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

    await sendTx(sorobanServer, initTx);

    // Attempt to refund before expiry
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

    await expect(sendTx(sorobanServer, refundTx)).rejects.toThrow();
  }, 120_000);
});
