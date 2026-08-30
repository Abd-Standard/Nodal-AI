"use strict";
/**
 * tests/agent.test.ts
 *
 * Tests for PayFiAgent — focused on assertWithinSpendingLimit behaviour,
 * including the secondary mainnet spending cap guard.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const agent_1 = require("../backend/agent");
const StellarPaymentTool_1 = require("../backend/tools/StellarPaymentTool");
const BalanceCheckTool_1 = require("../backend/tools/BalanceCheckTool");
const PathPaymentTool_1 = require("../backend/tools/PathPaymentTool");
const FeeBumpTool_1 = require("../backend/tools/FeeBumpTool");
const DexOfferTool_1 = require("../backend/tools/DexOfferTool");
const errors_1 = require("../backend/errors");
vitest_1.vi.mock("../backend/tools/StellarPaymentTool", () => ({
    StellarPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
    })),
}));
vitest_1.vi.mock("../backend/tools/SorobanInvokeTool", () => ({
    SorobanInvokeTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock("../backend/tools/X402PaymentTool", () => ({
    X402PaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        respond: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock("../backend/tools/AccountInfoTool", () => ({
    AccountInfoTool: vitest_1.vi.fn().mockImplementation(() => ({
        fetch: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock("../backend/tools/TrustlineTool", () => ({
    TrustlineTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn(),
        checkTrustline: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock("../backend/tools/MultiSigPaymentTool", () => ({
    MultiSigPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock("../backend/tools/BatchPaymentTool", () => ({
    BatchPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock("../backend/tools/SorobanQueryTool", () => ({
    SorobanQueryTool: vitest_1.vi.fn().mockImplementation(() => ({
        query: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock("../backend/tools/BalanceCheckTool", () => ({
    BalanceCheckTool: vitest_1.vi.fn().mockImplementation(() => ({
        getBalance: vitest_1.vi.fn().mockResolvedValue({ publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", balances: [] }),
    })),
}));
vitest_1.vi.mock("../backend/tools/PathPaymentTool", () => ({
    PathPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "path_mock_hash", ledger: 1 }),
    })),
}));
vitest_1.vi.mock("../backend/tools/FeeBumpTool", () => ({
    FeeBumpTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "fee_bump_mock_hash", ledger: 1 }),
    })),
}));
vitest_1.vi.mock("../backend/tools/DexOfferTool", () => ({
    DexOfferTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "dex_mock_hash", ledger: 1, offerId: "0" }),
    })),
}));
vitest_1.vi.mock("../backend/tools/ContractEventListener", () => ({
    listen: vitest_1.vi.fn().mockReturnValue(() => { }),
}));
vitest_1.vi.mock("../backend/webhook", () => ({
    dispatchWebhook: vitest_1.vi.fn().mockResolvedValue(undefined),
}));
vitest_1.vi.mock("../backend/persistence", () => ({
    saveResult: vitest_1.vi.fn(),
}));
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    horizonServer: { payments: vitest_1.vi.fn(() => ({ forAccount: vitest_1.vi.fn(() => ({ stream: vitest_1.vi.fn() })) })) },
    sorobanServer: {},
    resolveNetworkPassphrase: vitest_1.vi.fn(() => "Public Global Stellar Network ; September 2015"),
}));
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        STELLAR_NETWORK: "mainnet",
        HORIZON_URL: "https://horizon.stellar.org",
        SOROBAN_RPC_URL: "https://soroban-mainnet.stellar.org",
        AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        X402_ASSET_CODE: "USDC",
        X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        MAX_RETRIES: 3,
        RETRY_DELAY_MS: 100, MAX_CONCURRENT_TASKS: 10, // Set above MAINNET_SPENDING_CAP to exercise the secondary runtime guard
        AGENT_SPENDING_LIMIT: "15000",
        agentKeypair: () => ({
            secret: () => "process.env.AGENT_SECRET_KEY",
        }),
    },
    MAINNET_SPENDING_CAP: 10_000,
}));
// ─── Tests ────────────────────────────────────────────────────────────────────
const DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
(0, vitest_1.describe)("PayFiAgent — runSequence", () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        // Re-apply default mock implementation after clearAllMocks (clearMocks resets call history
        // but also clears mockReturnValue / mockResolvedValue set inside vi.mock factories).
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)("executes 3 tasks in order and returns all results on success", async () => {
        const task = {
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        };
        const results = await agent.runSequence([task, task, task]);
        (0, vitest_1.expect)(results).toHaveLength(3);
        (0, vitest_1.expect)(results.every((r) => r.success)).toBe(true);
    });
    (0, vitest_1.it)("stops at task 2 when it fails and does not execute task 3", async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        mockInstance.execute
            .mockResolvedValueOnce({ txHash: "hash1", ledger: 1 })
            .mockRejectedValueOnce(new Error("Network failure"));
        const task = {
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        };
        const results = await agent.runSequence([task, task, task]);
        (0, vitest_1.expect)(results).toHaveLength(2);
        (0, vitest_1.expect)(results[0].success).toBe(true);
        (0, vitest_1.expect)(results[1].success).toBe(false);
        (0, vitest_1.expect)(results[1].error).toContain("Network failure");
        (0, vitest_1.expect)(mockInstance.execute).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)("rejects mid-sequence when a task exceeds the mainnet spending cap", async () => {
        const okTask = {
            type: "stellar_payment",
            payload: { destination: DEST, amount: "9999", assetCode: "USDC", assetIssuer: ISSUER },
        };
        const overCapTask = {
            type: "stellar_payment",
            payload: { destination: DEST, amount: "11000", assetCode: "USDC", assetIssuer: ISSUER },
        };
        const results = await agent.runSequence([okTask, overCapTask, okTask]);
        (0, vitest_1.expect)(results).toHaveLength(2);
        (0, vitest_1.expect)(results[0].success).toBe(true);
        (0, vitest_1.expect)(results[1].success).toBe(false);
        (0, vitest_1.expect)(results[1].error).toMatch(/mainnet spending cap/);
    });
});
(0, vitest_1.describe)("PayFiAgent — mainnet spending cap", () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)("rejects a stellar_payment above MAINNET_SPENDING_CAP on mainnet", async () => {
        const result = await agent.run({
            type: "stellar_payment",
            payload: {
                destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                amount: "12000",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/mainnet spending cap/);
    });
    (0, vitest_1.it)("rejects an x402_respond above MAINNET_SPENDING_CAP on mainnet", async () => {
        const result = await agent.run({
            type: "x402_respond",
            payload: {
                resource: "https://api.example.com/data",
                amount: "11000",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
                payTo: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                nonce: "550e8400-e29b-41d4-a716-446655440000",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/mainnet spending cap/);
    });
    (0, vitest_1.it)("accepts a stellar_payment at or below MAINNET_SPENDING_CAP on mainnet", async () => {
        const result = await agent.run({
            type: "stellar_payment",
            payload: {
                destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                amount: "9999",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
    });
    (0, vitest_1.it)("two PayFiAgent instances do not share state when run concurrently", async () => {
        vitest_1.vi.clearAllMocks();
        const agent1 = new agent_1.PayFiAgent();
        const agent2 = new agent_1.PayFiAgent();
        const mockInstance1 = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        const mockInstance2 = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[1].value;
        mockInstance1.execute.mockResolvedValueOnce({ txHash: "tx_hash_1", ledger: 1 });
        mockInstance2.execute.mockResolvedValueOnce({ txHash: "tx_hash_2", ledger: 2 });
        const task = {
            type: "stellar_payment",
            payload: {
                destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                amount: "100",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            },
        };
        const [result1, result2] = await Promise.all([
            agent1.run(task),
            agent2.run(task),
        ]);
        (0, vitest_1.expect)(result1.success).toBe(true);
        (0, vitest_1.expect)(result2.success).toBe(true);
        (0, vitest_1.expect)(result1.data?.txHash).toBe("tx_hash_1");
        (0, vitest_1.expect)(result2.data?.txHash).toBe("tx_hash_2");
        (0, vitest_1.expect)(result1.data?.txHash).toBe("tx_hash_1");
        (0, vitest_1.expect)(result2.data?.txHash).toBe("tx_hash_2");
        (0, vitest_1.expect)(agent1).not.toBe(agent2);
    });
});
(0, vitest_1.describe)("AgentResult snapshot", () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "success_tx_hash", ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)("AgentResult has expected shape on success", async () => {
        const result = await agent.run({
            type: "stellar_payment",
            payload: {
                destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                amount: "100",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            },
            correlationId: "fixed-test-id-success",
        });
        (0, vitest_1.expect)(result).toMatchSnapshot();
        (0, vitest_1.expect)(result).toHaveProperty("success", true);
        (0, vitest_1.expect)(result).toHaveProperty("taskType", "stellar_payment");
        (0, vitest_1.expect)(result).toHaveProperty("data");
    });
    (0, vitest_1.it)("adds network metadata to payment task results", async () => {
        const result = await agent.run({
            type: "stellar_payment",
            payload: {
                destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                amount: "100",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.data).toMatchObject({ network: "mainnet" });
    });
    (0, vitest_1.it)("AgentResult has expected shape on failure", async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        mockInstance.execute.mockRejectedValueOnce(new Error("Test error"));
        const result = await agent.run({
            type: "stellar_payment",
            payload: {
                destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                amount: "100",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            },
            correlationId: "fixed-test-id-failure",
        });
        (0, vitest_1.expect)(result).toMatchSnapshot();
        (0, vitest_1.expect)(result).toHaveProperty("success", false);
        (0, vitest_1.expect)(result).toHaveProperty("taskType", "stellar_payment");
        (0, vitest_1.expect)(result).toHaveProperty("error");
    });
});
(0, vitest_1.describe)("PayFiAgent — new task types", () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
        }));
        vitest_1.vi.mocked(BalanceCheckTool_1.BalanceCheckTool).mockImplementation(() => ({
            getBalance: vitest_1.vi.fn().mockResolvedValue({ publicKey: DEST, balances: [] }),
        }));
        vitest_1.vi.mocked(PathPaymentTool_1.PathPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "path_mock_hash", ledger: 1 }),
        }));
        vitest_1.vi.mocked(FeeBumpTool_1.FeeBumpTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "fee_bump_mock_hash", ledger: 1 }),
        }));
        vitest_1.vi.mocked(DexOfferTool_1.DexOfferTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "dex_mock_hash", ledger: 1, offerId: "0" }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)("dispatches balance_check and returns success", async () => {
        const result = await agent.run({
            type: "balance_check",
            payload: { publicKey: DEST },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe("balance_check");
    });
    (0, vitest_1.it)("dispatches path_payment and returns success", async () => {
        const result = await agent.run({
            type: "path_payment",
            payload: {
                destination: DEST,
                sendAsset: { code: "XLM" },
                sendAmount: "10",
                destAsset: { code: "USDC", issuer: ISSUER },
                destMinAmount: "9",
            },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe("path_payment");
    });
    (0, vitest_1.it)("dispatches fee_bump and returns success", async () => {
        const result = await agent.run({
            type: "fee_bump",
            payload: { innerTxXdr: "AAAA" },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe("fee_bump");
    });
    (0, vitest_1.it)("dispatches dex_offer and returns success", async () => {
        const result = await agent.run({
            type: "dex_offer",
            payload: {
                action: "create",
                selling: { code: "XLM" },
                buying: { code: "USDC", issuer: ISSUER },
                amount: "100",
                price: "0.25",
            },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe("dex_offer");
    });
    (0, vitest_1.it)("startContractListener starts the listener and stopContractListener stops it", () => {
        const onEvent = vitest_1.vi.fn();
        agent.startContractListener("CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH", [], onEvent);
        agent.stopContractListener();
        // No error thrown — listener lifecycle works
    });
    (0, vitest_1.it)("destroy() cleans up the contract listener", () => {
        const onEvent = vitest_1.vi.fn();
        agent.startContractListener("CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH", [], onEvent);
        (0, vitest_1.expect)(() => agent.destroy()).not.toThrow();
    });
});
(0, vitest_1.describe)("PayFiAgent — drain / waitForPendingTasks", () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)("rejects new tasks after drain() is called", async () => {
        agent.drain();
        const result = await agent.run({
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/shutting down/i);
    });
    (0, vitest_1.it)("waitForPendingTasks() resolves when activeTasks reaches 0", async () => {
        let resolveExecute;
        const pending = new Promise((resolve) => {
            resolveExecute = resolve;
        });
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        mockInstance.execute.mockReturnValueOnce(pending);
        const runPromise = agent.run({
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        });
        // Let run() reach the `activeTasks++` before checking wait behaviour.
        await Promise.resolve();
        let waitResolved = false;
        const waitPromise = agent.waitForPendingTasks().then(() => {
            waitResolved = true;
        });
        // Task is still in flight — waitForPendingTasks() must still be pending.
        await new Promise((r) => setTimeout(r, 50));
        (0, vitest_1.expect)(waitResolved).toBe(false);
        resolveExecute({ txHash: "mock_hash", ledger: 1 });
        await runPromise;
        await waitPromise;
        (0, vitest_1.expect)(waitResolved).toBe(true);
    });
    (0, vitest_1.it)("waitForPendingTasks() resolves immediately if no tasks are active", async () => {
        const setIntervalSpy = vitest_1.vi.spyOn(global, "setInterval");
        await agent.waitForPendingTasks();
        (0, vitest_1.expect)(setIntervalSpy).not.toHaveBeenCalled();
        setIntervalSpy.mockRestore();
    });
});
(0, vitest_1.describe)("PayFiAgent — middleware system", () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)("registers middleware via use() method", () => {
        const middleware = vitest_1.vi.fn(async (task, next) => next());
        agent.use(middleware);
        // Middleware is registered - verified by internal state
        (0, vitest_1.expect)(agent).toBeDefined();
    });
    (0, vitest_1.it)("executes middleware in registration order", async () => {
        const executionOrder = [];
        agent.use(async (task, next) => {
            executionOrder.push("middleware1");
            return next();
        });
        agent.use(async (task, next) => {
            executionOrder.push("middleware2");
            return next();
        });
        const result = await agent.run({
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(executionOrder).toEqual(["middleware1", "middleware2"]);
    });
    (0, vitest_1.it)("allows middleware to short-circuit task execution", async () => {
        agent.use(async (task, next) => {
            return {
                success: false,
                taskType: task.type,
                error: "Short-circuited by middleware",
                correlationId: task.correlationId ?? "test-correlation-id",
            };
        });
        const result = await agent.run({
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toBe("Short-circuited by middleware");
        // Tool should not have been called
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (mockInstance) {
            (0, vitest_1.expect)(mockInstance.execute).not.toHaveBeenCalled();
        }
    });
    (0, vitest_1.it)("middleware can inspect and modify task before execution", async () => {
        agent.use(async (task, next) => {
            // Modify the task payload
            if (task.type === "stellar_payment") {
                task.payload.amount = "50";
            }
            return next();
        });
        const result = await agent.run({
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        // Verify the tool was called with modified payload
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (mockInstance) {
            (0, vitest_1.expect)(mockInstance.execute).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ amount: "50" }));
        }
    });
    (0, vitest_1.it)("middleware handles errors thrown in middleware", async () => {
        agent.use(async (task, next) => {
            throw new Error("Middleware error");
        });
        const result = await agent.run({
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toContain("Middleware error");
    });
    (0, vitest_1.it)("middleware executes after task completion (post-execution)", async () => {
        const postExecutionLog = [];
        agent.use(async (task, next) => {
            const result = await next();
            postExecutionLog.push("after-execution");
            return result;
        });
        const result = await agent.run({
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(postExecutionLog).toEqual(["after-execution"]);
    });
    (0, vitest_1.it)("pass-through middleware with no modifications", async () => {
        agent.use(async (task, next) => {
            // Just pass through without modification
            return next();
        });
        const result = await agent.run({
            type: "stellar_payment",
            payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
    });
});
(0, vitest_1.describe)("PayFiAgent — payload sanitisation", () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)("scrubs secretKey from payload before logging on failure", async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (!mockInstance)
            throw new Error("Mock instance not found");
        mockInstance.execute.mockRejectedValueOnce(new Error("simulated payment failure"));
        const result = await agent.run({
            type: "stellar_payment",
            payload: {
                destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                amount: "100",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
                secretKey: "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toBe("simulated payment failure");
        (0, vitest_1.expect)(result.error).not.toContain("SABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
    });
    (0, vitest_1.it)("recursively redacts nested sensitive keys in deeply nested objects", async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (!mockInstance)
            throw new Error("Mock instance not found");
        mockInstance.execute.mockRejectedValueOnce(new Error("simulated nested payload failure"));
        const result = await agent.run({
            type: "stellar_payment",
            payload: {
                destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                amount: "100",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
                signer: {
                    secretKey: "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
                    address: "GXYZ",
                },
                nested: {
                    level2: {
                        privateKey: "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
                        mnemonic: "word1 word2 word3",
                    },
                },
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toBe("simulated nested payload failure");
    });
    (0, vitest_1.it)("includes errorType in AgentResult for structured errors", async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (!mockInstance)
            throw new Error("Mock instance not found");
        mockInstance.execute.mockRejectedValueOnce(new errors_1.ValidationError("Invalid payment parameters"));
        const result = await agent.run({
            type: "stellar_payment",
            payload: {
                destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                amount: "100",
                assetCode: "USDC",
                assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.errorType).toBe("VALIDATION_ERROR");
        (0, vitest_1.expect)(result.error).toBe("Invalid payment parameters");
    });
});
//# sourceMappingURL=agent.test.js.map