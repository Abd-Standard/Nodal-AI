import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

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
});

export type BalanceCheckInput = z.infer<typeof BalanceCheckInputSchema>;

export class BalanceCheckTool {
  async execute(rawInput: unknown): Promise<BalanceCheckInput> {
    return BalanceCheckInputSchema.parse(rawInput);
  }
}
