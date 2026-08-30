/**
 * backend/tools/AccountInfoTool.ts
 * Fetch agent account balances, sequence number, and trustlines from Horizon.
 */
export interface AccountInfo {
    publicKey: string;
    balances: {
        asset: string;
        balance: string;
    }[];
    sequenceNumber: string;
    subentryCount: number;
}
export declare class AccountInfoTool {
    fetch(): Promise<AccountInfo>;
}
//# sourceMappingURL=AccountInfoTool.d.ts.map