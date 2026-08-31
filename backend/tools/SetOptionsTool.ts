/**
 * backend/tools/SetOptionsTool.ts
 * Manage account flags, thresholds, and home domain via SET_OPTIONS.
 */

import { Keypair, TransactionBuilder, Operation, BASE_FEE } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { loadAccount, submitTransaction, resolveNetworkPassphrase } from '../rpc_client';
import { SubmitResultSchema } from './StellarPaymentTool';

export const SetOptionsInputSchema = z.object({
  homeDomain: z.string().max(32).optional(),
  masterWeight: z.number().int().min(0).max(255).optional(),
  lowThreshold: z.number().int().min(0).max(255).optional(),
  medThreshold: z.number().int().min(0).max(255).optional(),
  highThreshold: z.number().int().min(0).max(255).optional(),
  setFlags: z.number().int().optional(),
  clearFlags: z.number().int().optional(),
});

export type SetOptionsInput = z.infer<typeof SetOptionsInputSchema>;

export class SetOptionsTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
    const input = SetOptionsInputSchema.parse(rawInput);
    const account = await loadAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.setOptions({
          ...(input.homeDomain !== undefined ? { homeDomain: input.homeDomain } : {}),
          ...(input.masterWeight !== undefined ? { masterWeight: input.masterWeight } : {}),
          ...(input.lowThreshold !== undefined ? { lowThreshold: input.lowThreshold } : {}),
          ...(input.medThreshold !== undefined ? { medThreshold: input.medThreshold } : {}),
          ...(input.highThreshold !== undefined ? { highThreshold: input.highThreshold } : {}),
          ...(input.setFlags !== undefined ? { setFlags: input.setFlags } : {}),
          ...(input.clearFlags !== undefined ? { clearFlags: input.clearFlags } : {}),
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(this.keypair);
    const result = SubmitResultSchema.parse(await submitTransaction(tx));
    return { txHash: result.hash, ledger: result.ledger };
  }
}
