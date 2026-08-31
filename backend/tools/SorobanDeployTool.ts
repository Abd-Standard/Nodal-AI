/**
 * backend/tools/SorobanDeployTool.ts
 *
 * Upload WASM bytecode and instantiate Soroban smart contracts.
 * Supports:
 *   - action: 'upload' -> uploads WASM bytecode and returns WASM hash
 *   - action: 'instantiate' -> creates a contract instance from WASM hash and returns contract ID
 *   - action: 'deploy' -> chains upload and instantiate in sequence
 */

import * as fs from 'fs';
import { z } from 'zod';
import { sorobanServer } from '../rpc_client';
import { ValidationError } from '../errors';
import { createLogger } from '../utils/logger';

const log = createLogger('soroban-deploy');

// ─── Input Schema ─────────────────────────────────────────────────────────────

export const SorobanDeployInputSchema = z.object({
  action: z.enum(['upload', 'instantiate', 'deploy']),
  wasm: z.union([z.instanceof(Buffer), z.string()]).optional(),
  wasmBuffer: z.union([z.instanceof(Buffer), z.string()]).optional(),
  wasmHash: z.string().optional(),
});

export type SorobanDeployInput = z.infer<typeof SorobanDeployInputSchema>;

export interface SorobanDeployResult {
  action: 'upload' | 'instantiate' | 'deploy';
  wasmHash?: string;
  contractId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveWasmBuffer(input: SorobanDeployInput, actionName: string): Buffer {
  const raw = input.wasmBuffer ?? input.wasm;
  if (!raw) {
    throw new ValidationError(`WASM bytecode is required for action '${actionName}'`);
  }

  if (Buffer.isBuffer(raw)) {
    if (raw.length === 0) {
      throw new ValidationError(`WASM buffer cannot be empty for action '${actionName}'`);
    }
    return raw;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new ValidationError(`WASM string cannot be empty for action '${actionName}'`);
    }

    // Check if it is an existing file path
    try {
      if (fs.existsSync(trimmed) && fs.statSync(trimmed).isFile()) {
        return fs.readFileSync(trimmed);
      }
    } catch {
      // Not a valid file path, continue with decoding
    }

    // Try hex if it looks like hex
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      return Buffer.from(trimmed, 'hex');
    }

    // Try base64
    try {
      const buf = Buffer.from(trimmed, 'base64');
      if (buf.length > 0) return buf;
    } catch {
      // Fallback
    }

    return Buffer.from(trimmed, 'utf8');
  }

  throw new ValidationError(`Invalid WASM input type for action '${actionName}'`);
}

// ─── Tool Implementation ──────────────────────────────────────────────────────

export class SorobanDeployTool {
  /**
   * Upload WASM bytecode to Soroban RPC server.
   * Calls sorobanServer.uploadContractWasm(wasmBuffer) and returns the WASM hash.
   */
  async upload(wasmBuffer: Buffer): Promise<string> {
    const server = sorobanServer as any;
    if (typeof server.uploadContractWasm !== 'function') {
      throw new Error('sorobanServer does not implement uploadContractWasm');
    }

    log.info({ sizeBytes: wasmBuffer.length }, 'Uploading contract WASM bytecode');
    const response = await server.uploadContractWasm(wasmBuffer);

    const wasmHash =
      typeof response === 'string'
        ? response
        : (response?.wasmHash ?? response?.hash ?? String(response ?? ''));

    if (!wasmHash) {
      throw new Error('sorobanServer.uploadContractWasm did not return a valid WASM hash');
    }

    log.info({ wasmHash }, 'Contract WASM uploaded successfully');
    return wasmHash;
  }

  /**
   * Instantiate a contract from an already uploaded WASM hash.
   * Calls sorobanServer.createContractFromWasm(wasmHash) and returns the contract ID.
   */
  async instantiate(wasmHash: string): Promise<string> {
    if (!wasmHash || typeof wasmHash !== 'string' || wasmHash.trim() === '') {
      throw new ValidationError('wasmHash is required for instantiate action');
    }

    const server = sorobanServer as any;
    if (typeof server.createContractFromWasm !== 'function') {
      throw new Error('sorobanServer does not implement createContractFromWasm');
    }

    log.info({ wasmHash }, 'Instantiating contract from WASM hash');
    const response = await server.createContractFromWasm(wasmHash);

    const contractId =
      typeof response === 'string'
        ? response
        : (response?.contractId ?? response?.id ?? response?.address ?? String(response ?? ''));

    if (!contractId) {
      throw new Error('sorobanServer.createContractFromWasm did not return a valid contract ID');
    }

    log.info({ contractId, wasmHash }, 'Contract instantiated successfully');
    return contractId;
  }

  /**
   * Deploy flow: upload WASM and instantiate contract in sequence.
   * Returns both wasmHash and contractId.
   */
  async deploy(wasmBuffer: Buffer): Promise<{ wasmHash: string; contractId: string }> {
    const wasmHash = await this.upload(wasmBuffer);
    const contractId = await this.instantiate(wasmHash);
    return { wasmHash, contractId };
  }

  /**
   * Execute the requested deploy action.
   */
  async execute(rawInput: unknown): Promise<SorobanDeployResult> {
    const input = SorobanDeployInputSchema.parse(rawInput);

    switch (input.action) {
      case 'upload': {
        const wasmBuffer = resolveWasmBuffer(input, 'upload');
        const wasmHash = await this.upload(wasmBuffer);
        return { action: 'upload', wasmHash };
      }

      case 'instantiate': {
        if (!input.wasmHash) {
          throw new ValidationError('wasmHash is required for instantiate action');
        }
        const contractId = await this.instantiate(input.wasmHash);
        return { action: 'instantiate', contractId, wasmHash: input.wasmHash };
      }

      case 'deploy': {
        const wasmBuffer = resolveWasmBuffer(input, 'deploy');
        const { wasmHash, contractId } = await this.deploy(wasmBuffer);
        return { action: 'deploy', wasmHash, contractId };
      }

      default:
        throw new ValidationError(`Unknown action: ${(input as any).action}`);
    }
  }
}
