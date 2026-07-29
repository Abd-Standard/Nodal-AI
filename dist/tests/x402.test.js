"use strict";
/**
 * tests/x402.test.ts
 *
 * Comprehensive test suite for X402PaymentTool.
 * Covers: valid flow, schema validation, expiry, edge cases,
 * network failures during payment, and proof structure integrity.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const crypto_1 = require("crypto");
const X402PaymentTool_1 = require("../backend/tools/X402PaymentTool");
const StellarPaymentTool_1 = require("../backend/tools/StellarPaymentTool");
const config_1 = require("../backend/config");
const rpc_client_1 = require("../backend/rpc_client");
// ─── Mock rpc_client so horizonServer.ledgers() is interceptable ──────────────
vitest_1.vi.mock("../backend/rpc_client", () => ({
    horizonServer: {
        ledgers: vitest_1.vi.fn().mockReturnValue({
            ledger: vitest_1.vi.fn().mockReturnValue({
                call: vitest_1.vi.fn().mockResolvedValue({ closed_at: "2024-01-01T00:00:00Z" }),
            }),
        }),
        transactions: vitest_1.vi.fn().mockReturnValue({
            transaction: vitest_1.vi.fn().mockReturnValue({
                call: vitest_1.vi.fn().mockResolvedValue({ memo: "" }),
            }),
        }),
        operations: vitest_1.vi.fn().mockReturnValue({
            forTransaction: vitest_1.vi.fn().mockReturnValue({
                call: vitest_1.vi.fn().mockResolvedValue({ records: [] }),
            }),
        }),
    },
}));
// ─── Mock StellarPaymentTool so x402 tests don't hit Horizon ─────────────────
vitest_1.vi.mock("../backend/tools/StellarPaymentTool");
vitest_1.vi.mock("../backend/config", () => {
    const { Keypair } = require("@stellar/stellar-sdk"); // eslint-disable-line @typescript-eslint/no-var-requires
    const secret = "process.env.AGENT_SECRET_KEY";
    return {
        config: {
            STELLAR_NETWORK: "testnet",
            HORIZON_URL: "https://horizon-testnet.stellar.org",
            SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
            AGENT_SECRET_KEY: secret,
            AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
            agentKeypair: () => Keypair.fromSecret(secret),
            X402_ASSET_CODE: "USDC",
            X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            MAX_RETRIES: 3,
            RETRY_DELAY_MS: 100,
            MAX_X402_PAYMENTS_PER_MINUTE: 10,
            MAX_SOROBAN_FEE_STROOPS: 1_000_000,
            ALLOWED_X402_ORIGINS: undefined,
        },
    };
});
// ─── Fixtures ─────────────────────────────────────────────────────────────────
const TEST_SECRET = "process.env.AGENT_SECRET_KEY";
const VALID_PAY_TO = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const VALID_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
function futureIso(offsetMs = 60_000) {
    return new Date(Date.now() + offsetMs).toISOString();
}
const VALID_CHALLENGE = {
    resource: "https://api.example.com/data",
    amount: "1.5000000",
    assetCode: "USDC",
    assetIssuer: VALID_ISSUER,
    payTo: VALID_PAY_TO,
    nonce: "550e8400-e29b-41d4-a716-446655440000",
    expiresAt: futureIso(),
};
// ─── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("X402PaymentTool", () => {
    let tool;
    let mockPaymentTool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        mockPaymentTool = {
            publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: "x402_mock_tx_hash", ledger: 99 }),
        };
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => mockPaymentTool);
        tool = new X402PaymentTool_1.X402PaymentTool(TEST_SECRET);
    });
    // ── Schema validation ───────────────────────────────────────────────────────
    (0, vitest_1.describe)("Schema validation", () => {
        (0, vitest_1.it)("rejects a challenge with a missing nonce", async () => {
            const { nonce: _omit, ...noNonce } = VALID_CHALLENGE;
            await (0, vitest_1.expect)(tool.respond(noNonce)).rejects.toThrow();
        });
        (0, vitest_1.it)("rejects a non-UUID nonce", async () => {
            await (0, vitest_1.expect)(tool.respond({ ...VALID_CHALLENGE, nonce: "not-a-uuid" })).rejects.toThrow(/UUID/);
        });
        (0, vitest_1.it)("rejects a challenge where payTo is the agent's own address", async () => {
            const agentPublicKey = stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey();
            await (0, vitest_1.expect)(tool.respond({ ...VALID_CHALLENGE, payTo: agentPublicKey })).rejects.toThrow("Payment destination cannot be the agent's own address");
        });
        (0, vitest_1.it)("rejects USDC payment when assetIssuer is empty", async () => {
            await (0, vitest_1.expect)(tool.respond({ ...VALID_CHALLENGE, assetCode: "USDC", assetIssuer: "" })).rejects.toThrow("assetIssuer is required for non-XLM payments");
        });
        (0, vitest_1.it)("accepts XLM payment without assetIssuer", async () => {
            const proof = await tool.respond({ ...VALID_CHALLENGE, assetCode: "XLM", assetIssuer: "" });
            (0, vitest_1.expect)(proof.txHash).toBeTruthy();
        });
        (0, vitest_1.it)("rejects a missing resource URL", async () => {
            const { resource: _omit, ...noResource } = VALID_CHALLENGE;
            await (0, vitest_1.expect)(tool.respond(noResource)).rejects.toThrow();
        });
        (0, vitest_1.it)("rejects a non-URL resource field", async () => {
            await (0, vitest_1.expect)(tool.respond({ ...VALID_CHALLENGE, resource: "not-a-url" })).rejects.toThrow(/URL/);
        });
        (0, vitest_1.it)("rejects a payTo address that is too short", async () => {
            await (0, vitest_1.expect)(tool.respond({ ...VALID_CHALLENGE, payTo: "GBBD47" })).rejects.toThrow(/Stellar address/);
        });
        (0, vitest_1.it)("rejects missing expiresAt field", async () => {
            const { expiresAt: _omit, ...noExpiry } = VALID_CHALLENGE;
            await (0, vitest_1.expect)(tool.respond(noExpiry)).rejects.toThrow();
        });
        (0, vitest_1.it)("rejects an expiresAt that is not a valid ISO datetime", async () => {
            await (0, vitest_1.expect)(tool.respond({ ...VALID_CHALLENGE, expiresAt: "not-a-date" })).rejects.toThrow();
        });
        (0, vitest_1.it)("rejects a completely empty object", async () => {
            await (0, vitest_1.expect)(tool.respond({})).rejects.toThrow();
        });
        (0, vitest_1.it)("rejects null input", async () => {
            await (0, vitest_1.expect)(tool.respond(null)).rejects.toThrow();
        });
    });
    // ── Expiry guard ─────────────────────────────────────────────────────────────
    (0, vitest_1.describe)("Expiry guard", () => {
        (0, vitest_1.it)("rejects a challenge expired 1 ms ago", async () => {
            await (0, vitest_1.expect)(tool.respond({ ...VALID_CHALLENGE, expiresAt: new Date(Date.now() - 1).toISOString() })).rejects.toThrow(/expired/);
        });
        (0, vitest_1.it)("rejects a challenge expired 1 hour ago", async () => {
            await (0, vitest_1.expect)(tool.respond({ ...VALID_CHALLENGE, expiresAt: new Date(Date.now() - 3_600_000).toISOString() })).rejects.toThrow(/expired/);
        });
        (0, vitest_1.it)("accepts a challenge expiring 1 ms from now", async () => {
            vitest_1.vi.useFakeTimers();
            const now = Date.now();
            const proof = await tool.respond({
                ...VALID_CHALLENGE,
                nonce: "770e8400-e29b-41d4-a716-446655440099",
                expiresAt: new Date(now + 1).toISOString(),
            });
            (0, vitest_1.expect)(proof.txHash).toBeTruthy();
            vitest_1.vi.useRealTimers();
        });
    });
    // ── Rate limiting ────────────────────────────────────────────────────────────
    (0, vitest_1.describe)("Rate limiting", () => {
        function uniqueNonce(i) {
            return `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        }
        (0, vitest_1.it)("allows up to MAX_X402_PAYMENTS_PER_MINUTE calls within the window", async () => {
            for (let i = 0; i < 10; i++) {
                const proof = await tool.respond({ ...VALID_CHALLENGE, nonce: uniqueNonce(i) });
                (0, vitest_1.expect)(proof.txHash).toBe("x402_mock_tx_hash");
            }
            (0, vitest_1.expect)(mockPaymentTool.execute).toHaveBeenCalledTimes(10);
        });
        (0, vitest_1.it)("throws on the 11th call within the same 60s window", async () => {
            for (let i = 0; i < 10; i++) {
                await tool.respond({ ...VALID_CHALLENGE, nonce: uniqueNonce(i) });
            }
            await (0, vitest_1.expect)(tool.respond({ ...VALID_CHALLENGE, nonce: uniqueNonce(10) })).rejects.toThrow("x402: rate limit exceeded");
        });
        (0, vitest_1.it)("resets the counter after 60s window elapses", async () => {
            vitest_1.vi.useFakeTimers();
            const startTime = Date.now();
            const farFutureExpiry = new Date(startTime + 180_000).toISOString();
            const challenge = { ...VALID_CHALLENGE, expiresAt: farFutureExpiry };
            for (let i = 0; i < 10; i++) {
                await tool.respond({ ...challenge, nonce: uniqueNonce(i) });
            }
            await (0, vitest_1.expect)(tool.respond({ ...challenge, nonce: uniqueNonce(10) })).rejects.toThrow("rate limit exceeded");
            vitest_1.vi.setSystemTime(startTime + 60_001);
            const proof = await tool.respond({ ...challenge, nonce: uniqueNonce(11) });
            (0, vitest_1.expect)(proof.txHash).toBe("x402_mock_tx_hash");
            vitest_1.vi.useRealTimers();
        });
    });
    (0, vitest_1.describe)("ALLOWED_X402_ORIGINS validation", () => {
        (0, vitest_1.it)("accepts a challenge from a trusted origin", async () => {
            config_1.config.ALLOWED_X402_ORIGINS = "api.example.com, other.com";
            const proof = await tool.respond(VALID_CHALLENGE);
            (0, vitest_1.expect)(proof.txHash).toBe("x402_mock_tx_hash");
        });
        (0, vitest_1.it)("rejects a challenge from an untrusted origin", async () => {
            config_1.config.ALLOWED_X402_ORIGINS = "trusted.com";
            await (0, vitest_1.expect)(tool.respond(VALID_CHALLENGE)).rejects.toThrow("x402: untrusted resource origin");
        });
        (0, vitest_1.it)("disables wildcard (*) bypass", async () => {
            config_1.config.ALLOWED_X402_ORIGINS = "*";
            await (0, vitest_1.expect)(tool.respond(VALID_CHALLENGE)).rejects.toThrow("x402: untrusted resource origin");
        });
        (0, vitest_1.afterEach)(() => {
            config_1.config.ALLOWED_X402_ORIGINS = undefined;
        });
    });
    // ── Happy path ──────────────────────────────────────────────────────────────
    (0, vitest_1.describe)("Happy path", () => {
        (0, vitest_1.it)("returns a valid x402 payment proof structure", async () => {
            const proof = await tool.respond(VALID_CHALLENGE);
            (0, vitest_1.expect)(proof.protocol).toBe("x402");
            (0, vitest_1.expect)(proof.network).toBe("testnet");
            (0, vitest_1.expect)(proof.txHash).toBe("x402_mock_tx_hash");
            (0, vitest_1.expect)(proof.nonce).toBe(VALID_CHALLENGE.nonce);
            (0, vitest_1.expect)(proof.payer).toMatch(/^G[A-Z2-7]{55}$/);
            // signedAt is either ledger close time or wall-clock fallback — both are valid ISO strings
            (0, vitest_1.expect)(proof.signedAt).toBeTruthy();
            (0, vitest_1.expect)(() => new Date(proof.signedAt)).not.toThrow();
            (0, vitest_1.expect)(new Date(proof.signedAt).toISOString()).toBe(proof.signedAt);
        });
        (0, vitest_1.it)("embeds nonce in memo as SHA-256 fingerprint (28 hex chars)", async () => {
            await tool.respond(VALID_CHALLENGE);
            const callArg = mockPaymentTool.execute.mock.calls[0][0];
            const expectedMemo = (0, stellar_sdk_1.hash)(Buffer.from(VALID_CHALLENGE.nonce)).toString("hex").slice(0, 28);
            (0, vitest_1.expect)(callArg.memo).toBe(expectedMemo);
            (0, vitest_1.expect)(callArg.memo.length).toBe(28);
        });
        (0, vitest_1.it)("delegates to StellarPaymentTool with correct destination and amount", async () => {
            await tool.respond(VALID_CHALLENGE);
            (0, vitest_1.expect)(mockPaymentTool.execute).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                destination: VALID_CHALLENGE.payTo,
                amount: VALID_CHALLENGE.amount,
                assetCode: VALID_CHALLENGE.assetCode,
                assetIssuer: VALID_CHALLENGE.assetIssuer,
            }));
        });
        (0, vitest_1.it)("omits assetIssuer for XLM payments", async () => {
            await tool.respond({ ...VALID_CHALLENGE, assetCode: "XLM" });
            const callArg = mockPaymentTool.execute.mock.calls[0][0];
            (0, vitest_1.expect)(callArg.assetIssuer).toBeUndefined();
        });
        (0, vitest_1.it)("calls StellarPaymentTool.execute exactly once per challenge", async () => {
            await tool.respond(VALID_CHALLENGE);
            (0, vitest_1.expect)(mockPaymentTool.execute).toHaveBeenCalledOnce();
        });
    });
    // ── Payment failure propagation ─────────────────────────────────────────────
    (0, vitest_1.describe)("Payment failure propagation", () => {
        function getMockExecute() {
            return mockPaymentTool.execute;
        }
        (0, vitest_1.it)("propagates insufficient funds from underlying payment", async () => {
            getMockExecute().mockRejectedValueOnce(new Error("Horizon: op_underfunded — insufficient balance"));
            await (0, vitest_1.expect)(tool.respond(VALID_CHALLENGE)).rejects.toThrow(/underfunded/);
        });
        (0, vitest_1.it)("propagates network timeout from underlying payment", async () => {
            getMockExecute().mockRejectedValueOnce(new Error("ECONNABORTED: network timeout"));
            await (0, vitest_1.expect)(tool.respond(VALID_CHALLENGE)).rejects.toThrow(/timeout/);
        });
        (0, vitest_1.it)("propagates trust line missing error", async () => {
            getMockExecute().mockRejectedValueOnce(new Error("Horizon: op_no_trust — recipient missing trust line for USDC"));
            await (0, vitest_1.expect)(tool.respond(VALID_CHALLENGE)).rejects.toThrow(/no_trust/);
        });
    });
    // ── Nonce replay protection ─────────────────────────────────────────────────
    (0, vitest_1.describe)("Nonce replay protection", () => {
        (0, vitest_1.it)("first use with a given nonce succeeds", async () => {
            await (0, vitest_1.expect)(tool.respond(VALID_CHALLENGE)).resolves.toHaveProperty("nonce", VALID_CHALLENGE.nonce);
        });
        (0, vitest_1.it)("second use with the same nonce throws", async () => {
            await tool.respond(VALID_CHALLENGE);
            await (0, vitest_1.expect)(tool.respond(VALID_CHALLENGE)).rejects.toThrow("x402: nonce already used");
        });
        (0, vitest_1.it)("allows a different nonce after a previous one was consumed", async () => {
            await tool.respond(VALID_CHALLENGE);
            const second = { ...VALID_CHALLENGE, nonce: "660e8400-e29b-41d4-a716-446655440001" };
            await (0, vitest_1.expect)(tool.respond(second)).resolves.toHaveProperty("nonce", second.nonce);
        });
    });
    // ── X402PaymentProof snapshot ──────────────────────────────────────────────
    (0, vitest_1.describe)("X402PaymentProof snapshot", () => {
        (0, vitest_1.it)("X402PaymentProof has expected shape and fields", async () => {
            // Pin the clock so signedAt is deterministic across runs
            vitest_1.vi.useFakeTimers();
            vitest_1.vi.setSystemTime(new Date("2026-06-25T12:00:19.497Z"));
            vitest_1.vi.useFakeTimers();
            vitest_1.vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
            const proof = await tool.respond(VALID_CHALLENGE);
            vitest_1.vi.useRealTimers();
            // signedAt changes every run so we verify structure rather than snapshot
            (0, vitest_1.expect)(proof).toMatchObject({
                protocol: "x402",
                network: vitest_1.expect.any(String),
                txHash: vitest_1.expect.any(String),
                nonce: vitest_1.expect.any(String),
                payer: vitest_1.expect.any(String),
                signedAt: vitest_1.expect.any(String),
            });
            (0, vitest_1.expect)(proof).toHaveProperty("protocol", "x402");
            (0, vitest_1.expect)(proof).toHaveProperty("network");
            (0, vitest_1.expect)(proof).toHaveProperty("txHash");
            (0, vitest_1.expect)(proof).toHaveProperty("nonce");
            (0, vitest_1.expect)(proof).toHaveProperty("payer");
            (0, vitest_1.expect)(proof).toHaveProperty("signedAt");
            vitest_1.vi.useRealTimers();
        });
    });
    // ── verify() ──────────────────────────────────────────────────────────────
    (0, vitest_1.describe)("verify()", () => {
        const NONCE = "550e8400-e29b-41d4-a716-446655440000";
        const EXPECTED_MEMO = (0, crypto_1.createHash)("sha256").update(NONCE).digest("hex").slice(0, 28);
        function getHorizonMock() {
            return vitest_1.vi.mocked(rpc_client_1.horizonServer);
        }
        function setupValidMocks() {
            const horizon = getHorizonMock();
            horizon.transactions.mockReturnValue({
                transaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({ memo: EXPECTED_MEMO }),
                }),
            });
            horizon.operations.mockReturnValue({
                forTransaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({
                        records: [
                            {
                                to: VALID_PAY_TO,
                                amount: "1.5000000",
                                asset_code: "USDC",
                                from: stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey(),
                            },
                        ],
                    }),
                }),
            });
        }
        const VALID_PROOF = {
            protocol: "x402",
            network: "testnet",
            txHash: "abc123",
            nonce: NONCE,
            payer: stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey(),
            signedAt: new Date().toISOString(),
        };
        (0, vitest_1.it)("passes for a valid proof and matching challenge", async () => {
            setupValidMocks();
            await (0, vitest_1.expect)(tool.verify(VALID_PROOF, VALID_CHALLENGE)).resolves.toBeUndefined();
        });
        (0, vitest_1.it)("throws when destination does not match originalChallenge.payTo", async () => {
            setupValidMocks();
            const badChallenge = { ...VALID_CHALLENGE, payTo: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };
            // Override mock to return a different destination
            const horizon = getHorizonMock();
            horizon.operations.mockReturnValue({
                forTransaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({
                        records: [
                            {
                                to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                                amount: "1.5000000",
                                asset_code: "USDC",
                                from: stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey(),
                            },
                        ],
                    }),
                }),
            });
            await (0, vitest_1.expect)(tool.verify(VALID_PROOF, badChallenge)).rejects.toThrow("destination mismatch");
        });
        (0, vitest_1.it)("throws when amount does not match", async () => {
            setupValidMocks();
            const horizon = getHorizonMock();
            horizon.operations.mockReturnValue({
                forTransaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({
                        records: [
                            {
                                to: VALID_PAY_TO,
                                amount: "99.0000000",
                                asset_code: "USDC",
                                from: stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey(),
                            },
                        ],
                    }),
                }),
            });
            await (0, vitest_1.expect)(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow("amount mismatch");
        });
        (0, vitest_1.it)("throws when assetCode does not match", async () => {
            setupValidMocks();
            const horizon = getHorizonMock();
            horizon.operations.mockReturnValue({
                forTransaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({
                        records: [
                            {
                                to: VALID_PAY_TO,
                                amount: "1.5000000",
                                asset_code: "XLM",
                                from: stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey(),
                            },
                        ],
                    }),
                }),
            });
            await (0, vitest_1.expect)(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow("asset mismatch");
        });
        (0, vitest_1.it)("throws when memo does not match SHA-256(nonce)[0:28]", async () => {
            const horizon = getHorizonMock();
            horizon.transactions.mockReturnValue({
                transaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({ memo: "wrongmemovalue123456789012" }),
                }),
            });
            horizon.operations.mockReturnValue({
                forTransaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({
                        records: [
                            {
                                to: VALID_PAY_TO,
                                amount: "1.5000000",
                                asset_code: "USDC",
                                from: stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey(),
                            },
                        ],
                    }),
                }),
            });
            await (0, vitest_1.expect)(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow("nonce mismatch");
        });
        (0, vitest_1.it)("throws when payer does not match proof.payer", async () => {
            setupValidMocks();
            const horizon = getHorizonMock();
            horizon.operations.mockReturnValue({
                forTransaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({
                        records: [
                            {
                                to: VALID_PAY_TO,
                                amount: "1.5000000",
                                asset_code: "USDC",
                                from: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                            },
                        ],
                    }),
                }),
            });
            await (0, vitest_1.expect)(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow("payer mismatch");
        });
        (0, vitest_1.it)("throws when the transaction has no operations", async () => {
            const horizon = getHorizonMock();
            horizon.transactions.mockReturnValue({
                transaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({ memo: EXPECTED_MEMO }),
                }),
            });
            horizon.operations.mockReturnValue({
                forTransaction: vitest_1.vi.fn().mockReturnValue({
                    call: vitest_1.vi.fn().mockResolvedValue({ records: [] }),
                }),
            });
            await (0, vitest_1.expect)(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow("missing operation");
        });
    });
});
//# sourceMappingURL=x402.test.js.map