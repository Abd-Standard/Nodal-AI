"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const SorobanQueryTool_1 = require("../backend/tools/SorobanQueryTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
vitest_1.vi.mock('../backend/rpc_client', () => ({
    loadAccount: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
    resolveNetworkPassphrase: vitest_1.vi.fn(() => 'Test SDF Network ; September 2015'),
    horizonServer: { sendTransaction: vitest_1.vi.fn(), getTransaction: vitest_1.vi.fn() },
    sorobanServer: { sendTransaction: vitest_1.vi.fn(), getTransaction: vitest_1.vi.fn() },
}));
vitest_1.vi.mock('../backend/config', () => {
    const { Keypair } = require('@stellar/stellar-sdk');
    const secret = 'SBZ7EYXHNB4WPPIWC5YAMH2' + 'U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73';
    return {
        config: {
            STELLAR_NETWORK: 'testnet',
            AGENT_SECRET_KEY: secret,
            AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
            agentKeypair: () => Keypair.fromSecret(secret),
        },
    };
});
const VALID_CONTRACT = 'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH';
function makeMockAccount(publicKey) {
    return {
        id: publicKey,
        accountId: () => publicKey,
        sequenceNumber: () => '100',
        incrementSequenceNumber: vitest_1.vi.fn(),
        sequence: '100',
        incrementedSequenceNumber: () => '101',
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        balances: [],
        signers: [],
        data_attr: {},
        subentry_count: 0,
    };
}
(0, vitest_1.describe)('SorobanQueryTool', () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new SorobanQueryTool_1.SorobanQueryTool();
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'));
    });
    (0, vitest_1.it)('calls prepareSorobanTx for valid input', async () => {
        vitest_1.vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue({});
        await tool.query({ contractId: VALID_CONTRACT, method: 'get_state', args: [] });
        (0, vitest_1.expect)(rpcClient.prepareSorobanTx).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)('rejects invalid contractId', async () => {
        await (0, vitest_1.expect)(tool.query({ contractId: 'BAD', method: 'get_state', args: [] })).rejects.toThrow(/Invalid Stellar contract ID/);
    });
    (0, vitest_1.it)('rejects empty method name', async () => {
        await (0, vitest_1.expect)(tool.query({ contractId: VALID_CONTRACT, method: '', args: [] })).rejects.toThrow();
    });
});
//# sourceMappingURL=soroban_query.test.js.map