/**
 * tests/fixtures/MockHorizonServer.test.ts
 *
 * Unit tests for the shared MockHorizonServer fixture itself. These validate
 * the fixture's contract so suites that consume it (e.g. tests/payment.test.ts)
 * can rely on its defaults and configurators. They intentionally avoid mocking
 * rpc_client — they exercise the fixture in isolation.
 */

import { describe, it, expect } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { createMockHorizonServer } from "./MockHorizonServer";
import type { MockHorizonServer } from "./MockHorizonServer";

const DEFAULT_ACCOUNT_ID = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("createMockHorizonServer", () => {
  it("returns a full rpc_client-shaped mock", () => {
    const server: MockHorizonServer = createMockHorizonServer();
    expect(typeof server.loadAccount).toBe("function");
    expect(typeof server.submitTransaction).toBe("function");
    expect(typeof server.horizonServer.payments).toBe("function");
    expect(typeof server.horizonServer.orderbook).toBe("function");
    expect(typeof server.simulateSorobanTx).toBe("function");
    expect(typeof server.prepareSorobanTx).toBe("function");
  });

  it("resolveNetworkPassphrase mirrors the real implementation", () => {
    const server = createMockHorizonServer();
    expect(server.resolveNetworkPassphrase("mainnet")).toBe(Networks.PUBLIC);
    expect(server.resolveNetworkPassphrase("futurenet")).toBe(Networks.FUTURENET);
    expect(server.resolveNetworkPassphrase("testnet")).toBe(Networks.TESTNET);
  });

  it("loadAccount resolves to a sequence-bearing account by default", async () => {
    const server = createMockHorizonServer();
    const account = (await server.loadAccount(DEFAULT_ACCOUNT_ID)) as {
      accountId: () => string;
      sequenceNumber: () => string;
    };
    expect(account.accountId()).toBe(DEFAULT_ACCOUNT_ID);
    expect(account.sequenceNumber()).toBe("100");
  });

  it("supports configurable loadAccount responses", async () => {
    const custom = { id: "custom-account" };
    const server = createMockHorizonServer({ account: custom });
    await expect(server.loadAccount("pk")).resolves.toBe(custom);

    const err = new Error("Horizon: account not found (404)");
    server.setAccountError(err);
    await expect(server.loadAccount("pk")).rejects.toBe(err);

    server.reset();
    await expect(server.loadAccount("pk")).resolves.toBe(custom);
  });

  it("supports configurable submitTransaction responses", async () => {
    const result = { hash: "abc123", ledger: 7 };
    const server = createMockHorizonServer({ submitResult: result });
    await expect(server.submitTransaction({} as never)).resolves.toBe(result);

    const err = new Error("Horizon: op_underfunded");
    server.setSubmitError(err);
    await expect(server.submitTransaction({} as never)).rejects.toBe(err);

    server.reset();
    await expect(server.submitTransaction({} as never)).resolves.toBe(result);
  });

  it("supports payments().forAccount() with configurable records", async () => {
    const server = createMockHorizonServer();
    const records = [{ id: "1", type: "payment", amount: "10.0000000" }];
    server.setPaymentRecords(records);

    const query = server.horizonServer.payments().forAccount(DEFAULT_ACCOUNT_ID);
    query.order("desc").limit(5).cursor("cursor-1");

    await expect(query.call()).resolves.toEqual({ records });
    expect(server.forAccount).toHaveBeenCalledWith(DEFAULT_ACCOUNT_ID);
    expect(server.paymentsCall).toHaveBeenCalledTimes(1);
  });

  it("supports orderbook() with configurable bids and asks", async () => {
    const server = createMockHorizonServer();
    const response = {
      bids: [{ price: "1.0000000", price_r: { n: 1, d: 1 }, amount: "10" }],
      asks: [{ price: "2.0000000", price_r: { n: 2, d: 1 }, amount: "5" }],
    };
    server.setOrderbookResponse(response);

    const builder = server.horizonServer.orderbook("XLM", "USDC");
    builder.limit(10);

    await expect(builder.call()).resolves.toEqual(response);
    expect(server.orderbookCall).toHaveBeenCalledTimes(1);
  });

  it("reset() clears call history and restores configured defaults", async () => {
    const server = createMockHorizonServer();
    await server.loadAccount("pk");
    expect(server.loadAccount).toHaveBeenCalledTimes(1);

    server.setSubmitError(new Error("transient"));
    server.reset();

    expect(server.loadAccount).not.toHaveBeenCalled();
    expect(server.submitTransaction).not.toHaveBeenCalled();
    await expect(server.submitTransaction({} as never)).resolves.toEqual({
      hash: "mock_tx_hash",
      ledger: 1,
    });
  });

  it("does not allow error configurators to leak through reset()", async () => {
    const server = createMockHorizonServer();
    server.setAccountError(new Error("boom"));
    server.setSubmitError(new Error("nope"));
    server.reset();

    await expect(server.loadAccount("pk")).resolves.toBeDefined();
    await expect(server.submitTransaction({} as never)).resolves.toBeDefined();
  });
});
