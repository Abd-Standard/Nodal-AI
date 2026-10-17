/**
 * backend/signers/LocalSigner.ts
 *
 * Signer backed by an in-memory Keypair (AGENT_SECRET_KEY or the key fetched
 * from AWS Secrets Manager). This is the default `SIGNER_BACKEND=local`.
 */

import { Keypair } from '@stellar/stellar-sdk';
import type { Signer } from './Signer';

export class LocalSigner implements Signer {
  readonly backend = 'local' as const;
  private readonly keypair: Keypair;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  async publicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async sign(data: Buffer): Promise<Buffer> {
    return this.keypair.sign(data);
  }
}
