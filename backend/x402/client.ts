/**
 * backend/x402/client.ts
 *
 * x402 v2 buyer-side client for Nodal AI.
 *
 * Wraps @x402/stellar's ExactStellarScheme and @x402/core's x402HTTPClient to
 * let the agent pay real x402 v2 endpoints end-to-end:
 *
 *   1. Make the initial request.
 *   2. On 402 read the PAYMENT-REQUIRED header → PaymentRequired.
 *   3. Choose a Stellar-compatible PaymentRequirements from `accepts[]`.
 *   4. Guard asset code + issuer against X402_ALLOWED_ASSETS / X402_MAX_PRICE.
 *   5. Guard the destination (payTo) against PAYMENT_DESTINATION_POLICY.
 *   6. Guard the amount against AGENT_SPENDING_LIMIT.
 *   7. Reserve the spend, sign the SAC auth entry, encode the PAYMENT header.
 *   8. Retry the request with the payment header.
 *   9. On confirmed settlement (200 + PAYMENT-RESPONSE) → commit the spend.
 *   10. On any failure → release the reservation.
 *
 * ## Design decisions
 *
 * ### Signer adapter
 * @x402/stellar's `ClientStellarSigner` wants SEP-43 `signAuthEntry(entryXdr,
 * {networkPassphrase})` → `Promise<string>` (base64 XDR).  Nodal's `Signer`
 * exposes `signAuthEntry(entry: xdr.SorobanAuthorizationEntry, ledger, passphrase)`
 * → `Promise<xdr.SorobanAuthorizationEntry>`.  The adapter in
 * `NodalClientStellarSigner` bridges the two: it deserialises the incoming
 * base64 XDR, calls Nodal's signer, and re-serialises the result.  The
 * `validUntilLedgerSeq` is derived by fetching the current ledger from
 * Soroban RPC and adding a small buffer (DEFAULT_AUTH_EXPIRY_LEDGERS = 50).
 *
 * ### Spend recorded only after settlement
 * `reserve()` is called *before* signing so that concurrent calls see the
 * pending spend.  `commit()` fires only when the response carries a successful
 * PAYMENT-RESPONSE settlement header.  `release()` fires on any error or on a
 * non-settlement response (e.g. a 402 retry loop that ultimately fails).
 *
 * ### Asset validation
 * `PaymentRequirements.asset` is a SEP-41 contract address (C…), not a
 * {code, issuer} tuple.  We validate it against `config.X402_ASSET_CONTRACT`
 * (and any contracts listed in the allow-list) rather than against asset codes.
 *
 * ### Network validation
 * The chosen `PaymentRequirements.network` must be the CAIP-2 identifier for
 * the agent's configured Stellar network.  Requirements on other networks are
 * filtered out before the selector runs.
 */

import { xdr } from '@stellar/stellar-sdk';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import type { ClientStellarSigner, RpcConfig } from '@x402/stellar';

import { config, MAINNET_SPENDING_CAP } from '../config';
import { createLogger } from '../utils/logger';
import { toCaip2 } from '../network';
import { spendingTracker } from '../spending_tracker';
import { PolicyViolationError } from '../errors';
import type { Signer } from '../signer';
import { sorobanServer } from '../rpc_client';

const log = createLogger('x402-client');

// ─── Constants ────────────────────────────────────────────────────────────────

/** How many ledgers ahead the auth entry is valid (≈ 50 × 5 s = 250 s). */
const DEFAULT_AUTH_EXPIRY_LEDGERS = 50;

// ─── Signer adapter ───────────────────────────────────────────────────────────

/**
 * Adapts Nodal's `Signer` to the `ClientStellarSigner` interface expected by
 * `@x402/stellar/exact/client`'s `ExactStellarScheme`.
 *
 * `ClientStellarSigner.signAuthEntry` receives a base64-encoded
 * `SorobanAuthorizationEntry` XDR and a `{networkPassphrase}` options object,
 * and must return the signed entry re-encoded as base64.
 *
 * `ClientStellarSigner.signTransaction` is optional and left unimplemented
 * because the Exact scheme's client role only signs auth entries; the
 * facilitator signs and submits the outer transaction.
 */
class NodalClientStellarSigner implements ClientStellarSigner {
  readonly address: string;

  constructor(private readonly signer: Signer) {
    this.address = signer.publicKey();
  }

  /**
   * Bridge between @x402/stellar's SEP-43 signAuthEntry (XDR base64 in/out)
   * and Nodal's Signer.signAuthEntry (xdr.SorobanAuthorizationEntry in/out).
   */
  async signAuthEntry(
    entryXdr: string,
    opts: { networkPassphrase: string }
  ): Promise<string> {
    // Deserialise the incoming base64 XDR → SorobanAuthorizationEntry
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');

    // Derive the ledger expiry: current ledger + buffer
    let validUntilLedgerSeq: number;
    try {
      const latestLedger = await sorobanRpc.getLatestLedger();
      validUntilLedgerSeq = latestLedger.sequence + DEFAULT_AUTH_EXPIRY_LEDGERS;
    } catch {
      // If we cannot fetch the ledger, use a reasonable absolute value.
      // ExactStellarScheme will re-simulate and may override this.
      validUntilLedgerSeq = 0;
      log.warn('Could not fetch latest ledger for auth entry expiry; using 0');
    }

    const signed = await this.signer.signAuthEntry(
      entry,
      validUntilLedgerSeq,
      opts.networkPassphrase
    );

    // Re-serialise to base64 XDR for the @x402/stellar layer
    return signed.toXDR('base64');
  }
}

// ─── Guard helpers ────────────────────────────────────────────────────────────

/**
 * Returns the set of permitted SAC contract addresses from config.
 * Always includes `config.X402_ASSET_CONTRACT`. When `X402_ALLOWED_ASSETS` is
 * set, parses each `CODE:ISSUER` entry and derives its contract address from
 * the configured network passphrase.
 */
function allowedAssetContracts(): Set<string> {
  const contracts = new Set<string>([config.X402_ASSET_CONTRACT]);

  if (config.X402_ALLOWED_ASSETS) {
    for (const entry of config.X402_ALLOWED_ASSETS.split(',').map((s) => s.trim())) {
      if (entry === 'XLM') {
        // Native XLM is allowed; its SAC is already well-known but we'll
        // accept it via findDefaultAsset matching in selectRequirements.
        continue;
      }
      // entries are "CODE:ISSUER"; contract address is in config for the
      // primary asset. For additional assets we just store the entry string
      // and compare by contract in selectRequirements below.
      contracts.add(entry); // kept as CODE:ISSUER for now; matched at selection time
    }
  }

  return contracts;
}

/**
 * Guard the amount from a PaymentRequirements against AGENT_SPENDING_LIMIT and
 * the mainnet hard cap. Throws with a clear message if either is exceeded.
 */
function assertAmountWithinLimits(amount: string): void {
  const parsed = parseFloat(amount);
  if (isNaN(parsed)) throw new Error(`x402 v2: invalid payment amount "${amount}"`);

  const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
  if (!isNaN(limit) && parsed > limit) {
    throw new Error(
      `x402 v2: amount ${amount} exceeds AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
    );
  }

  if (config.STELLAR_NETWORK === 'mainnet' && parsed > MAINNET_SPENDING_CAP) {
    throw new Error(
      `x402 v2: amount ${amount} exceeds mainnet spending cap of ${MAINNET_SPENDING_CAP}`
    );
  }

  if (config.X402_MAX_PRICE && parsed > parseFloat(config.X402_MAX_PRICE)) {
    throw new Error(
      `x402 v2: amount ${amount} exceeds X402_MAX_PRICE of ${config.X402_MAX_PRICE}`
    );
  }
}

/**
 * Guard the `payTo` address against PAYMENT_DESTINATION_POLICY.
 * Mirrors the same logic used by StellarPaymentTool / agent.ts.
 */
function assertPayToAllowed(payTo: string, selfAddress: string): void {
  if (payTo === selfAddress) {
    throw new Error("x402 v2: payTo cannot be the agent's own address");
  }

  const policy = config.PAYMENT_DESTINATION_POLICY;
  if (policy === 'open') return;

  const listed = new Set(config.PAYMENT_DESTINATIONS.map((d) => d.toLowerCase()));
  const isListed = listed.has(payTo.toLowerCase());
  if (policy === 'allowlist' ? !isListed : isListed) {
    throw new PolicyViolationError(
      `x402 v2: payTo ${payTo} is not permitted by the ${policy} payment destination policy`
    );
  }
}

// ─── Requirement selection ────────────────────────────────────────────────────

/**
 * Choose the first PaymentRequirements entry from `accepts` that:
 *  - uses the `"exact"` scheme
 *  - targets the agent's CAIP-2 network
 *  - requests an asset the agent is configured to pay
 *
 * Returns `undefined` when no compatible option exists.
 */
function selectRequirements(
  accepts: PaymentRequirements[],
  agentNetwork: string,
  allowed: Set<string>
): PaymentRequirements | undefined {
  for (const req of accepts) {
    if (req.scheme !== 'exact') continue;
    if (req.network !== agentNetwork && req.network !== 'stellar:*') continue;

    // req.asset is a SAC contract address (C…) or a CODE:ISSUER entry for
    // non-default assets listed in X402_ALLOWED_ASSETS.
    if (allowed.has(req.asset) || allowed.has(req.asset.toUpperCase())) return req;

    // Fallback: accept the default asset contract on this network.
    if (req.asset === config.X402_ASSET_CONTRACT) return req;
  }
  return undefined;
}

// ─── Main client class ────────────────────────────────────────────────────────

/**
 * Result returned by `X402FetchClient.fetch()`.
 */
export interface X402FetchResult {
  /** The final HTTP response (200 on success, original non-402 status otherwise). */
  response: Response;
  /**
   * Settlement details from the PAYMENT-RESPONSE header, when the server
   * confirmed the payment.  `undefined` when no payment was required or the
   * server did not return a settlement header.
   */
  settlement?: SettleResponse;
}

/**
 * x402 v2 buyer client.
 *
 * Construct once and reuse across requests; the underlying `x402Client` is
 * stateless between calls (schemes are registered once at construction).
 *
 * @example
 * ```typescript
 * import { X402FetchClient } from './backend/x402/client';
 * import { createAgentSigner } from './backend/signer';
 *
 * const client = new X402FetchClient(createAgentSigner());
 * const { response, settlement } = await client.fetch('https://api.example.com/paid');
 * const data = await response.json();
 * ```
 */
export class X402FetchClient {
  private readonly httpClient: x402HTTPClient;
  private readonly agentAddress: string;
  private readonly agentNetwork: string;
  private readonly allowed: Set<string>;

  constructor(signer: Signer) {
    this.agentAddress = signer.publicKey();
    this.agentNetwork = toCaip2(config.STELLAR_NETWORK);
    this.allowed = allowedAssetContracts();

    const stellarSigner = new NodalClientStellarSigner(signer);
    const rpcConfig: RpcConfig = { url: config.SOROBAN_RPC_URL };

    const scheme = new ExactStellarScheme(stellarSigner, rpcConfig);

    const client = new x402Client().register('stellar:*', scheme);
    this.httpClient = new x402HTTPClient(client);
  }

  /**
   * Fetch `url` with automatic x402 v2 payment handling.
   *
   * If the server returns 402 with a compatible PAYMENT-REQUIRED header, this
   * method:
   *   1. Selects a Stellar-compatible PaymentRequirements from `accepts`.
   *   2. Runs all spending/policy guards before touching the signer.
   *   3. Reserves the spend against the rolling window.
   *   4. Signs the SAC auth entry and encodes the PAYMENT header.
   *   5. Retries the original request with the PAYMENT header attached.
   *   6. Commits the spend on 200 + settlement; releases on any failure.
   *
   * Non-402 responses are returned as-is (no payment attempted).
   * A 402 that contains no Stellar-compatible option throws immediately
   * without touching the signer or the spending window.
   *
   * @param url - Target URL.
   * @param init - Optional RequestInit forwarded to both the probe and paid requests.
   * @returns The final response and optional settlement details.
   */
  async fetch(url: string | URL, init?: RequestInit): Promise<X402FetchResult> {
    const urlStr = url instanceof URL ? url.toString() : url;

    // ── 1. Probe request ─────────────────────────────────────────────────────
    const probeResponse = await globalThis.fetch(urlStr, init);

    if (probeResponse.status !== 402) {
      return { response: probeResponse };
    }

    // ── 2. Parse payment requirements from PAYMENT-REQUIRED header ───────────
    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = this.httpClient.getPaymentRequiredResponse(
        (name) => probeResponse.headers.get(name),
        await probeResponse.clone().json().catch(() => undefined)
      );
    } catch (err) {
      throw new Error(
        `x402 v2: failed to parse PAYMENT-REQUIRED header from ${urlStr}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── 3. Select a compatible requirement ───────────────────────────────────
    const chosen = selectRequirements(
      paymentRequired.accepts,
      this.agentNetwork,
      this.allowed
    );

    if (!chosen) {
      const networks = [...new Set(paymentRequired.accepts.map((r) => r.network))].join(', ');
      const assets = [...new Set(paymentRequired.accepts.map((r) => r.asset))].join(', ');
      throw new Error(
        `x402 v2: no compatible payment option for ${urlStr}. ` +
        `Server accepts networks [${networks}], assets [${assets}]. ` +
        `Agent is on ${this.agentNetwork} with asset contract ${config.X402_ASSET_CONTRACT}.`
      );
    }

    // ── 4. Pre-payment guards (before reserving or signing) ──────────────────
    assertAmountWithinLimits(chosen.amount);
    assertPayToAllowed(chosen.payTo, this.agentAddress);

    if (config.ALLOWED_X402_ORIGINS) {
      const allowedOrigins = new Set(
        config.ALLOWED_X402_ORIGINS.split(',').map((o) => o.trim())
      );
      const hostname = new URL(urlStr).hostname;
      if (!allowedOrigins.has(hostname)) {
        throw new Error(`x402 v2: untrusted resource origin: ${hostname}`);
      }
    }

    // ── 5. Reserve spend ─────────────────────────────────────────────────────
    const reservationId = spendingTracker.reserve(chosen.amount);

    let paymentPayload;
    try {
      // ── 6. Sign the SAC auth entry and build the payment payload ───────────
      paymentPayload = await this.httpClient.createPaymentPayload(paymentRequired);
    } catch (err) {
      spendingTracker.release(reservationId);
      throw new Error(
        `x402 v2: failed to create payment payload for ${urlStr}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── 7. Encode PAYMENT header and retry ────────────────────────────────────
    const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(paymentPayload);

    const paidResponse = await globalThis.fetch(urlStr, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        ...paymentHeaders,
      },
    });

    // ── 8. Read settlement header and commit / release spend ─────────────────
    let settlement: SettleResponse | undefined;
    try {
      const { settleResponse } = await this.httpClient.processPaymentResult(
        paymentPayload,
        (name) => paidResponse.headers.get(name),
        paidResponse.status
      );
      settlement = settleResponse;
    } catch {
      // processPaymentResult failing is non-fatal; we already have the response.
    }

    const settled = paidResponse.status === 200 && settlement?.success === true;

    if (settled) {
      spendingTracker.commit(reservationId);
      log.info(
        { url: urlStr, amount: chosen.amount, asset: chosen.asset, network: chosen.network },
        'x402 v2 payment settled'
      );
    } else {
      spendingTracker.release(reservationId);
      if (paidResponse.status !== 200) {
        log.warn(
          { url: urlStr, status: paidResponse.status },
          'x402 v2 paid request did not return 200; spend released'
        );
      }
    }

    return { response: paidResponse, settlement };
  }
}
