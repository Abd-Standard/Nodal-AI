"use strict";
/**
 * tests/e2e/escrow_flow.test.ts
 *
 * End-to-end test: fund a test keypair via Friendbot, deploy the escrow
 * WASM to testnet, then run the full initialize → release cycle and assert
 * the recipient balance increased.
 *
 * Run with:  npm run test:e2e
 * Excluded from default `npm run test` (see vitest.config.ts).
 *
 * Prerequisites:
 *   - SOROBAN_RPC_URL pointing at testnet (or use default)
 *   - Network access to Friendbot and Soroban RPC
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const axios_1 = __importDefault(require("axios"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = stellar_sdk_1.Networks.TESTNET;
const WASM_PATH = path.resolve(__dirname, "../../contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm");
const sorobanServer = new stellar_sdk_1.rpc.Server(SOROBAN_RPC_URL, { allowHttp: false });
async function friendbot(address) {
    await axios_1.default.get(`https://friendbot.stellar.org?addr=${address}`);
}
async function pollTx(server, hash, maxAttempts = 20, intervalMs = 3000) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const status = await server.getTransaction(hash);
        if (status.status === "SUCCESS")
            return status;
        if (status.status === "FAILED")
            throw new Error(`Transaction failed: ${hash}`);
    }
    throw new Error(`Transaction not confirmed within polling window: ${hash}`);
}
async function sendTx(server, tx) {
    const sim = await server.simulateTransaction(tx);
    if (stellar_sdk_1.rpc.Api.isSimulationError(sim)) {
        throw new Error(`Simulation failed: ${sim.error}`);
    }
    const prepared = stellar_sdk_1.rpc.assembleTransaction(tx, sim).build();
    prepared.sign(deployerKp);
    const result = await server.sendTransaction(prepared);
    if (result.status === "ERROR") {
        throw new Error(`Submit error: ${result.errorResult?.toXDR("base64")}`);
    }
    return pollTx(server, result.hash);
}
// Global state shared across tests
let deployerKp;
let recipientKp;
let contractId;
(0, vitest_1.describe)("Escrow E2E — testnet", () => {
    (0, vitest_1.beforeAll)(async () => {
        deployerKp = stellar_sdk_1.Keypair.random();
        recipientKp = stellar_sdk_1.Keypair.random();
        // Fund both keypairs via Friendbot
        await Promise.all([
            friendbot(deployerKp.publicKey()),
            friendbot(recipientKp.publicKey()),
        ]);
        // Small pause to let Horizon index the funded accounts
        await new Promise((r) => setTimeout(r, 5000));
    }, 60_000);
    (0, vitest_1.it)("deploys the escrow WASM and creates a contract instance", async () => {
        if (!fs.existsSync(WASM_PATH)) {
            console.warn("WASM not found — skipping deploy (run `cargo build --release --target wasm32-unknown-unknown`)");
            return;
        }
        const wasm = fs.readFileSync(WASM_PATH);
        const account = await sorobanServer.getAccount(deployerKp.publicKey());
        // 1. Upload WASM
        const uploadTx = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — uploadContractWasm is available via stellar-sdk xdr helpers
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeUploadContractWasm(wasm),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        const uploadResult = await sendTx(sorobanServer, uploadTx);
        const wasmHash = uploadResult.returnValue?.bytes();
        (0, vitest_1.expect)(wasmHash).toBeDefined();
        // 2. Create contract instance
        const account2 = await sorobanServer.getAccount(deployerKp.publicKey());
        const deployTx = new stellar_sdk_1.TransactionBuilder(account2, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — createContract via xdr helpers
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeCreateContract(new stellar_sdk_1.xdr.CreateContractArgs({
                contractIdPreimage: stellar_sdk_1.xdr.ContractIdPreimage.contractIdPreimageFromAddress(new stellar_sdk_1.xdr.ContractIdPreimageFromAddress({
                    address: stellar_sdk_1.Address.fromString(deployerKp.publicKey()).toScAddress(),
                    salt: Buffer.alloc(32),
                })),
                executable: stellar_sdk_1.xdr.ContractExecutable.contractExecutableWasm(wasmHash),
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        const deployResult = await sendTx(sorobanServer, deployTx);
        contractId = deployResult.returnValue?.address()?.contractId().toString("hex");
        (0, vitest_1.expect)(contractId).toBeDefined();
    }, 120_000);
    (0, vitest_1.it)("initializes the escrow contract", async () => {
        if (!contractId)
            return;
        const account = await sorobanServer.getAccount(deployerKp.publicKey());
        const tx = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "initialize",
                args: [
                    (0, stellar_sdk_1.nativeToScVal)(deployerKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(recipientKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(10n, { type: "i128" }),
                ],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await (0, vitest_1.expect)(sendTx(sorobanServer, tx)).resolves.toBeDefined();
    }, 60_000);
    (0, vitest_1.it)("releases funds and confirms recipient balance increased", async () => {
        if (!contractId)
            return;
        const balanceBefore = await axios_1.default
            .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
            .then((r) => {
            const xlm = r.data.balances.find((b) => b.asset_type === "native");
            return parseFloat(xlm?.balance ?? "0");
        });
        const account = await sorobanServer.getAccount(deployerKp.publicKey());
        const tx = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "release",
                args: [],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await (0, vitest_1.expect)(sendTx(sorobanServer, tx)).resolves.toBeDefined();
        const balanceAfter = await axios_1.default
            .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
            .then((r) => {
            const xlm = r.data.balances.find((b) => b.asset_type === "native");
            return parseFloat(xlm?.balance ?? "0");
        });
        (0, vitest_1.expect)(balanceAfter).toBeGreaterThan(balanceBefore);
    }, 60_000);
    (0, vitest_1.it)("full lifecycle: initialize then release by arbiter", async () => {
        if (!contractId)
            return;
        const arbiterKp = stellar_sdk_1.Keypair.random();
        await friendbot(arbiterKp.publicKey());
        await new Promise((r) => setTimeout(r, 2000));
        const balanceBefore = await axios_1.default
            .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
            .then((r) => {
            const xlm = r.data.balances.find((b) => b.asset_type === "native");
            return parseFloat(xlm?.balance ?? "0");
        });
        const account = await sorobanServer.getAccount(deployerKp.publicKey());
        const initTx = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "initialize",
                args: [
                    (0, stellar_sdk_1.nativeToScVal)(arbiterKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(recipientKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(5n, { type: "i128" }),
                ],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await sendTx(sorobanServer, initTx);
        const account2 = await sorobanServer.getAccount(arbiterKp.publicKey());
        const releaseTx = new stellar_sdk_1.TransactionBuilder(account2, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "release",
                args: [],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await (0, vitest_1.expect)(sendTx(sorobanServer, releaseTx)).resolves.toBeDefined();
        const balanceAfter = await axios_1.default
            .get(`${HORIZON_URL}/accounts/${recipientKp.publicKey()}`)
            .then((r) => {
            const xlm = r.data.balances.find((b) => b.asset_type === "native");
            return parseFloat(xlm?.balance ?? "0");
        });
        (0, vitest_1.expect)(balanceAfter).toBeGreaterThan(balanceBefore);
    }, 120_000);
    (0, vitest_1.it)("full lifecycle: initialize then refund by depositor after expiry", async () => {
        if (!contractId)
            return;
        const refundKp = stellar_sdk_1.Keypair.random();
        await friendbot(refundKp.publicKey());
        await new Promise((r) => setTimeout(r, 2000));
        const balanceBefore = await axios_1.default
            .get(`${HORIZON_URL}/accounts/${refundKp.publicKey()}`)
            .then((r) => {
            const xlm = r.data.balances.find((b) => b.asset_type === "native");
            return parseFloat(xlm?.balance ?? "0");
        });
        const account = await sorobanServer.getAccount(refundKp.publicKey());
        const initTx = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "initialize",
                args: [
                    (0, stellar_sdk_1.nativeToScVal)(refundKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(recipientKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(3n, { type: "i128" }),
                ],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await sendTx(sorobanServer, initTx);
        // Wait for expiry (simulating time passage)
        await new Promise((r) => setTimeout(r, 2000));
        const account2 = await sorobanServer.getAccount(refundKp.publicKey());
        const refundTx = new stellar_sdk_1.TransactionBuilder(account2, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "refund",
                args: [],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await (0, vitest_1.expect)(sendTx(sorobanServer, refundTx)).resolves.toBeDefined();
        const balanceAfter = await axios_1.default
            .get(`${HORIZON_URL}/accounts/${refundKp.publicKey()}`)
            .then((r) => {
            const xlm = r.data.balances.find((b) => b.asset_type === "native");
            return parseFloat(xlm?.balance ?? "0");
        });
        (0, vitest_1.expect)(balanceAfter).toBeGreaterThan(balanceBefore);
    }, 120_000);
    (0, vitest_1.it)("release fails when called by non-arbiter", async () => {
        if (!contractId)
            return;
        const nonArbiterKp = stellar_sdk_1.Keypair.random();
        await friendbot(nonArbiterKp.publicKey());
        await new Promise((r) => setTimeout(r, 2000));
        const account = await sorobanServer.getAccount(deployerKp.publicKey());
        const initTx = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "initialize",
                args: [
                    (0, stellar_sdk_1.nativeToScVal)(deployerKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(recipientKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(2n, { type: "i128" }),
                ],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await sendTx(sorobanServer, initTx);
        const account2 = await sorobanServer.getAccount(nonArbiterKp.publicKey());
        const releaseTx = new stellar_sdk_1.TransactionBuilder(account2, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "release",
                args: [],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await (0, vitest_1.expect)(sendTx(sorobanServer, releaseTx)).rejects.toThrow();
    }, 120_000);
    (0, vitest_1.it)("refund fails before expiry", async () => {
        if (!contractId)
            return;
        const depositorKp = stellar_sdk_1.Keypair.random();
        await friendbot(depositorKp.publicKey());
        await new Promise((r) => setTimeout(r, 2000));
        const account = await sorobanServer.getAccount(depositorKp.publicKey());
        const initTx = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "initialize",
                args: [
                    (0, stellar_sdk_1.nativeToScVal)(depositorKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(recipientKp.publicKey(), { type: "address" }),
                    (0, stellar_sdk_1.nativeToScVal)(4n, { type: "i128" }),
                ],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await sendTx(sorobanServer, initTx);
        // Attempt to refund before expiry
        const account2 = await sorobanServer.getAccount(depositorKp.publicKey());
        const refundTx = new stellar_sdk_1.TransactionBuilder(account2, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
        // @ts-expect-error — xdr low-level API
        stellar_sdk_1.xdr.Operation.invokeHostFunction({
            hostFunction: stellar_sdk_1.xdr.HostFunction.hostFunctionTypeInvokeContract(new stellar_sdk_1.xdr.InvokeContractArgs({
                contractAddress: stellar_sdk_1.Address.fromString(contractId).toScAddress(),
                functionName: "refund",
                args: [],
            })),
            auth: [],
        }))
            .setTimeout(30)
            .build();
        await (0, vitest_1.expect)(sendTx(sorobanServer, refundTx)).rejects.toThrow();
    }, 120_000);
});
//# sourceMappingURL=escrow_flow.test.js.map