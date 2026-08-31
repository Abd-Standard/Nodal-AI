/**
 * tests/stream.test.ts
 * Tests for PayFiAgent startListening / stopListening (#107)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoist mocks so factory closures can reference them ──────────────────────
const { mockStopStream, mockStream, mockForAccount, mockPayments } = vi.hoisted(() => {
  const mockStopStream = vi.fn();
  const mockStream = vi.fn(() => mockStopStream);
  const mockForAccount = vi.fn(() => ({ stream: mockStream }));
  const mockPayments = vi.fn(() => ({ forAccount: mockForAccount }));
  return { mockStopStream, mockStream, mockForAccount, mockPayments };
});

// ─── Mock tools ───────────────────────────────────────────────────────────────
vi.mock('../backend/tools/StellarPaymentTool', () => ({
  StellarPaymentTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SorobanInvokeTool', () => ({
  SorobanInvokeTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/X402PaymentTool', async () => {
  // Keep the real X402ChallengeSchema (agent.ts's stream handler validates
  // against it, issue #237) while mocking only the X402PaymentTool class.
  const actual = await vi.importActual<typeof import('../backend/tools/X402PaymentTool')>(
    '../backend/tools/X402PaymentTool'
  );
  return {
    ...actual,
    X402PaymentTool: vi.fn().mockImplementation(() => ({ respond: vi.fn() })),
  };
});
vi.mock('../backend/tools/AccountInfoTool', () => ({
  AccountInfoTool: vi.fn().mockImplementation(() => ({ fetch: vi.fn() })),
}));
vi.mock('../backend/tools/TrustlineTool', () => ({
  TrustlineTool: vi.fn().mockImplementation(() => ({ execute: vi.fn(), checkTrustline: vi.fn() })),
}));
vi.mock('../backend/tools/MultiSigPaymentTool', () => ({
  MultiSigPaymentTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/BatchPaymentTool', () => ({
  BatchPaymentTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  horizonServer: { payments: mockPayments },
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    AGENT_SPENDING_LIMIT: '100',
    agentKeypair: () => ({
      secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
    }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

vi.mock('../backend/persistence', () => ({
  saveResult: vi.fn(),
}));

import { PayFiAgent } from '../backend/agent';
import { logger } from '../backend/logger';

describe('PayFiAgent — stream (issue #107)', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup default return since clearAllMocks resets implementations
    mockStream.mockReturnValue(mockStopStream);
    mockForAccount.mockReturnValue({ stream: mockStream });
    mockPayments.mockReturnValue({ forAccount: mockForAccount });
    agent = new PayFiAgent();
  });

  it('startListening calls horizonServer.payments().forAccount().stream()', () => {
    agent.startListening('https://example.com/resource', vi.fn());
    expect(mockPayments).toHaveBeenCalledOnce();
    expect(mockForAccount).toHaveBeenCalledWith(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    );
    expect(mockStream).toHaveBeenCalledOnce();
  });

  it('onChallenge is invoked when stream emits a valid x402 memo', () => {
    const onChallenge = vi.fn();

    // Override stream to simulate an incoming payment with a valid x402 memo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockStream as any).mockImplementationOnce((opts: any) => {
      const challenge = {
        resource: 'https://example.com/resource',
        amount: '1',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        nonce: '550e8400-e29b-41d4-a716-446655440000',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const encoded = Buffer.from(JSON.stringify(challenge)).toString('base64');
      opts.onmessage({ memo: `x402:${encoded}` });
      return mockStopStream;
    });

    agent.startListening('https://example.com/resource', onChallenge);
    expect(onChallenge).toHaveBeenCalledOnce();
    expect(onChallenge.mock.calls[0]![0]).toMatchObject({
      resource: 'https://example.com/resource',
    });
  });

  it('drops a malformed-but-parseable x402 memo instead of forwarding it to onChallenge (#237)', () => {
    const onChallenge = vi.fn();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockStream as any).mockImplementationOnce((opts: any) => {
      // Valid JSON, but fails X402ChallengeSchema: `amount` is a number
      // instead of a string, `payTo` is not 56 characters, and `nonce`
      // is not a UUID.
      const malformedChallenge = {
        resource: 'https://example.com/resource',
        amount: 1,
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        payTo: 'not-a-real-address',
        nonce: 'not-a-uuid',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const encoded = Buffer.from(JSON.stringify(malformedChallenge)).toString('base64');
      opts.onmessage({ memo: `x402:${encoded}` });
      return mockStopStream;
    });

    agent.startListening('https://example.com/resource', onChallenge);

    expect(onChallenge).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'Dropped invalid x402 challenge memo',
      expect.objectContaining({ error: expect.any(String) })
    );

    warnSpy.mockRestore();
  });

  it('stopListening calls the stream close function', () => {
    agent.startListening('https://example.com/resource', vi.fn());
    agent.stopListening();
    expect(mockStopStream).toHaveBeenCalledOnce();
  });

  it('stopListening inside destroy cleans up the stream', () => {
    agent.startListening('https://example.com/resource', vi.fn());
    expect(() => agent.destroy()).not.toThrow();
    expect(mockStopStream).toHaveBeenCalledOnce();
  });

  it('calling startListening twice does not open a second stream', () => {
    agent.startListening('https://example.com/resource', vi.fn());
    agent.startListening('https://example.com/resource', vi.fn());
    expect(mockStream).toHaveBeenCalledOnce(); // only one stream opened
  });

  // ── SSE disconnect and reconnect scenarios (#455) ─────────────────────────

  it('SSE stream emits 3 events then fires an error event — reconnect logic fires', () => {
    const onChallenge = vi.fn();
    let capturedOpts: Record<string, (...args: unknown[]) => void> = {};

    // Capture the stream options so we can simulate SSE lifecycle events
    (mockStream as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (opts: Record<string, (...args: unknown[]) => void>) => {
        capturedOpts = opts;
        return mockStopStream;
      }
    );

    agent.startListening('https://example.com/resource', onChallenge);

    const makeValidChallenge = (nonce: string) => {
      const challenge = {
        resource: 'https://example.com/resource',
        amount: '1',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        nonce,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      return `x402:${Buffer.from(JSON.stringify(challenge)).toString('base64')}`;
    };

    // Emit 3 valid x402 events
    capturedOpts['onmessage']?.({
      memo: makeValidChallenge('550e8400-e29b-41d4-a716-446655440000'),
    });
    capturedOpts['onmessage']?.({
      memo: makeValidChallenge('550e8400-e29b-41d4-a716-446655440001'),
    });
    capturedOpts['onmessage']?.({
      memo: makeValidChallenge('550e8400-e29b-41d4-a716-446655440002'),
    });

    expect(onChallenge).toHaveBeenCalledTimes(3);

    // Fire an error event — the stream drops
    capturedOpts['onerror']?.({ message: 'SSE connection dropped' });

    // The agent should have called stop to close the broken stream
    expect(mockStopStream).toHaveBeenCalled();
  });

  it('SSE stream fires a close event (clean disconnect) — listener terminates without error', () => {
    const onChallenge = vi.fn();
    let capturedOpts: Record<string, (...args: unknown[]) => void> = {};

    (mockStream as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (opts: Record<string, (...args: unknown[]) => void>) => {
        capturedOpts = opts;
        return mockStopStream;
      }
    );

    agent.startListening('https://example.com/resource', onChallenge);

    // Simulate a clean SSE close
    expect(() => {
      capturedOpts['onclose']?.();
    }).not.toThrow();

    // No challenges should have been forwarded
    expect(onChallenge).not.toHaveBeenCalled();
  });
});
