/**
 * scripts/deploy_escrow.ts
 *
 * Reproducible deploy-and-verify for the escrow contract, with WASM hash
 * pinning. One run = one release recorded in `deployments/<network>.json`.
 *
 *   1. Builds the contract reproducibly (scripts/build_escrow_wasm.sh).
 *   2. Hashes the WASM and compares it to the pinned release hash
 *      (`--expected-hash` or the release's `.sha256` / `.wasm` artifact).
 *      A mismatch aborts before anything touches the network.
 *   3. Uploads the WASM and checks the hash the network returns.
 *   4. Instantiates the contract from that hash.
 *   5. Downloads the deployed contract's WASM back from the ledger and checks
 *      its hash once more.
 *   6. Appends { release, contractId, wasmHash, ... } to
 *      `deployments/<network>.json` — commit that file with the release.
 *
 * Usage:
 *   npm run deploy:escrow -- --network testnet --release v1.2.0 \
 *     --artifact ./stellar_payfi_escrow.wasm.sha256
 *   npm run deploy:escrow -- --network mainnet --release v1.2.0 \
 *     --expected-hash <64-hex> --confirm-mainnet
 *
 * Options:
 *   --network <testnet|futurenet|mainnet>   required
 *   --release <tag>                         required, e.g. v1.2.0
 *   --expected-hash <hex>                   pinned SHA-256 of the release WASM
 *   --artifact <path>                       release artifact: a .sha256 file or the .wasm itself
 *   --skip-build                            hash the existing build output instead of rebuilding
 *   --dry-run                               build and verify the hash only; no network calls
 *   --confirm-mainnet                       required for --network mainnet
 *
 * Environment:
 *   DEPLOYER_SECRET_KEY   secret key that pays for and owns the deploy (falls back to AGENT_SECRET_KEY)
 *   SOROBAN_RPC_URL       RPC endpoint (defaults to the public endpoint for testnet/futurenet)
 *
 * Exit codes: 0 deployed (or dry run passed), 1 any failure — including a hash mismatch.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { execFileSync, spawnSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

type Network = 'testnet' | 'futurenet' | 'mainnet';

const ROOT = path.resolve(__dirname, '..');
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build_escrow_wasm.sh');
const WASM_PATH = path.join(
  ROOT,
  'contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm'
);
const DEPLOYMENTS_DIR = path.join(ROOT, 'deployments');

const PASSPHRASES: Record<Network, string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
};

const DEFAULT_RPC_URLS: Partial<Record<Network, string>> = {
  testnet: 'https://soroban-testnet.stellar.org',
  futurenet: 'https://rpc-futurenet.stellar.org',
};

const TX_TIMEOUT_SECONDS = 60;
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2_000;

/** One release entry in deployments/<network>.json. */
interface DeploymentRecord {
  release: string;
  contractId: string;
  wasmHash: string;
  wasmSizeBytes: number;
  deployer: string;
  uploadTxHash: string;
  deployTxHash: string;
  deployedAt: string;
  gitCommit: string;
  rustToolchain: string;
}

interface DeploymentsFile {
  network: Network;
  networkPassphrase: string;
  deployments: DeploymentRecord[];
}

interface Options {
  network: Network;
  release: string;
  expectedHash: string | undefined;
  artifact: string | undefined;
  skipBuild: boolean;
  dryRun: boolean;
  confirmMainnet: boolean;
}

class DeployError extends Error {}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valued = new Set(['--network', '--release', '--expected-hash', '--artifact']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (valued.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new DeployError(`${arg} requires a value`);
      values.set(arg, value);
    } else if (['--skip-build', '--dry-run', '--confirm-mainnet'].includes(arg)) {
      flags.add(arg);
    } else {
      throw new DeployError(`Unknown argument: ${arg}`);
    }
  }

  const network = values.get('--network');
  if (network !== 'testnet' && network !== 'futurenet' && network !== 'mainnet') {
    throw new DeployError('--network must be one of: testnet | futurenet | mainnet');
  }
  const release = values.get('--release');
  if (!release) throw new DeployError('--release <tag> is required (e.g. v1.2.0)');

  return {
    network,
    release,
    expectedHash: values.get('--expected-hash'),
    artifact: values.get('--artifact'),
    skipBuild: flags.has('--skip-build'),
    dryRun: flags.has('--dry-run'),
    confirmMainnet: flags.has('--confirm-mainnet'),
  };
}

// ─── Hash pinning ─────────────────────────────────────────────────────────────

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function normaliseHash(value: string, source: string): string {
  const hash = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new DeployError(`${source} is not a 64-character hex SHA-256: "${value.trim()}"`);
  }
  return hash;
}

/**
 * Resolve the pinned release hash. Exactly one source is required — a deploy
 * without a pin could silently ship whatever the local tree happens to build.
 */
function resolveExpectedHash(opts: Options): string {
  if (opts.expectedHash && opts.artifact) {
    throw new DeployError('Pass either --expected-hash or --artifact, not both');
  }
  if (opts.expectedHash) return normaliseHash(opts.expectedHash, '--expected-hash');
  if (opts.artifact) {
    if (!fs.existsSync(opts.artifact)) {
      throw new DeployError(`Release artifact not found: ${opts.artifact}`);
    }
    const content = fs.readFileSync(opts.artifact);
    // A `.sha256` file holds "<hash>  <filename>"; anything else is the WASM itself.
    if (opts.artifact.endsWith('.sha256')) {
      return normaliseHash(content.toString('utf8').split(/\s+/)[0] ?? '', opts.artifact);
    }
    return sha256Hex(content);
  }
  throw new DeployError(
    'A pinned release hash is required: pass --expected-hash <hex> or --artifact <path>'
  );
}

function assertHashMatches(actual: string, expected: string, stage: string): void {
  if (actual !== expected) {
    throw new DeployError(
      `WASM hash mismatch ${stage} — expected ${expected}, got ${actual}. Aborting.`
    );
  }
}

// ─── Build ────────────────────────────────────────────────────────────────────

function buildWasm(): void {
  const result = spawnSync('bash', [BUILD_SCRIPT], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new DeployError(`Reproducible build failed (exit ${result.status ?? 'signal'})`);
  }
}

function commandOutput(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ─── Network ──────────────────────────────────────────────────────────────────

function resolveRpcUrl(network: Network): string {
  const url = process.env.SOROBAN_RPC_URL ?? DEFAULT_RPC_URLS[network];
  if (!url) throw new DeployError(`SOROBAN_RPC_URL is required for ${network}`);
  if (network === 'mainnet' && !url.startsWith('https://')) {
    throw new DeployError(`SOROBAN_RPC_URL must use HTTPS on mainnet (got: ${url})`);
  }
  return url;
}

function loadDeployer(): Keypair {
  const secret = process.env.DEPLOYER_SECRET_KEY ?? process.env.AGENT_SECRET_KEY;
  if (!secret) throw new DeployError('DEPLOYER_SECRET_KEY (or AGENT_SECRET_KEY) is required');
  try {
    return Keypair.fromSecret(secret);
  } catch {
    // Never echo the value.
    throw new DeployError('DEPLOYER_SECRET_KEY is not a valid Stellar secret key');
  }
}

/** Build, simulate, sign and submit a single-operation Soroban transaction. */
async function submitOperation(
  server: rpc.Server,
  deployer: Keypair,
  passphrase: string,
  operation: xdr.Operation
): Promise<{ hash: string; returnValue: xdr.ScVal }> {
  const account = await server.getAccount(deployer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(operation)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(deployer);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    throw new DeployError(`Transaction rejected (${sent.status}): ${sent.hash}`);
  }

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const status = await server.getTransaction(sent.hash);
    if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      if (!status.returnValue) {
        throw new DeployError(`Transaction ${sent.hash} succeeded without a return value`);
      }
      return { hash: sent.hash, returnValue: status.returnValue };
    }
    if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new DeployError(`Transaction ${sent.hash} failed on-chain`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new DeployError(`Transaction ${sent.hash} not confirmed within the polling window`);
}

// ─── Deployments file ─────────────────────────────────────────────────────────

function deploymentsPath(network: Network): string {
  return path.join(DEPLOYMENTS_DIR, `${network}.json`);
}

function readDeployments(network: Network): DeploymentsFile {
  const file = deploymentsPath(network);
  if (!fs.existsSync(file)) {
    return { network, networkPassphrase: PASSPHRASES[network], deployments: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DeploymentsFile;
  if (parsed.network !== network || !Array.isArray(parsed.deployments)) {
    throw new DeployError(`${file} is malformed or belongs to another network`);
  }
  return parsed;
}

function writeDeployments(data: DeploymentsFile): void {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  fs.writeFileSync(deploymentsPath(data.network), `${JSON.stringify(data, null, 2)}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.network === 'mainnet' && !opts.confirmMainnet && !opts.dryRun) {
    throw new DeployError('Deploying to mainnet requires --confirm-mainnet');
  }

  const existing = readDeployments(opts.network);
  if (existing.deployments.some((d) => d.release === opts.release)) {
    throw new DeployError(
      `Release ${opts.release} is already recorded in ${deploymentsPath(opts.network)}`
    );
  }

  const expectedHash = resolveExpectedHash(opts);

  if (!opts.skipBuild) buildWasm();
  if (!fs.existsSync(WASM_PATH)) {
    throw new DeployError(`WASM not found at ${WASM_PATH} — run without --skip-build`);
  }
  const wasm = fs.readFileSync(WASM_PATH);
  const localHash = sha256Hex(wasm);
  assertHashMatches(localHash, expectedHash, 'between the local build and the release artifact');
  console.log(`✅ Local build matches pinned release hash ${expectedHash}`);

  if (opts.dryRun) {
    console.log('Dry run — skipping upload and deploy.');
    return;
  }

  const rpcUrl = resolveRpcUrl(opts.network);
  const passphrase = PASSPHRASES[opts.network];
  const server = new rpc.Server(rpcUrl, { allowHttp: opts.network !== 'mainnet' });
  const deployer = loadDeployer();

  // Upload — the network returns the hash it stored the code under.
  console.log(`Uploading ${wasm.length} bytes of WASM to ${opts.network}…`);
  const upload = await submitOperation(
    server,
    deployer,
    passphrase,
    Operation.uploadContractWasm({ wasm })
  );
  const uploadedHash = Buffer.from(upload.returnValue.bytes()).toString('hex');
  assertHashMatches(uploadedHash, expectedHash, 'between the release and the uploaded code');
  console.log(`✅ Uploaded (tx ${upload.hash})`);

  // Instantiate from the pinned hash — never from a hash the network echoed back.
  console.log('Instantiating contract…');
  const deploy = await submitOperation(
    server,
    deployer,
    passphrase,
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: Buffer.from(expectedHash, 'hex'),
      salt: randomBytes(32),
    })
  );
  const contractId = Address.fromScVal(deploy.returnValue).toString();
  console.log(`✅ Deployed ${contractId} (tx ${deploy.hash})`);

  // Verify — read the executable back from the ledger.
  const onChainWasm = await server.getContractWasmByContractId(contractId);
  assertHashMatches(
    sha256Hex(Buffer.from(onChainWasm)),
    expectedHash,
    'between the release and the deployed contract'
  );
  console.log('✅ On-chain contract code matches the pinned release hash');

  const record: DeploymentRecord = {
    release: opts.release,
    contractId,
    wasmHash: expectedHash,
    wasmSizeBytes: wasm.length,
    deployer: deployer.publicKey(),
    uploadTxHash: upload.hash,
    deployTxHash: deploy.hash,
    deployedAt: new Date().toISOString(),
    gitCommit: commandOutput('git', ['rev-parse', 'HEAD']),
    rustToolchain: commandOutput('rustc', ['--version']),
  };
  existing.deployments.push(record);
  writeDeployments(existing);
  console.log(`📝 Recorded ${opts.release} in ${deploymentsPath(opts.network)} — commit it.`);
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
