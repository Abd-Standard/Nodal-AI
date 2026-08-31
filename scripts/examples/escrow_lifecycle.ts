/**
 * scripts/examples/escrow_lifecycle.ts
 *
 * Demonstrates the full escrow contract lifecycle end-to-end on testnet:
 *   1. Deploy the escrow WASM (`soroban_deploy`, action "deploy").
 *   2. Initialize the contract, locking 5 XLM (depositor = this agent).
 *   3. Register a `ContractEventListener` that watches for the contract's
 *      `("escrow", "released")` event.
 *   4. Trigger `release` signed by a dedicated arbiter keypair — not the
 *      depositor — matching the contract's `NotArbiter` authorization guard.
 *   5. Wait for the listener to observe the release event and log a
 *      confirmation once it fires.
 *
 * `PayFiAgent` always signs Soroban invocations with the single
 * `AGENT_SECRET_KEY` it was constructed with (see `backend/agent.ts`), so it
 * plays the depositor here. The arbiter call is made with a standalone
 * `SorobanInvokeTool` instance constructed with the arbiter's own secret key —
 * the same "importable directly" pattern the README documents for
 * `BalanceCheckTool` / `SorobanQueryTool`.
 *
 * Usage:
 *   npx ts-node scripts/examples/escrow_lifecycle.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 *   CONTRACT_WASM_PATH - Path to the compiled escrow WASM (see .env.example)
 *
 * This script funds two fresh testnet keypairs (arbiter, recipient) via
 * Friendbot, so it only works against `testnet` or `futurenet` — it refuses
 * to run on `mainnet`.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import { Asset, Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { PayFiAgent } from '../../backend/agent';
import { SorobanInvokeTool } from '../../backend/tools/SorobanInvokeTool';
import { FriendBotTool } from '../../backend/tools/FriendBotTool';
import { config } from '../../backend/config';
import { resolveNetworkPassphrase } from '../../backend/rpc_client';

// Amount locked in the escrow, in XLM's 7-decimal stroop units (5 XLM).
const ESCROW_AMOUNT_STROOPS = 50_000_000n;

// How long the escrow stays active before the depositor could reclaim it.
const EXPIRY_WINDOW_SECONDS = 3600;

// How long to wait for the release event to arrive over the poll-based listener.
const EVENT_WAIT_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  if (config.STELLAR_NETWORK === 'mainnet') {
    console.error('Refusing to run: this example funds throwaway keypairs via Friendbot,');
    console.error('which only exists on testnet/futurenet. Set STELLAR_NETWORK accordingly.');
    process.exit(1);
  }

  const wasmPath = process.env.CONTRACT_WASM_PATH;
  if (!wasmPath) {
    console.error('Error: CONTRACT_WASM_PATH environment variable is required');
    console.error('See .env.example — build the contract first:');
    console.error('  cargo build --manifest-path contracts/escrow/Cargo.toml \\');
    console.error('    --target wasm32-unknown-unknown --release');
    process.exit(1);
  }
  if (!fs.existsSync(wasmPath)) {
    console.error(`Error: no WASM file found at CONTRACT_WASM_PATH="${wasmPath}"`);
    process.exit(1);
  }

  const friendbot = new FriendBotTool();
  const agent = new PayFiAgent(); // acts as the depositor

  // Recipient and arbiter are fresh, disposable keypairs for this demo run —
  // in production these would be the real counterparty's long-lived keys.
  const recipientKeypair = Keypair.random();
  const arbiterKeypair = Keypair.random();

  console.log('Funding recipient and arbiter testnet accounts via Friendbot...');
  await Promise.all([
    friendbot.execute({ publicKey: recipientKeypair.publicKey() }),
    friendbot.execute({ publicKey: arbiterKeypair.publicKey() }),
  ]);

  try {
    // ── 1. Deploy ──────────────────────────────────────────────────────────
    console.log('\nStep 1: Deploying escrow WASM to testnet...');
    const wasm = fs.readFileSync(wasmPath);
    const deployResult = await agent.run({
      type: 'soroban_deploy',
      payload: { action: 'deploy', wasm },
    });

    if (!deployResult.success) {
      throw new Error(`Deploy failed: ${deployResult.error}`);
    }
    const { contractId } = deployResult.data as { contractId: string; wasmHash: string };
    console.log(`Deployed. Contract ID: ${contractId}`);

    // ── 2. Initialize — lock 5 XLM ────────────────────────────────────────
    console.log('\nStep 2: Initializing escrow with 5 XLM funding...');
    const networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
    const nativeTokenContractId = Asset.native().contractId(networkPassphrase);
    const expiry = Math.floor(Date.now() / 1000) + EXPIRY_WINDOW_SECONDS;

    const initResult = await agent.run({
      type: 'soroban_invoke',
      payload: {
        contractId,
        method: 'initialize',
        args: [
          nativeToScVal(config.AGENT_PUBLIC_KEY, { type: 'address' }), // depositor
          nativeToScVal(recipientKeypair.publicKey(), { type: 'address' }),
          nativeToScVal(arbiterKeypair.publicKey(), { type: 'address' }),
          nativeToScVal(nativeTokenContractId, { type: 'address' }),
          nativeToScVal(ESCROW_AMOUNT_STROOPS, { type: 'i128' }),
          nativeToScVal(BigInt(expiry), { type: 'u64' }),
        ],
        simulateOnly: false,
      },
    });

    if (!initResult.success) {
      throw new Error(`Initialize failed: ${initResult.error}`);
    }
    console.log('Escrow initialized — 5 XLM locked, awaiting arbiter release.');

    // ── 3. Listen for the release event ───────────────────────────────────
    console.log('\nStep 3: Registering ContractEventListener for release events...');
    const released = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.stopContractListener();
        reject(new Error(`Timed out waiting for release event after ${EVENT_WAIT_TIMEOUT_MS}ms`));
      }, EVENT_WAIT_TIMEOUT_MS);

      // Matches on the "released" topic emitted by EscrowContract::release()
      // (`env.events().publish((Symbol("escrow"), Symbol("released")), ...)`).
      agent.startContractListener(contractId, ['released'], (event) => {
        clearTimeout(timer);
        console.log('✅ Release event received:', JSON.stringify(event, null, 2));
        agent.stopContractListener();
        resolve();
      });
    });

    // ── 4. Trigger release, signed by the arbiter ─────────────────────────
    console.log('\nStep 4: Triggering release, signed by the arbiter keypair...');
    // A standalone SorobanInvokeTool, keyed to the arbiter's own secret —
    // PayFiAgent's tools always sign with the agent's single configured key,
    // so the arbiter's call has to go through its own tool instance.
    const arbiterInvokeTool = new SorobanInvokeTool(arbiterKeypair.secret());
    const releaseResult = await arbiterInvokeTool.execute({
      contractId,
      method: 'release',
      args: [nativeToScVal(arbiterKeypair.publicKey(), { type: 'address' })],
      simulateOnly: false,
    });
    console.log('Release transaction submitted:', releaseResult);

    // ── 5. Confirm the listener observed the release ──────────────────────
    console.log('\nStep 5: Waiting for the release event to be observed...');
    await released;
    console.log('\nEscrow lifecycle complete: deployed → funded → released → confirmed.');
  } finally {
    agent.destroy();
  }
}

main().catch((err) => {
  console.error('\nEscrow lifecycle example failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
