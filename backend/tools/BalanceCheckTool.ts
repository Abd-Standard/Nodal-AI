import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { loadAccount } from "../rpc_client";

const stellarPublicKeySchema = z.string().trim().refine(
  (value) => StrKey.isValidEd25519PublicKey(value),
  { message: "Invalid Stellar public key" }
);

export const BalanceCheckInputSchema = z.object({
  publicKey: stellarPublicKeySchema,
  assetIssuer: z.string().trim().refine(
    (value) => StrKey.isValidEd25519PublicKey(value),
    { message: "Invalid Stellar asset issuer" }
  ),
  assetCode: z.string().trim().min(1).optional(),
});

export type BalanceCheckInput = z.infer<typeof BalanceCheckInputSchema>;

export class BalanceCheckTool {
  async execute(rawInput: unknown): Promise<string> {
    const input = BalanceCheckInputSchema.parse(rawInput);
    const account = await loadAccount(input.publicKey);
    if (!input.assetCode) return "0";

    const balance = (account.balances as any[]).find(
      (entry) =>
        entry.asset_type !== "native" &&
        entry.asset_code === input.assetCode &&
        entry.asset_issuer === input.assetIssuer
    );

    return balance?.balance ?? "0";
  }
}
