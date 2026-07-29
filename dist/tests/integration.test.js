"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const agent_1 = require("../backend/agent");
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn().mockResolvedValue({
        id: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        accountId: () => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        sequenceNumber: () => "100",
        incrementSequenceNumber: vitest_1.vi.fn(),
        sequence: "100",
        incrementedSequenceNumber: () => "101",
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        balances: [{ asset_type: "native", balance: "10000.0000000" }],
        signers: [],
        data_attr: {},
        subentry_count: 0,
    }),
    submitTransaction: vitest_1.vi.fn().mockResolvedValue({ hash: "test_tx_hash_123456789", ledger: 1000 }),
    resolveNetworkPassphrase: vitest_1.vi.fn(() => "Test SDF Network ; September 2015"),
    horizonServer: {},
    sorobanServer: {
        sendTransaction: vitest_1.vi.fn(),
        getTransaction: vitest_1.vi.fn(),
    },
}));
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        STELLAR_NETWORK: "testnet",
        HORIZON_URL: "https://horizon-testnet.stellar.org",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        X402_ASSET_CODE: "USDC",
        X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        AGENT_SPENDING_LIMIT: "1000",
        MAX_RETRIES: 3,
        RETRY_DELAY_MS: 100,
        agentKeypair: () => ({
            publicKey: () => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            secret: () => "process.env.AGENT_SECRET_KEY",
        }),
    },
}));
(0, vitest_1.describe)("PayFiAgent integration", () => {
    (0, vitest_1.it)("constructs PayFiAgent successfully", () => {
        const agent = new agent_1.PayFiAgent();
        (0, vitest_1.expect)(agent).toBeDefined();
    });
});
//# sourceMappingURL=integration.test.js.map