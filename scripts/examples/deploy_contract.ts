/**
 * scripts/examples/deploy_contract.ts
 *
 * Demonstrates a `soroban_deploy` task — upload WASM bytecode and instantiate
 * a new Soroban smart contract.
 *
 * Usage:
 *   npx ts-node scripts/examples/deploy_contract.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, SOROBAN_RPC_URL
 *
 * Optional .env vars:
 *   CONTRACT_WASM_PATH - Path to a compiled contract WASM (see .env.example).
 *     If unset, a placeholder WASM header is used instead, which the network
 *     WILL reject. Build a real contract first:
 *       cargo build --manifest-path contracts/escrow/Cargo.toml \
 *         --target wasm32-unknown-unknown --release
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import { PayFiAgent } from '../../backend/agent';

async function main() {
  const wasmPath = process.env.CONTRACT_WASM_PATH;
  let wasm: Buffer;

  if (wasmPath) {
    if (!fs.existsSync(wasmPath)) {
      console.error(`Error: no WASM file found at CONTRACT_WASM_PATH="${wasmPath}"`);
      process.exit(1);
    }
    wasm = fs.readFileSync(wasmPath);
  } else {
    console.warn('⚠️  WARNING: CONTRACT_WASM_PATH is not set — using a placeholder WASM.');
    console.warn('   This is only the 8-byte WASM header (no module body) and the network');
    console.warn('   WILL reject it. The resulting deploy failure is expected, not a bug.');
    console.warn('   For a real deploy, build the escrow contract and set CONTRACT_WASM_PATH:');
    console.warn('     cargo build --manifest-path contracts/escrow/Cargo.toml \\');
    console.warn('       --target wasm32-unknown-unknown --release');
    // Placeholder WASM binary header (\0asm followed by version 1) — NOT deployable.
    wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  }

  const agent = new PayFiAgent();

  const result = await agent.run({
    type: 'soroban_deploy',
    payload: {
      action: 'deploy',
      wasm,
    },
  });

  console.log(JSON.stringify(result, null, 2));
  agent.destroy();
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
