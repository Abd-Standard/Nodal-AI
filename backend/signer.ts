/**
 * backend/signer.ts
 *
 * Signing abstraction handed to tools in place of the raw agent secret.
 *
 * Tools only ever see a `Signer`: they can ask for the public key and have
 * transactions / Soroban auth entries signed, but never read the secret key.
 * This keeps the secret out of every tool instance and lets KMS/HSM or SEP-43
 * wallet signers be plugged in by implementing the same interface.
 */

import {
  authorizeEntry,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  xdr,
} from '@stellar/stellar-sdk';
import { config } from './config';

export interface Signer {
  /** G-address of the signing account. */
  publicKey(): string;
  /** Adds this signer's signature to the transaction in place. */
  signTransaction(tx: Transaction | FeeBumpTransaction): void;
  /** Returns a copy of the Soroban authorization entry signed by this signer. */
  signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
    validUntilLedgerSeq: number,
    networkPassphrase?: string
  ): Promise<xdr.SorobanAuthorizationEntry>;
}

/**
 * Signer backed by a Stellar `Keypair`. Accepts either a Keypair or a getter so
 * the agent signer can resolve `config.agentKeypair()` on demand instead of
 * holding its own copy.
 */
export class KeypairSigner implements Signer {
  private readonly getKeypair: () => Keypair;

  constructor(keypair: Keypair | (() => Keypair)) {
    this.getKeypair = typeof keypair === 'function' ? keypair : () => keypair;
  }

  publicKey(): string {
    return this.getKeypair().publicKey();
  }

  signTransaction(tx: Transaction | FeeBumpTransaction): void {
    tx.sign(this.getKeypair());
  }

  signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
    validUntilLedgerSeq: number,
    networkPassphrase?: string
  ): Promise<xdr.SorobanAuthorizationEntry> {
    return authorizeEntry(entry, this.getKeypair(), validUntilLedgerSeq, networkPassphrase);
  }
}

/** Signer for the configured agent account. Resolves the keypair from config on each use. */
export function createAgentSigner(): Signer {
  return new KeypairSigner(() => config.agentKeypair());
}
