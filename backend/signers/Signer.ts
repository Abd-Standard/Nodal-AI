/**
 * backend/signers/Signer.ts
 *
 * Pluggable signing backend contract.
 *
 * A Signer produces Ed25519 signatures for the agent's account without the
 * caller needing to hold the secret key. Local signers wrap an in-memory
 * Keypair; remote signers delegate to a KMS/HSM so the key never leaves it.
 */

import { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk';

export type SignerBackend = 'local' | 'vault';

export interface Signer {
  /** Which backend produced this signer — safe to log. */
  readonly backend: SignerBackend;

  /** The Stellar G-address whose signatures this signer produces. */
  publicKey(): Promise<string>;

  /** Sign raw bytes with Ed25519 and return the 64-byte signature. */
  sign(data: Buffer): Promise<Buffer>;
}

/**
 * Sign a transaction with any {@link Signer}.
 *
 * Signs the transaction hash and attaches the decorated signature via
 * `addSignature`, which verifies it against the signer's public key — a
 * misconfigured remote key fails here rather than at submission.
 */
export async function signTransaction(
  signer: Signer,
  tx: Transaction | FeeBumpTransaction
): Promise<void> {
  const publicKey = await signer.publicKey();
  const signature = await signer.sign(tx.hash());
  tx.addSignature(publicKey, signature.toString('base64'));
}
