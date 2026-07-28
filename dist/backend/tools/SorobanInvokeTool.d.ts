/**
 * backend/tools/SorobanInvokeTool.ts
 * Standalone tool: invoke any Soroban smart contract function.
 *
 * MANDATORY simulation step enforced before any broadcast.
 */
import { Transaction, xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
export declare const SOROBAN_TX_TIMEOUT = 30;
/**
 * Zod schema for {@link SorobanInvokeTool.execute} inputs.
 *
 * @example
 * ```ts
 * const input: SorobanInvokeInput = {
 *   contractId: "CAAAA...56-char-id",
 *   method: "transfer",
 *   args: [nativeToScVal(recipient, { type: "address" }), nativeToScVal(100n, { type: "i128" })],
 *   simulateOnly: false,
 * };
 * ```
 */
export declare const SorobanInvokeInputSchema: z.ZodObject<{
    /** 56-character Stellar contract address (strkey C… encoding). */
    contractId: z.ZodString;
    /** Name of the contract function to invoke (e.g. `"transfer"`, `"mint"`). */
    method: z.ZodString;
    /**
     * Positional XDR arguments passed to the contract function, in declaration order.
     *
     * Each element must be an {@link xdr.ScVal} instance. Use the Stellar SDK helper
     * {@link nativeToScVal} to convert JavaScript primitives to the correct XDR type:
     *
     * ```ts
     * import { nativeToScVal } from "@stellar/stellar-sdk";
     *
     * const args = [
     *   nativeToScVal("GABC…", { type: "address" }),  // Address
     *   nativeToScVal(500n,     { type: "i128" }),     // i128 integer
     *   nativeToScVal(true,     { type: "bool" }),     // Boolean
     * ];
     * ```
     *
     * Defaults to an empty array when no arguments are required.
     */
    args: z.ZodDefault<z.ZodArray<z.ZodType<xdr.ScVal, z.ZodTypeDef, xdr.ScVal>, "many">>;
    /**
     * When `true`, the transaction is simulated via Soroban RPC but **never broadcast**.
     * The returned object will contain `simulationResult` instead of `txHash`.
     *
     * Use this for dry-runs, fee estimation, or validating contract logic without
     * consuming network resources or altering on-chain state.
     *
     * @defaultValue `false`
     */
    simulateOnly: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    contractId: string;
    method: string;
    args: xdr.ScVal[];
    simulateOnly: boolean;
}, {
    contractId: string;
    method: string;
    args?: xdr.ScVal[] | undefined;
    simulateOnly?: boolean | undefined;
}>;
export type SorobanInvokeInput = z.infer<typeof SorobanInvokeInputSchema>;
/**
 * Discriminated union return type for {@link SorobanInvokeTool.execute}.
 * - When `simulateOnly=false`: `{ txHash: string }`
 * - When `simulateOnly=true`:  `{ simulationResult: Transaction }`
 */
export type SorobanInvokeResult = {
    txHash: string;
    simulationResult?: never;
} | {
    txHash?: never;
    simulationResult: Transaction;
};
/**
 * Type guard: narrows a `SorobanInvokeResult` to the simulation-only variant.
 *
 * @example
 * ```ts
 * const result = await tool.execute({ ..., simulateOnly: true });
 * if (isSorobanSimulationResult(result)) {
 *   console.log(result.simulationResult); // Transaction
 * }
 * ```
 */
export declare function isSorobanSimulationResult(result: SorobanInvokeResult): result is {
    simulationResult: Transaction;
};
export declare class SorobanInvokeTool {
    private keypair;
    private networkPassphrase;
    constructor(secretKey?: string);
    /**
     * Invoke a Soroban smart contract function.
     *
     * Every call **always** runs a mandatory simulation step via
     * {@link prepareSorobanTx} before any broadcast attempt. The simulation both
     * validates the transaction and attaches the required Soroban resource footprint.
     *
     * ### Return shape — driven by `simulateOnly`
     *
     * The return type is polymorphic based on the `simulateOnly` flag in the parsed
     * input. Callers **must** check which key is present before accessing the result:
     *
     * | `simulateOnly` | Returned key       | Value type  | Description                          |
     * |----------------|--------------------|-------------|--------------------------------------|
     * | `false`        | `txHash`           | `string`    | Hex hash of the confirmed transaction |
     * | `true`         | `simulationResult` | `Transaction` (prepared) | Simulation-only — not broadcast |
     *
     * @example Broadcast (simulateOnly = false)
     * ```ts
     * const { txHash } = await tool.execute({ contractId, method, args, simulateOnly: false });
     * console.log("Confirmed:", txHash);
     * ```
     *
     * @example Dry-run (simulateOnly = true)
     * ```ts
     * const { simulationResult } = await tool.execute({ contractId, method, args, simulateOnly: true });
     * console.log("Simulation passed, prepared tx:", simulationResult);
     * ```
     *
     * @param rawInput - Raw (unvalidated) input object; parsed and typed via
     *   {@link SorobanInvokeInputSchema} internally.
     * @returns `{ txHash: string }` on broadcast success, or
     *   `{ simulationResult: unknown }` on dry-run.
     * @throws {Error} If simulation fails, the network rejects the submission
     *   (`status === "ERROR"`), or the transaction does not reach a terminal state
     *   within the polling window.
     */
    execute(rawInput: unknown): Promise<SorobanInvokeResult>;
    /**
     * Poll Soroban RPC until the transaction reaches a terminal state.
     *
     * Implements a simple fixed-interval polling loop that drives the following
     * state machine transitions:
     *
     * ```
     * NOT_FOUND ──(each attempt)──► NOT_FOUND   (keep polling)
     *                            └─► SUCCESS    (return txHash)
     *                            └─► FAILED     (throw Error)
     * ```
     *
     * The loop exits early on `SUCCESS` or `FAILED`. If neither terminal state is
     * reached within `maxAttempts` iterations, an error is thrown.
     *
     * @private
     * @param hash - Transaction hash returned by `sendTransaction`.
     * @param maxAttempts - Maximum number of polling iterations before timing out.
     *   Each attempt waits `intervalMs` milliseconds. Defaults to `10`.
     * @param intervalMs - Delay in milliseconds between each polling attempt.
     *   Defaults to `2000` (2 seconds), giving a default window of ~20 seconds.
     * @returns Resolves with `{ txHash }` when the transaction is confirmed on-chain.
     * @throws {Error} If the transaction status is `FAILED` or the polling window
     *   is exhausted without reaching a terminal state.
     */
    private pollForConfirmation;
}
//# sourceMappingURL=SorobanInvokeTool.d.ts.map