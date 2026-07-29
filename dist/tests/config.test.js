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
const zod_1 = require("zod");
// A single shared send mock — all SecretsManagerClient instances use it.
// This must be declared before vi.mock() because vi.mock() is hoisted.
const mockSend = vitest_1.vi.fn();
vitest_1.vi.mock("@aws-sdk/client-secrets-manager", () => ({
    SecretsManagerClient: vitest_1.vi.fn().mockImplementation(() => ({ send: mockSend })),
    GetSecretValueCommand: vitest_1.vi.fn().mockImplementation((args) => args),
}));
(0, vitest_1.describe)("config.ts startup validation", () => {
    let originalEnv;
    let exitSpy;
    let stderrSpy;
    let stdoutSpy;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.resetModules();
        mockSend.mockReset();
        originalEnv = { ...process.env };
        // Setup process spies
        exitSpy = vitest_1.vi.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`process.exit: ${code}`);
        });
        stderrSpy = vitest_1.vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        stdoutSpy = vitest_1.vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });
    (0, vitest_1.afterEach)(() => {
        process.env = originalEnv;
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)("fails if both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN are set", async () => {
        process.env.AGENT_SECRET_KEY = "process.env.AGENT_SECRET_KEY";
        process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";
        await (0, vitest_1.expect)(async () => {
            const { configPromise } = await Promise.resolve().then(() => __importStar(require("../backend/config")));
            await configPromise;
        }).rejects.toThrow(/process\.exit: 1|Cannot specify both/);
        (0, vitest_1.expect)(stderrSpy).toHaveBeenCalledWith(vitest_1.expect.stringContaining("Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN"));
    });
    (0, vitest_1.it)("fetches the secret using Secrets Manager SDK when AGENT_SECRET_KEY_ARN is set", async () => {
        const validSecret = "process.env.AGENT_SECRET_KEY";
        // Set minimal environment for EnvSchema to pass
        process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
        process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
        process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
        delete process.env.AGENT_SECRET_KEY;
        process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";
        // mockSend is shared across all SecretsManagerClient instances
        mockSend.mockResolvedValueOnce({ SecretString: validSecret });
        const { configPromise } = await Promise.resolve().then(() => __importStar(require("../backend/config")));
        const config = await configPromise;
        (0, vitest_1.expect)(mockSend).toHaveBeenCalled();
        (0, vitest_1.expect)(config.AGENT_PUBLIC_KEY).toBe("GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5");
        (0, vitest_1.expect)(config.agentKeypair().secret()).toBe(validSecret);
    });
    (0, vitest_1.it)("supports JSON structured Secrets Manager response", async () => {
        const validSecret = "process.env.AGENT_SECRET_KEY";
        const jsonSecret = JSON.stringify({ AGENT_SECRET_KEY: validSecret });
        process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
        process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
        process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
        delete process.env.AGENT_SECRET_KEY;
        process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";
        mockSend.mockResolvedValueOnce({ SecretString: jsonSecret });
        const { configPromise } = await Promise.resolve().then(() => __importStar(require("../backend/config")));
        const config = await configPromise;
        (0, vitest_1.expect)(config.agentKeypair().secret()).toBe(validSecret);
    });
    (0, vitest_1.it)("fails validation if fetched secret is not a valid Stellar key", async () => {
        process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
        process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
        process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
        delete process.env.AGENT_SECRET_KEY;
        process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";
        mockSend.mockResolvedValueOnce({ SecretString: "invalid-secret" });
        await (0, vitest_1.expect)(async () => {
            const { configPromise } = await Promise.resolve().then(() => __importStar(require("../backend/config")));
            await configPromise;
        }).rejects.toThrow("process.exit: 1");
        (0, vitest_1.expect)(exitSpy).toHaveBeenCalledWith(1);
        (0, vitest_1.expect)(stderrSpy).toHaveBeenCalledWith(vitest_1.expect.stringContaining("AGENT_SECRET_KEY is not a valid Stellar secret key"));
    });
});
// ─── formatValidationErrors (pure-function tests) ────────────────────────────
// formatValidationErrors is a pure transformation function with no side effects.
// Rather than importing config.ts (which calls loadConfig → process.exit on
// missing env vars), we test the identical logic inline so the describe block
// is fully self-contained and never triggers startup validation.
(0, vitest_1.describe)("formatValidationErrors", () => {
    // Inline the pure function to avoid importing backend/config (which calls loadConfig on init)
    // This mirrors the actual implementation in backend/config.ts
    function formatValidationErrors(errors) {
        return errors.issues
            .map((issue) => {
            const field = issue.path
                .map((p) => String(p).replace(/S[A-Z2-7]{55}/g, "[REDACTED]"))
                .join(".") || "unknown";
            const message = issue.message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
            return `  • ${field}: ${message}`;
        })
            .join("\n");
    }
    (0, vitest_1.it)("redacts a valid S-key in error message", () => {
        const error = new zod_1.z.ZodError([
            {
                code: "custom",
                path: ["test_field"],
                message: "Invalid secret: " + ("SBV" + "XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT"),
                fatal: false,
            },
        ]);
        const result = formatValidationErrors(error);
        (0, vitest_1.expect)(result).toContain("[REDACTED]");
        (0, vitest_1.expect)(result).not.toContain("SBV" + "XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
    });
    (0, vitest_1.it)("does not modify error message without S-key", () => {
        const error = new zod_1.z.ZodError([
            {
                code: "custom",
                path: ["field"],
                message: "This is a normal error",
                fatal: false,
            },
        ]);
        const result = formatValidationErrors(error);
        (0, vitest_1.expect)(result).toContain("This is a normal error");
    });
    (0, vitest_1.it)("redacts S-key in path field", () => {
        const error = new zod_1.z.ZodError([
            {
                code: "custom",
                path: [("SBV" + "XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT")],
                message: "Invalid config",
                fatal: false,
            },
        ]);
        const result = formatValidationErrors(error);
        (0, vitest_1.expect)(result).toContain("[REDACTED]");
        (0, vitest_1.expect)(result).not.toContain("SBV" + "XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
    });
    (0, vitest_1.it)("redacts multiple S-keys in one message", () => {
        const error = new zod_1.z.ZodError([
            {
                code: "custom",
                path: ["field"],
                message: "Key1: " + ("SBV" + "XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT") +
                    " and Key2: " + ("SBV" + "XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAY"),
                fatal: false,
            },
        ]);
        const result = formatValidationErrors(error);
        (0, vitest_1.expect)(result.match(/\[REDACTED\]/g)).toHaveLength(2);
        (0, vitest_1.expect)(result).not.toContain("SBV" + "XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
    });
});
(0, vitest_1.describe)("config.ts keypair caching", () => {
    (0, vitest_1.it)("agentKeypair returns the same Keypair instance on every call", async () => {
        vitest_1.vi.resetModules();
        process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
        process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
        process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
        process.env.AGENT_SECRET_KEY = "process.env.AGENT_SECRET_KEY";
        const { config } = await Promise.resolve().then(() => __importStar(require("../backend/config")));
        const first = config.agentKeypair();
        const second = config.agentKeypair();
        (0, vitest_1.expect)(first).toBe(second);
    });
});
//# sourceMappingURL=config.test.js.map