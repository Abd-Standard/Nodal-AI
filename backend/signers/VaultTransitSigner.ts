/**
 * backend/signers/VaultTransitSigner.ts
 *
 * Signer backed by a HashiCorp Vault transit `ed25519` key.
 *
 * The private key is generated inside Vault and never exported — the agent only
 * sends the 32-byte transaction hash to `POST /v1/<mount>/sign/<key>` and gets
 * the signature back. The public key is read once from
 * `GET /v1/<mount>/keys/<key>` and cached.
 */

import axios from 'axios';
import { StrKey } from '@stellar/stellar-sdk';
import { createLogger } from '../utils/logger';
import type { Signer } from './Signer';

const log = createLogger('vault-transit-signer');

export interface VaultTransitSignerOptions {
  /** Vault server address, e.g. `https://vault.example.com:8200`. */
  address: string;
  /** Vault token with `update` on sign/<key> and `read` on keys/<key>. */
  token: string;
  /** Name of the transit key (must be type `ed25519`). */
  keyName: string;
  /** Mount path of the transit secrets engine. Defaults to `transit`. */
  mount?: string;
  /** Per-request timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
}

interface VaultKeyResponse {
  data: {
    type: string;
    latest_version: number;
    keys: Record<string, { public_key?: string }>;
  };
}

interface VaultSignResponse {
  data: { signature: string };
}

export class VaultTransitSigner implements Signer {
  readonly backend = 'vault' as const;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly keyName: string;
  private readonly timeoutMs: number;
  private cachedPublicKey: string | null = null;

  constructor(options: VaultTransitSignerOptions) {
    const mount = (options.mount ?? 'transit').replace(/^\/+|\/+$/g, '');
    this.baseUrl = `${options.address.replace(/\/+$/, '')}/v1/${mount}`;
    this.token = options.token;
    this.keyName = options.keyName;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private get headers(): Record<string, string> {
    return { 'X-Vault-Token': this.token };
  }

  async publicKey(): Promise<string> {
    if (this.cachedPublicKey) return this.cachedPublicKey;

    const res = await axios.get<VaultKeyResponse>(
      `${this.baseUrl}/keys/${encodeURIComponent(this.keyName)}`,
      { headers: this.headers, timeout: this.timeoutMs }
    );

    const { type, latest_version: latestVersion, keys } = res.data.data;
    if (type !== 'ed25519') {
      throw new Error(
        `Vault transit key "${this.keyName}" is type "${type}"; Stellar requires "ed25519"`
      );
    }

    const encoded = keys[String(latestVersion)]?.public_key;
    if (!encoded) {
      throw new Error(
        `Vault transit key "${this.keyName}" has no public key for its latest version`
      );
    }

    const raw = Buffer.from(encoded, 'base64');
    if (raw.length !== 32) {
      throw new Error(`Vault transit key "${this.keyName}" returned a malformed public key`);
    }

    this.cachedPublicKey = StrKey.encodeEd25519PublicKey(raw);
    log.info({ keyName: this.keyName, publicKey: this.cachedPublicKey }, 'Vault signer key loaded');
    return this.cachedPublicKey;
  }

  async sign(data: Buffer): Promise<Buffer> {
    const res = await axios.post<VaultSignResponse>(
      `${this.baseUrl}/sign/${encodeURIComponent(this.keyName)}`,
      { input: data.toString('base64') },
      { headers: this.headers, timeout: this.timeoutMs }
    );

    // Vault returns `vault:v<version>:<base64 signature>`.
    const signature = res.data.data.signature;
    const encoded = signature.slice(signature.lastIndexOf(':') + 1);
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length !== 64) {
      throw new Error(`Vault transit key "${this.keyName}" returned a malformed signature`);
    }
    return raw;
  }
}
