/**
 * scripts/examples/multisig_payment.ts
 *
 * Demonstrates a `multisig_payment` task — build an M-of-N multi-signature payment
 * for high-value PayFi operations. This example shows the two-phase workflow:
 * 1. Dispatch with empty signatures to get the unsigned XDR
 * 2. Attach external signatures and re-dispatch to submit
 *
 * Usage:
 *   npx ts-node scripts/examples/multisig_payment.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 */

import * as dotenv from "dotenv";
dotenv.config();

import { PayFiAgent } from "../../backend/agent";

const agent = new PayFiAgent();

// Phase 1: Dispatch without signatures to get unsigned XDR
console.log("Phase 1: Building unsigned multisig transaction...\n");

const phase1Result = await agent.run({
  type: "multisig_payment",
  payload: {
    destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    amount: "10.0000000",
    assetCode: "XLM",
    memo: "multisig example",
    additionalSigners: [
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", // signer 1
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", // signer 2
    ],
    minSignatures: 2,
    signatures: [], // No signatures yet
  },
});

console.log("Phase 1 Result:");
console.log(JSON.stringify(phase1Result, null, 2));

if (!phase1Result.success || !phase1Result.data?.unsignedXDR) {
  console.error("\nFailed to build multisig transaction");
  agent.destroy();
  process.exit(1);
}

const unsignedXDR = phase1Result.data.unsignedXDR;
console.log("\nUnsigned XDR (would be sent to external signers for collection):");
console.log(unsignedXDR.substring(0, 100) + "...\n");

// Phase 2: Simulate re-dispatch with collected signatures
// In production, you would:
// 1. Share `unsignedXDR` with external signers
// 2. Collect their signatures (typically via an external process)
// 3. Attach signatures and re-dispatch
//
// For this example, we skip phase 2 since it requires external signers.
// Simulate-only dispatch shows the flow without broadcasting:

console.log("Phase 2: (In production) Re-dispatch with collected signatures to submit");
console.log("         For this testnet example, the unsigned XDR has been generated.");
console.log("         To submit, collect signatures from the additionalSigners and");
console.log("         dispatch with signatures: [sig1, sig2, ...]\n");

// Phase 2 example (commented out — requires real signatures):
/*
const phase2Result = await agent.run({
  type: "multisig_payment",
  payload: {
    destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    amount: "10.0000000",
    assetCode: "XLM",
    memo: "multisig example",
    additionalSigners: [...],
    minSignatures: 2,
    signatures: [
      "external_signer_1_signature_xdr",
      "external_signer_2_signature_xdr",
    ],
  },
});

console.log("Phase 2 Result:");
console.log(JSON.stringify(phase2Result, null, 2));
*/

console.log("Multisig payment workflow complete!");
agent.destroy();
