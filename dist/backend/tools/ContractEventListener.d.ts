/**
 * backend/tools/ContractEventListener.ts
 * Polling-based listener for Soroban contract events.
 *
 * Soroban RPC has no WebSocket stream, so this tool polls getEvents()
 * on an interval and invokes a callback for each new matching event.
 *
 * Architecture: poll getEvents() → filter by eventTypes → invoke onEvent → repeat
 */
import { rpc } from "@stellar/stellar-sdk";
export declare function listen(contractId: string, eventTypes: string[], onEvent: (event: rpc.Api.EventResponse) => void): () => void;
//# sourceMappingURL=ContractEventListener.d.ts.map