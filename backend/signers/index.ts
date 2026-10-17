/**
 * backend/signers/index.ts
 *
 * Selects the signing backend from `SIGNER_BACKEND`.
 */

import { config } from '../config';
import { LocalSigner } from './LocalSigner';
import { VaultTransitSigner } from './VaultTransitSigner';
import type { Signer } from './Signer';

export type { Signer, SignerBackend } from './Signer';
export { signTransaction } from './Signer';
export { LocalSigner } from './LocalSigner';
export { VaultTransitSigner } from './VaultTransitSigner';

/**
 * Build the signer configured by `SIGNER_BACKEND`.
 *
 * - `local` (default): signs with `config.agentKeypair()`.
 * - `vault`: signs with a HashiCorp Vault transit key. Requires `VAULT_ADDR`,
 *   `VAULT_TRANSIT_KEY` and a `VAULT_TOKEN` environment variable. The token is
 *   read from the environment here rather than stored on `config`, matching
 *   how the Vault CLI and AWS SDK pick up their credentials.
 */
export function createSigner(): Signer {
  switch (config.SIGNER_BACKEND) {
    case 'vault': {
      const token = process.env.VAULT_TOKEN;
      if (!config.VAULT_ADDR || !config.VAULT_TRANSIT_KEY || !token) {
        throw new Error(
          'SIGNER_BACKEND=vault requires VAULT_ADDR, VAULT_TRANSIT_KEY and VAULT_TOKEN to be set'
        );
      }
      return new VaultTransitSigner({
        address: config.VAULT_ADDR,
        token,
        keyName: config.VAULT_TRANSIT_KEY,
        mount: config.VAULT_TRANSIT_MOUNT,
      });
    }

    case 'local':
    default:
      return new LocalSigner(config.agentKeypair());
  }
}
