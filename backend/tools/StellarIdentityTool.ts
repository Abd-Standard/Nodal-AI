/**
 * backend/tools/StellarIdentityTool.ts
 * SEP-0010 Web Auth challenge-response for anchor authentication, and SEP-0045
 * Web Auth for contract (C…) accounts.
 */

import {
  Address,
  Keypair,
  StrKey,
  Transaction,
  hash,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { createAgentSigner, Signer } from '../signer';
import { resolveNetworkPassphrase, sorobanServer, withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';
import { createLogger } from '../utils/logger';
import { stellarContractIdSchema, stellarPublicKeySchema } from '../utils/stellarSchemas';
import { StellarTomlTool } from './StellarTomlTool';

const log = createLogger('stellar-identity');

const ChallengeResponseSchema = z.object({
  transaction: z.string().min(1),
  network_passphrase: z.string().min(1),
});

const AuthResponseSchema = z.object({
  token: z.string().min(1),
});

export const WebAuthInputSchema = z.object({
  anchorUrl: z.string().url(),
  publicKey: stellarPublicKeySchema('publicKey').optional(),
});

export type WebAuthInput = z.infer<typeof WebAuthInputSchema>;

/** SEP-45: authenticate a contract account against `homeDomain`. */
export const ContractWebAuthInputSchema = z.object({
  homeDomain: z.string().min(1),
  contractAccount: stellarContractIdSchema('contractAccount'),
});

export type ContractWebAuthInput = z.infer<typeof ContractWebAuthInputSchema>;

/**
 * Either flow: SEP-45 when `contractAccount` is given, otherwise SEP-10. The
 * contract schema is tried first so a SEP-45 request is never stripped down to
 * a SEP-10 one.
 */
export const StellarIdentityInputSchema = z.union([ContractWebAuthInputSchema, WebAuthInputSchema]);

export interface WebAuthResult {
  token: string;
}

const ContractChallengeResponseSchema = z.object({
  authorization_entries: z.string().min(1),
  network_passphrase: z.string().min(1).optional(),
});

/**
 * Ledgers the client's SEP-45 signature stays valid for (~50 s at 5 s/ledger).
 * SEP-45 recommends a near-future expiration so a leaked signed entry cannot
 * be replayed later; this leaves room for the token request round trip.
 */
export const SEP45_SIGNATURE_VALIDITY_LEDGERS = 10;

// SDK 13 has no `SorobanAuthorizationEntries` XDR type. `InvokeHostFunctionOp`
// ends with exactly that array (`auth<>`), so it carries the encoding: a fixed
// host-function prefix followed by the entries.
const CARRIER_HOST_FUNCTION = xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.alloc(0));
const CARRIER_PREFIX = CARRIER_HOST_FUNCTION.toXDR();

/** Decode a base64 XDR `SorobanAuthorizationEntries`. */
export function decodeAuthorizationEntries(b64: string): xdr.SorobanAuthorizationEntry[] {
  return xdr.InvokeHostFunctionOp.fromXDR(
    Buffer.concat([CARRIER_PREFIX, Buffer.from(b64, 'base64')])
  ).auth();
}

/** Encode entries as a base64 XDR `SorobanAuthorizationEntries`. */
export function encodeAuthorizationEntries(entries: xdr.SorobanAuthorizationEntry[]): string {
  return new xdr.InvokeHostFunctionOp({ hostFunction: CARRIER_HOST_FUNCTION, auth: entries })
    .toXDR()
    .subarray(CARRIER_PREFIX.length)
    .toString('base64');
}

function addressCredentials(
  entry: xdr.SorobanAuthorizationEntry
): xdr.SorobanAddressCredentials | undefined {
  const credentials = entry.credentials();
  return credentials.switch().value === xdr.SorobanCredentialsType.sorobanCredentialsAddress().value
    ? credentials.address()
    : undefined;
}

/** Whether `entry` carries a valid signature by `publicKey` (Stellar account signature format). */
function hasValidSignature(
  entry: xdr.SorobanAuthorizationEntry,
  publicKey: string,
  networkPassphrase: string
): boolean {
  const creds = addressCredentials(entry);
  if (!creds) return false;
  const payload = hash(
    xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(networkPassphrase)),
        nonce: creds.nonce(),
        signatureExpirationLedger: creds.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
      })
    ).toXDR()
  );
  const signatures = scValToNative(creds.signature());
  if (!Array.isArray(signatures)) return false;
  const keypair = Keypair.fromPublicKey(publicKey);
  return signatures.some(
    (sig: { public_key?: unknown; signature?: unknown }) =>
      Buffer.isBuffer(sig.public_key) &&
      Buffer.isBuffer(sig.signature) &&
      StrKey.encodeEd25519PublicKey(sig.public_key) === publicKey &&
      keypair.verify(payload, sig.signature)
  );
}

/**
 * SEP-45 client verification of a challenge: every entry invokes only
 * `web_auth_verify` on the server's web-auth contract with identical,
 * expected arguments; the server's entry carries a valid server signature;
 * and the only other entry is the client account's.
 *
 * @throws Error describing the first check that fails.
 */
export function verifyContractChallenge(
  entries: xdr.SorobanAuthorizationEntry[],
  expected: {
    webAuthContractId: string;
    contractAccount: string;
    homeDomain: string;
    webAuthDomain: string;
    serverSigningKey: string;
  },
  networkPassphrase: string
): void {
  if (entries.length === 0) throw new Error('SEP-45 challenge has no authorization entries');

  let argsJson: string | undefined;
  let serverEntry: xdr.SorobanAuthorizationEntry | undefined;
  let clientEntry: xdr.SorobanAuthorizationEntry | undefined;

  for (const entry of entries) {
    const invocation = entry.rootInvocation();
    if (invocation.subInvocations().length > 0) {
      throw new Error('SEP-45 challenge entry has sub-invocations');
    }
    const fn = invocation.function();
    if (
      fn.switch().value !==
      xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn().value
    ) {
      throw new Error('SEP-45 challenge entry is not a contract call');
    }
    const call = fn.contractFn();
    if (Address.fromScAddress(call.contractAddress()).toString() !== expected.webAuthContractId) {
      throw new Error('SEP-45 challenge invokes a contract other than WEB_AUTH_CONTRACT_ID');
    }
    if (call.functionName().toString() !== 'web_auth_verify') {
      throw new Error('SEP-45 challenge invokes a function other than web_auth_verify');
    }
    const args = call.args();
    if (args.length !== 1) throw new Error('SEP-45 challenge must pass a single args map');
    const json = JSON.stringify(scValToNative(args[0]!));
    if (argsJson !== undefined && json !== argsJson) {
      throw new Error('SEP-45 challenge entries carry different arguments');
    }
    argsJson = json;

    const creds = addressCredentials(entry);
    const signer = creds ? Address.fromScAddress(creds.address()).toString() : undefined;
    if (signer === expected.serverSigningKey) serverEntry = entry;
    else if (signer === expected.contractAccount) clientEntry = entry;
    else
      throw new Error(`SEP-45 challenge has an unexpected entry for ${signer ?? 'source account'}`);
  }

  const args = JSON.parse(argsJson!) as Record<string, unknown>;
  const expectedArgs: Record<string, string> = {
    account: expected.contractAccount,
    home_domain: expected.homeDomain,
    web_auth_domain: expected.webAuthDomain,
    web_auth_domain_account: expected.serverSigningKey,
  };
  for (const [key, value] of Object.entries(expectedArgs)) {
    if (args[key] !== value) {
      throw new Error(`SEP-45 challenge ${key} is ${String(args[key])}, expected ${value}`);
    }
  }
  if (typeof args.nonce !== 'string' || args.nonce.length === 0) {
    throw new Error('SEP-45 challenge has no nonce');
  }
  // This client never sends client_domain, so the challenge must not claim one.
  if (args.client_domain !== undefined || args.client_domain_account !== undefined) {
    throw new Error('SEP-45 challenge includes a client_domain that was not requested');
  }

  if (
    !serverEntry ||
    !hasValidSignature(serverEntry, expected.serverSigningKey, networkPassphrase)
  ) {
    throw new Error('SEP-45 challenge is not signed by the server SIGNING_KEY');
  }
  if (!clientEntry) throw new Error('SEP-45 challenge has no entry for the contract account');
}

export class StellarIdentityTool {
  private signer: Signer;
  private tomlTool: StellarTomlTool;

  constructor(
    signer: Signer = createAgentSigner(),
    tomlTool: StellarTomlTool = new StellarTomlTool()
  ) {
    this.signer = signer;
    this.tomlTool = tomlTool;
  }

  async getChallenge(
    anchorUrl: string,
    publicKey: string
  ): Promise<{ transaction: string; networkPassphrase: string }> {
    const baseUrl = anchorUrl.replace(/\/$/, '');
    const url = `${baseUrl}/auth?account=${encodeURIComponent(publicKey)}`;
    const response = await withBackoffGuard(() =>
      withRetry(() => fetch(url), config.MAX_RETRIES, config.RETRY_DELAY_MS)
    );

    if (!response.ok) {
      throw new Error(`SEP-0010 challenge request failed: HTTP ${response.status}`);
    }

    const body = ChallengeResponseSchema.parse(await response.json());
    return {
      transaction: body.transaction,
      networkPassphrase: body.network_passphrase,
    };
  }

  async execute(rawInput: unknown): Promise<WebAuthResult> {
    const parsed = StellarIdentityInputSchema.parse(rawInput);
    if ('contractAccount' in parsed) {
      return this.authenticateContract(parsed);
    }
    const input = parsed;
    const publicKey = input.publicKey ?? this.signer.publicKey();
    const baseUrl = input.anchorUrl.replace(/\/$/, '');

    log.info({ anchorUrl: baseUrl, publicKey }, 'Starting SEP-0010 web auth');

    const challenge = await this.getChallenge(baseUrl, publicKey);
    const tx = new Transaction(challenge.transaction, challenge.networkPassphrase);
    this.signer.signTransaction(tx);
    const signedXdr = tx.toXDR();

    const response = await withBackoffGuard(() =>
      withRetry(
        () =>
          fetch(`${baseUrl}/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transaction: signedXdr }),
          }),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );

    if (!response.ok) {
      throw new Error(`SEP-0010 auth submission failed: HTTP ${response.status}`);
    }

    const { token } = AuthResponseSchema.parse(await response.json());
    log.info({ anchorUrl: baseUrl, publicKey }, 'SEP-0010 web auth completed');

    return { token };
  }

  /**
   * SEP-45 Web Auth for a contract account: fetch the challenge from the home
   * domain's WEB_AUTH_FOR_CONTRACTS_ENDPOINT, verify it, sign the contract
   * account's entry through the Signer, and exchange it for a JWT.
   */
  async authenticateContract(rawInput: unknown): Promise<WebAuthResult> {
    const { homeDomain, contractAccount } = ContractWebAuthInputSchema.parse(rawInput);

    const toml = await this.tomlTool.fetchToml({ domain: homeDomain });
    const endpoint = toml.WEB_AUTH_FOR_CONTRACTS_ENDPOINT;
    const webAuthContractId = toml.WEB_AUTH_CONTRACT_ID;
    const serverSigningKey = toml.SIGNING_KEY;
    if (!endpoint || !webAuthContractId || !serverSigningKey) {
      throw new Error(
        `${homeDomain} stellar.toml must define WEB_AUTH_FOR_CONTRACTS_ENDPOINT, WEB_AUTH_CONTRACT_ID and SIGNING_KEY for SEP-45`
      );
    }
    if (
      !StrKey.isValidContract(webAuthContractId) ||
      !StrKey.isValidEd25519PublicKey(serverSigningKey)
    ) {
      throw new Error(
        `${homeDomain} stellar.toml has an invalid WEB_AUTH_CONTRACT_ID or SIGNING_KEY`
      );
    }

    log.info({ homeDomain, contractAccount }, 'Starting SEP-0045 web auth');

    const networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
    const challengeUrl = new URL(endpoint);
    challengeUrl.searchParams.set('account', contractAccount);
    challengeUrl.searchParams.set('home_domain', homeDomain);
    const challengeResponse = await withBackoffGuard(() =>
      withRetry(() => fetch(challengeUrl), config.MAX_RETRIES, config.RETRY_DELAY_MS)
    );
    if (!challengeResponse.ok) {
      throw new Error(`SEP-0045 challenge request failed: HTTP ${challengeResponse.status}`);
    }
    const challenge = ContractChallengeResponseSchema.parse(await challengeResponse.json());
    if (challenge.network_passphrase && challenge.network_passphrase !== networkPassphrase) {
      throw new Error(`SEP-0045 challenge is for network "${challenge.network_passphrase}"`);
    }

    const entries = decodeAuthorizationEntries(challenge.authorization_entries);
    verifyContractChallenge(
      entries,
      {
        webAuthContractId,
        contractAccount,
        homeDomain,
        webAuthDomain: challengeUrl.host,
        serverSigningKey,
      },
      networkPassphrase
    );

    const { sequence } = await sorobanServer.getLatestLedger();
    const validUntil = sequence + SEP45_SIGNATURE_VALIDITY_LEDGERS;
    const signed = await Promise.all(
      entries.map((entry) => {
        const creds = addressCredentials(entry);
        return creds && Address.fromScAddress(creds.address()).toString() === contractAccount
          ? this.signer.signAuthEntry(entry, validUntil, networkPassphrase)
          : entry;
      })
    );

    const response = await withBackoffGuard(() =>
      withRetry(
        () =>
          fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authorization_entries: encodeAuthorizationEntries(signed) }),
          }),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );
    if (!response.ok) {
      throw new Error(`SEP-0045 token request failed: HTTP ${response.status}`);
    }

    const { token } = AuthResponseSchema.parse(await response.json());
    log.info({ homeDomain, contractAccount }, 'SEP-0045 web auth completed');
    return { token };
  }
}
