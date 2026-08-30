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
 */

import * as dotenv from "dotenv";
dotenv.config();

import { PayFiAgent } from "../../backend/agent";

const agent = new PayFiAgent();

// Sample WASM binary header (\0asm followed by version 1)
const sampleWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const result = await agent.run({
  type: "soroban_deploy",
  payload: {
    action: "deploy",
    wasm: sampleWasm,
  },
});

console.log(JSON.stringify(result, null, 2));
agent.destroy();
