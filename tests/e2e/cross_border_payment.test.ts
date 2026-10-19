/**
 * tests/e2e/cross_border_payment.test.ts
 *
 * End-to-end test: SEP-31 cross-border payment against the SDF test anchor
 * (testanchor.stellar.org) on testnet (#784).
 *
 * Runs the whole tool against the live anchor: SEP-1 discovery, SEP-10 auth,
 * SEP-31 /info, SEP-12 KYC registration for sender and receiver, a SEP-38 firm
 * quote, SEP-31 transaction creation, and the on-chain payment with the
 * anchor's memo.
 *
 * The test anchor's SEP-31 `/info` does not always list receivable assets; when
 * it does not list ASSET_CODE the test is skipped with that reason rather than
 * failing on the anchor's configuration.
 *
 * Run with:  RUN_E2E=true npm run test:e2e
 *
 * Prerequisites:
 *   - AGENT_SECRET_KEY for a funded testnet account that trusts and holds at
 *     least AMOUNT of the test anchor's USDC (E2E_SEP31_ASSET_* to override)
 *   - STELLAR_NETWORK=testnet
 *   - Network access to testanchor.stellar.org and Horizon testnet
 */

import { describe, it, expect } from 'vitest';
import { CrossBorderPaymentTool } from '../../backend/tools/CrossBorderPaymentTool';

const ANCHOR_DOMAIN = process.env.E2E_SEP31_ANCHOR ?? 'testanchor.stellar.org';
const ASSET_CODE = process.env.E2E_SEP31_ASSET_CODE ?? 'USDC';
const ASSET_ISSUER =
  process.env.E2E_SEP31_ASSET_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const AMOUNT = '10';

describe.skipIf(!process.env.RUN_E2E)('SEP-31 cross-border payment E2E — test anchor', () => {
  it('registers KYC, quotes, creates the transaction and pays the anchor', async (ctx) => {
    const info = (await (await fetch(`https://${ANCHOR_DOMAIN}/sep31/info`)).json()) as {
      receive?: Record<string, unknown>;
    };
    if (!info.receive?.[ASSET_CODE]) {
      ctx.skip(`${ANCHOR_DOMAIN} SEP-31 /info does not currently receive ${ASSET_CODE}`);
    }

    const result = await new CrossBorderPaymentTool().execute({
      anchorDomain: ANCHOR_DOMAIN,
      amount: AMOUNT,
      assetCode: ASSET_CODE,
      assetIssuer: ASSET_ISSUER,
      destinationAsset: 'iso4217:USD',
      sender: {
        kyc: { first_name: 'Ada', last_name: 'Lovelace', email_address: 'ada@example.com' },
      },
      receiver: {
        kyc: {
          first_name: 'Grace',
          last_name: 'Hopper',
          email_address: 'grace@example.com',
          bank_account_number: '123456789',
          bank_number: '021000021',
        },
      },
    });

    expect(result.transactionId).toBeTruthy();
    expect(result.senderId).not.toBe(result.receiverId);
    expect(result.quote?.sellAmount).toBe(AMOUNT);
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);

    const tx = (await (
      await fetch(`https://horizon-testnet.stellar.org/transactions/${result.txHash}`)
    ).json()) as { successful: boolean; memo?: string };
    expect(tx.successful).toBe(true);
  }, 120_000);
});
