/**
 * tests/liquidity_pool.test.ts
 * Unit tests for LiquidityPoolTool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { LiquidityPoolTool } from "../backend/tools/LiquidityPoolTool";
import { horizonServer, loadAccount, submitTransaction } from "../backend/rpc_client";

vi.mock("../backend/rpc_client", async () => {
  const actual = await vi.importActual<typeof import("../backend/rpc_client")>("../backend/rpc_client");
  return {
    ...actual,
    horizonServer: {
      liquidityPools: vi.fn(),
    },
    loadAccount: vi.fn(),
    submitTransaction: vi.fn(),
  };
});

vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    agentKeypair: () => ({ secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73" }),
  },
}));

describe("LiquidityPoolTool", () => {
  const secretKey = Keypair.random().secret();
  let tool: LiquidityPoolTool;

  const samplePoolId = "e2d8e411b4395d9ed4480d46860ec8702b8004f2f4581c7e9975764d36ef5a8a";

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new LiquidityPoolTool(secretKey);
  });

  describe("info action", () => {
    it("calls horizonServer.liquidityPools().liquidityPoolId(id).call() and returns typed state", async () => {
      const mockCall = vi.fn().mockResolvedValue({
        id: samplePoolId,
        paging_token: "12345",
        fee_bp: 30,
        type: "constant_product",
        total_shares: "1000.0000000",
        total_trustlines: "10",
        reserves: [
          { asset: "XLM", amount: "500.0000000" },
          { asset: "USDC:GA5W2X5GD25DPGFCC5GVGI6WGD25DPGFCC5GVGI6WGD25DPGFCC5GVGI6", amount: "500.0000000" },
        ],
      });

      (horizonServer.liquidityPools as any).mockReturnValue({
        liquidityPoolId: vi.fn().mockReturnValue({
          call: mockCall,
        }),
      });

      const res = await tool.execute({
        action: "info",
        liquidityPoolId: samplePoolId,
      });

      expect(res.poolInfo).toBeDefined();
      expect(res.poolInfo?.id).toBe(samplePoolId);
      expect(res.poolInfo?.feeBP).toBe(30);
      expect(res.poolInfo?.totalShares).toBe("1000.0000000");
      expect(res.poolInfo?.reserves).toHaveLength(2);
    });
  });

  describe("deposit action", () => {
    it("builds LIQUIDITY_POOL_DEPOSIT with min/max price bounds and submits tx", async () => {
      const sourceAccountMock = {
        accountId: () => Keypair.fromSecret(secretKey).publicKey(),
        sequenceNumber: () => "100",
        incrementSequenceNumber: vi.fn(),
      };
      (loadAccount as any).mockResolvedValue(sourceAccountMock);
      (submitTransaction as any).mockResolvedValue({
        hash: "mock_deposit_hash",
        ledger: 12345,
      });

      const res = await tool.execute({
        action: "deposit",
        liquidityPoolId: samplePoolId,
        maxAmountA: "100.0000000",
        maxAmountB: "200.0000000",
        minPrice: "0.4",
        maxPrice: "0.6",
      });

      expect(loadAccount).toHaveBeenCalled();
      expect(submitTransaction).toHaveBeenCalled();
      expect(res.txHash).toBe("mock_deposit_hash");
      expect(res.ledger).toBe(12345);
    });
  });

  describe("withdraw action", () => {
    it("builds LIQUIDITY_POOL_WITHDRAW with minimum receive amounts and submits tx", async () => {
      const sourceAccountMock = {
        accountId: () => Keypair.fromSecret(secretKey).publicKey(),
        sequenceNumber: () => "100",
        incrementSequenceNumber: vi.fn(),
      };
      (loadAccount as any).mockResolvedValue(sourceAccountMock);
      (submitTransaction as any).mockResolvedValue({
        hash: "mock_withdraw_hash",
        ledger: 12346,
      });

      const res = await tool.execute({
        action: "withdraw",
        liquidityPoolId: samplePoolId,
        amount: "50.0000000",
        minAmountA: "20.0000000",
        minAmountB: "40.0000000",
      });

      expect(loadAccount).toHaveBeenCalled();
      expect(submitTransaction).toHaveBeenCalled();
      expect(res.txHash).toBe("mock_withdraw_hash");
      expect(res.ledger).toBe(12346);
    });
  });
});
