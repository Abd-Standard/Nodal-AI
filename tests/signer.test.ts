/**
 * tests/signer.test.ts
 * Tests for the Signer abstraction handed to tools instead of the agent secret (#740).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { KeypairSigner, createAgentSigner } from '../backend/signer';

const AGENT_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { Keypair } = require('@stellar/stellar-sdk');
  const keypair = Keypair.fromSecret('SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X');
  return { config: { agentKeypair: vi.fn(() => keypair) } };
});

function buildTx(source: string) {
  return new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: 'k', value: 'v' }))
    .setTimeout(30)
    .build();
}

describe('KeypairSigner', () => {
  const keypair = Keypair.random();

  it('exposes the public key of the wrapped keypair', () => {
    expect(new KeypairSigner(keypair).publicKey()).toBe(keypair.publicKey());
  });

  it('signs a transaction with the wrapped keypair', () => {
    const signer = new KeypairSigner(keypair);
    const tx = buildTx(keypair.publicKey());

    signer.signTransaction(tx);

    expect(tx.signatures).toHaveLength(1);
    expect(keypair.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
  });

  it('accepts a keypair getter and resolves it on each use', () => {
    const getter = vi.fn(() => keypair);
    const signer = new KeypairSigner(getter);
    expect(getter).not.toHaveBeenCalled();

    signer.publicKey();
    signer.publicKey();

    expect(getter).toHaveBeenCalledTimes(2);
  });

  it('does not expose the secret key as an enumerable property', () => {
    const signer = new KeypairSigner(keypair);
    expect(JSON.stringify(signer)).not.toContain(keypair.secret());
  });
});

describe('createAgentSigner', () => {
  it('signs as the configured agent account', () => {
    const agent = Keypair.fromSecret(AGENT_SECRET);
    const signer = createAgentSigner();
    const tx = buildTx(agent.publicKey());

    signer.signTransaction(tx);

    expect(signer.publicKey()).toBe(agent.publicKey());
    expect(agent.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
  });
});
