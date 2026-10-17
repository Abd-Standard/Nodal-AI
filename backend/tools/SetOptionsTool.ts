/**
 * backend/tools/SetOptionsTool.ts
 * Manage account flags, thresholds, and home domain via SET_OPTIONS.
 *
 * ## Irreversible operations — guarded
 *
 * Two SET_OPTIONS changes can permanently lock the agent out of its own
 * account, with no recovery path. Like the spending-limit guards in agent.ts,
 * this tool refuses them unless the caller explicitly opts in:
 *
 * - **`masterWeight: 0`** removes the master key's signing power. Unless the
 *   account's *other* ed25519 signers already carry enough combined weight to
 *   meet the high threshold (the new one if this call sets it, else the
 *   current one, and at least 1), nothing could ever sign for the account
 *   again. Such a request is rejected unless `confirmLockoutRisk: true` is
 *   passed. Pre-auth-tx and hash-x signers are not counted: they are
 *   single-use and cannot restore general control of the account.
 * - **`setFlags` including `AuthImmutableFlag` (0x4)** freezes the account's
 *   auth flags forever and prevents the account from ever being merged. It is
 *   rejected unless `confirmAuthImmutable: true` is passed.
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  AuthFlag,
  AuthImmutableFlag,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { ValidationError } from '../errors';
import { loadAccount, submitTransaction, resolveNetworkPassphrase } from '../rpc_client';
import { SubmitResultSchema } from './StellarPaymentTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';

export const SetOptionsInputSchema = z.object({
  homeDomain: z.string().max(32).optional(),
  masterWeight: z.number().int().min(0).max(255).optional(),
  lowThreshold: z.number().int().min(0).max(255).optional(),
  medThreshold: z.number().int().min(0).max(255).optional(),
  highThreshold: z.number().int().min(0).max(255).optional(),
  setFlags: z.number().int().optional(),
  clearFlags: z.number().int().optional(),
  /**
   * Explicitly accept that `masterWeight: 0` may permanently lock the account
   * because no other signer can meet the high threshold.
   */
  confirmLockoutRisk: z.boolean().optional(),
  /** Explicitly accept that setting `AuthImmutableFlag` can never be undone. */
  confirmAuthImmutable: z.boolean().optional(),
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
    const publicKey = this.keypair.publicKey();

    if (
      input.setFlags !== undefined &&
      (input.setFlags & AuthImmutableFlag) !== 0 &&
      input.confirmAuthImmutable !== true
    ) {
      throw new ValidationError(
        'Refusing to set AuthImmutableFlag: it is irreversible — the account can never change ' +
          'its auth flags or be merged again. Pass confirmAuthImmutable: true to proceed.'
      );
    }

    const removesMasterKey = input.masterWeight === 0;
    // The lockout check must see the account's current signers, not a cached copy.
    const account = await loadAccount(
      publicKey,
      removesMasterKey ? { forceRefresh: true } : undefined
    );

    if (removesMasterKey && input.confirmLockoutRisk !== true) {
      const otherSignerWeight = account.signers
        .filter((s) => s.key !== publicKey && s.type === 'ed25519_public_key')
        .reduce((sum, s) => sum + s.weight, 0);
      const requiredWeight = Math.max(input.highThreshold ?? account.thresholds.high_threshold, 1);

      if (otherSignerWeight < requiredWeight) {
        throw new ValidationError(
          `Refusing to set masterWeight to 0: the account's other signers have a combined ` +
            `weight of ${otherSignerWeight}, below the high threshold of ${requiredWeight}, so ` +
            `the account would be permanently locked. Add a sufficient signer first, or pass ` +
            `confirmLockoutRisk: true to proceed anyway.`
        );
      }
    }

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
          // setFlags/clearFlags are a bitmask combining one or more AuthFlag
          // bits (e.g. AuthRequiredFlag | AuthRevocableFlag); the SDK's type
          // only names the individual bits, so the combined value needs a cast.
          ...(input.setFlags !== undefined ? { setFlags: input.setFlags as AuthFlag } : {}),
          ...(input.clearFlags !== undefined ? { clearFlags: input.clearFlags as AuthFlag } : {}),
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    tx.sign(this.keypair);
    const result = SubmitResultSchema.parse(await submitTransaction(tx));
    return { txHash: result.hash, ledger: result.ledger };
  }
}
