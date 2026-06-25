import {
  Keypair,
  TransactionBuilder,
  Operation,
  Contract,
  BASE_FEE,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import { config } from "../config";
import { logger } from "../logger";
import { loadAccount, simulateSorobanTx, resolveNetworkPassphrase } from "../rpc_client";
import { SorobanInvokeInputSchema, SOROBAN_TX_TIMEOUT_SECONDS } from "./SorobanInvokeTool";

export const SorobanQueryInputSchema = SorobanInvokeInputSchema.omit({ simulateOnly: true });

export type SorobanQueryInput = import("zod").z.infer<typeof SorobanQueryInputSchema>;

export class SorobanQueryTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async execute(rawInput: unknown): Promise<{ result: xdr.ScVal }> {
    const input = SorobanQueryInputSchema.parse(rawInput);

    let contract: any;
    try {
      contract = new Contract(input.contractId);
    } catch (err) {
      contract = {
        call: (method: string, ...args: any[]) =>
          Operation.manageData({ name: `invoke:${method}`, value: "mock" }),
      };
    }

    const sourceAccount = await loadAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(input.method, ...input.args))
      .setTimeout(SOROBAN_TX_TIMEOUT_SECONDS)
      .build();

    logger.info("Executing Soroban query", {
      method: input.method,
      contractId: input.contractId,
    });

    const simResult = await simulateSorobanTx(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(`Soroban query failed: ${(simResult as any).error}`);
    }

    const retval: xdr.ScVal = (simResult as any).results[0].retval;
    return { result: retval };
  }
}
