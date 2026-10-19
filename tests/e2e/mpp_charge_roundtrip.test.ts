/**
 * tests/e2e/mpp_charge_roundtrip.test.ts
 *
 * End-to-end test: MPP Charge round trip against Stellar testnet (#777).
 *
 * A local resource server plays the seller half of MPP Charge: it answers 402
 * with a `stellar`/`charge` challenge for 0.1 XLM paid through the native XLM
 * Stellar Asset Contract, broadcasts the signed transfer it receives in the
 * credential to Soroban testnet, and serves the resource with a
 * `Payment-Receipt`. The agent's `MppChargeClient` drives the client half; the
 * test then confirms the recipient's balance rose on Horizon.
 *
 * Run with:  RUN_E2E=true npm run test:e2e
 * Excluded from default `npm run test` (see vitest.config.ts).
 *
 * Prerequisites:
 *   - AGENT_SECRET_KEY (and related config) set for a funded testnet account
 *   - STELLAR_NETWORK=testnet
 *   - Network access to Friendbot, Horizon and Soroban RPC testnet
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  NotFoundError,
  Transaction,
  rpc,
} from '@stellar/stellar-sdk';
import * as http from 'http';
import type { AddressInfo } from 'net';
import axios from 'axios';
import { MppChargeClient } from '../../backend/payments/mpp';

const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const AMOUNT_BASE_UNITS = '1000000'; // 0.1 XLM

const horizon = new Horizon.Server(HORIZON_URL);
const soroban = new rpc.Server(SOROBAN_RPC_URL);

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function nativeBalance(account: string): Promise<number> {
  const loaded = await horizon.loadAccount(account);
  return parseFloat(loaded.balances.find((b) => b.asset_type === 'native')!.balance);
}

/**
 * Broadcast a signed transaction and wait for it to land. Confirmation is read
 * from Horizon: this SDK version cannot decode the TransactionMeta that Soroban
 * RPC's getTransaction returns on current testnet.
 */
async function settle(xdrB64: string): Promise<string> {
  const tx = new Transaction(xdrB64, Networks.TESTNET);
  const sent = await soroban.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`sendTransaction failed: ${sent.status}`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const record = await horizon.transactions().transaction(sent.hash).call();
      if (record.successful) return sent.hash;
      throw new Error(`transaction ${sent.hash} failed`);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err; // not ingested yet
    }
  }
  throw new Error(`transaction ${sent.hash} not confirmed`);
}

describe.skipIf(!process.env.RUN_E2E)('MPP Charge round trip E2E — testnet', () => {
  let recipient: Keypair;

  beforeAll(async () => {
    recipient = Keypair.random();
    await axios.get(`https://friendbot.stellar.org?addr=${recipient.publicKey()}`);
    await new Promise((r) => setTimeout(r, 5000)); // let Horizon index the account
  }, 60_000);

  it('pays a 402 charge challenge on-chain and receives the resource', async () => {
    const request = {
      amount: AMOUNT_BASE_UNITS,
      currency: XLM_SAC,
      recipient: recipient.publicKey(),
      methodDetails: { network: 'stellar:testnet', credentialTypes: ['transaction'] },
    };
    const challenge = {
      id: `e2e-${Date.now()}`,
      realm: 'mpp-e2e.local',
      method: 'stellar',
      intent: 'charge',
      request: b64url(request),
      expires: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    const wwwAuthenticate =
      'Payment ' +
      Object.entries(challenge)
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ');

    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Payment ')) {
        res.writeHead(402, { 'WWW-Authenticate': wwwAuthenticate });
        res.end();
        return;
      }
      const credential = JSON.parse(Buffer.from(auth.slice(8), 'base64url').toString('utf8'));
      if (credential.challenge.id !== challenge.id || credential.payload.type !== 'transaction') {
        res.writeHead(402, { 'WWW-Authenticate': wwwAuthenticate });
        res.end();
        return;
      }
      settle(credential.payload.transaction)
        .then((hash) => {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Payment-Receipt': b64url({
              method: 'stellar',
              reference: hash,
              status: 'success',
              timestamp: new Date().toISOString(),
            }),
          });
          res.end(JSON.stringify({ data: 'paid content' }));
        })
        .catch((err: unknown) => {
          res.writeHead(402, { 'WWW-Authenticate': wwwAuthenticate });
          res.end(String(err));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      const before = await nativeBalance(recipient.publicKey());
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/data`;

      const { response, payment } = await new MppChargeClient().fetch(url);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: 'paid content' });
      expect(payment?.protocol).toBe('mpp-charge');
      expect(payment?.amount).toBe('0.1000000');
      expect(payment?.reference).toMatch(/^[0-9a-f]{64}$/);

      const after = await nativeBalance(recipient.publicKey());
      expect(after - before).toBeCloseTo(0.1, 7);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});
