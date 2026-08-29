/**
 * backend/tools/BalanceStreamTool.ts
 * Streaming balance change monitor tool via Horizon's SSE /effects endpoint.
 */

import { EventEmitter } from "events";
import { horizonServer } from "../rpc_client";

export type BalanceDirection = "credit" | "debit";

export interface BalanceEvent {
  assetCode: string;
  amount: string;
  direction: BalanceDirection;
}

export class BalanceStreamTool {
  private closeStreamFn: (() => void) | null = null;
  private emitter: EventEmitter = new EventEmitter();

  /**
   * Subscribes to account payment effects via Horizon's SSE /effects endpoint.
   * Emits typed BalanceEvent objects on the returned EventEmitter.
   *
   * @param publicKey - Stellar public key (G...)
   * @returns EventEmitter emitting 'balance' events with BalanceEvent object
   */
  subscribe(publicKey: string): EventEmitter {
    if (this.closeStreamFn) {
      this.stop();
    }

    this.closeStreamFn = horizonServer
      .effects()
      .forAccount(publicKey)
      .stream({
        onmessage: (effect: any) => {
          if (effect.type === "account_credited") {
            const assetCode = effect.asset_type === "native" ? "XLM" : (effect.asset_code || "XLM");
            const event: BalanceEvent = {
              assetCode,
              amount: effect.amount,
              direction: "credit",
            };
            this.emitter.emit("balance", event);
          } else if (effect.type === "account_debited") {
            const assetCode = effect.asset_type === "native" ? "XLM" : (effect.asset_code || "XLM");
            const event: BalanceEvent = {
              assetCode,
              amount: effect.amount,
              direction: "debit",
            };
            this.emitter.emit("balance", event);
          }
        },
        onerror: (error: any) => {
          this.emitter.emit("error", error);
        },
      });

    return this.emitter;
  }

  /**
   * Cleanly closes the SSE stream.
   */
  stop(): void {
    if (this.closeStreamFn) {
      this.closeStreamFn();
      this.closeStreamFn = null;
    }
  }
}
