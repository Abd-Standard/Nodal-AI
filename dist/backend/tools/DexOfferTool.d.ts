/**
 * backend/tools/DexOfferTool.ts
 * Place, update, or delete a manage-sell offer on the Stellar DEX.
 */
import { z } from "zod";
export declare const DexOfferInputSchema: z.ZodEffects<z.ZodObject<{
    action: z.ZodEnum<["create", "update", "delete"]>;
    selling: z.ZodObject<{
        code: z.ZodString;
        issuer: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        code: string;
        issuer?: string | undefined;
    }, {
        code: string;
        issuer?: string | undefined;
    }>;
    buying: z.ZodObject<{
        code: z.ZodString;
        issuer: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        code: string;
        issuer?: string | undefined;
    }, {
        code: string;
        issuer?: string | undefined;
    }>;
    amount: z.ZodEffects<z.ZodString, string, string>;
    price: z.ZodString;
    offerId: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
}, "strip", z.ZodTypeAny, {
    amount: string;
    action: "create" | "update" | "delete";
    selling: {
        code: string;
        issuer?: string | undefined;
    };
    buying: {
        code: string;
        issuer?: string | undefined;
    };
    price: string;
    offerId?: string | number | undefined;
}, {
    amount: string;
    action: "create" | "update" | "delete";
    selling: {
        code: string;
        issuer?: string | undefined;
    };
    buying: {
        code: string;
        issuer?: string | undefined;
    };
    price: string;
    offerId?: string | number | undefined;
}>, {
    amount: string;
    action: "create" | "update" | "delete";
    selling: {
        code: string;
        issuer?: string | undefined;
    };
    buying: {
        code: string;
        issuer?: string | undefined;
    };
    price: string;
    offerId?: string | number | undefined;
}, {
    amount: string;
    action: "create" | "update" | "delete";
    selling: {
        code: string;
        issuer?: string | undefined;
    };
    buying: {
        code: string;
        issuer?: string | undefined;
    };
    price: string;
    offerId?: string | number | undefined;
}>;
export type DexOfferInput = z.infer<typeof DexOfferInputSchema>;
export declare class DexOfferTool {
    private keypair;
    private networkPassphrase;
    constructor(secretKey?: string);
    get publicKey(): string;
    execute(rawInput: unknown): Promise<{
        txHash: string;
        ledger: number;
        offerId: string;
    }>;
}
//# sourceMappingURL=DexOfferTool.d.ts.map