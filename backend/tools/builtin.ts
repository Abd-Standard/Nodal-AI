/**
 * backend/tools/builtin.ts
 *
 * The built-in tools PayFiAgent registers at construction, in one array.
 *
 * Each entry adapts an existing tool class to the {@link AgentTool} contract.
 * A fresh set of tool instances is created per call so two agents never share
 * tool state (caches, nonce stores, sequence tracking).
 */

import { z } from 'zod';
import { config } from '../config';
import type { AgentTool } from './AgentTool';
import { StellarPaymentTool, PaymentInputSchema } from './StellarPaymentTool';
import { SorobanInvokeTool, SorobanInvokeInputSchema } from './SorobanInvokeTool';
import { SorobanQueryTool, SorobanQueryInputSchema } from './SorobanQueryTool';
import { X402PaymentTool, X402ChallengeSchema } from './X402PaymentTool';
import { AccountInfoTool } from './AccountInfoTool';
import { TrustlineTool, TrustlineInputSchema } from './TrustlineTool';
import { MultiSigPaymentTool, MultiSigInputSchema } from './MultiSigPaymentTool';
import { BatchPaymentTool, BatchPaymentInputSchema } from './BatchPaymentTool';
import { BalanceCheckTool, BalanceCheckInputSchema } from './BalanceCheckTool';
import { PathPaymentTool, PathPaymentInputSchema } from './PathPaymentTool';
import { FeeBumpTool, FeeBumpInputSchema } from './FeeBumpTool';
import { DexOfferTool, DexOfferInputSchema } from './DexOfferTool';
import { LiquidityPoolTool, LiquidityPoolInputSchema } from './LiquidityPoolTool';
import { StellarTomlTool, StellarTomlInputSchema } from './StellarTomlTool';
import { DataEntryTool, DataEntryInputSchema } from './DataEntryTool';
import { SequenceNumberTool, SequenceNumberInputSchema } from './SequenceNumberTool';
import { SponsoredAccountTool, SponsoredAccountInputSchema } from './SponsoredAccountTool';
import { AnchorQuoteTool, AnchorQuoteInputSchema } from './AnchorQuoteTool';
import { InflationTool, InflationInputSchema } from './InflationTool';
import { SorobanDeployTool, SorobanDeployInputSchema } from './SorobanDeployTool';
import { SwapTool, SwapInputSchema } from './SwapTool';
import { AccountHistoryTool, AccountHistoryInputSchema } from './AccountHistoryTool';
import { SetOptionsTool, SetOptionsInputSchema } from './SetOptionsTool';
import {
  SorobanEventIndexerTool,
  SorobanEventIndexerInputSchema,
} from './SorobanEventIndexerTool';
import { StellarIdentityTool, WebAuthInputSchema } from './StellarIdentityTool';
import { FriendBotTool, FriendBotInputSchema } from './FriendBotTool';
import { LedgerInfoTool, LedgerInfoInputSchema } from './LedgerInfoTool';
import { NetworkStatusTool } from './NetworkStatusTool';
import { OfferBookTool, OfferBookInputSchema } from './OfferBookTool';
import { SorobanStorageTool, SorobanStorageInputSchema } from './SorobanStorageTool';

/** Identity helper that lets TypeScript infer `I` from `inputSchema` per entry. */
function defineTool<I, O>(tool: AgentTool<I, O>): AgentTool<I, O> {
  return tool;
}

/** Tools whose underlying method takes no input accept (and ignore) any payload. */
const NoInputSchema = z.unknown();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBuiltinTools(): AgentTool<any, any>[] {
  // config.agentKeypair().secret() is the canonical way to obtain the signing secret.
  // Direct access to config.AGENT_SECRET_KEY is intentionally blocked by the AgentConfig
  // type (Omit<RawEnv, "AGENT_SECRET_KEY">); using agentKeypair() makes the access explicit.
  const paymentTool = new StellarPaymentTool(config.agentKeypair().secret());
  const sorobanTool = new SorobanInvokeTool(config.agentKeypair().secret());
  const sorobanQueryTool = new SorobanQueryTool(config.agentKeypair().secret());
  const x402Tool = new X402PaymentTool(config.agentKeypair().secret());
  const accountInfoTool = new AccountInfoTool();
  const trustlineTool = new TrustlineTool(config.agentKeypair().secret());
  const multiSigTool = new MultiSigPaymentTool(config.agentKeypair().secret());
  const batchPaymentTool = new BatchPaymentTool(config.agentKeypair().secret());
  const balanceCheckTool = new BalanceCheckTool();
  const pathPaymentTool = new PathPaymentTool(config.agentKeypair().secret());
  const feeBumpTool = new FeeBumpTool(config.agentKeypair().secret());
  const dexOfferTool = new DexOfferTool(config.agentKeypair().secret());
  const liquidityPoolTool = new LiquidityPoolTool(config.agentKeypair().secret());
  const stellarTomlTool = new StellarTomlTool();
  const dataEntryTool = new DataEntryTool(config.agentKeypair().secret());
  const sequenceNumberTool = new SequenceNumberTool(config.agentKeypair().secret());
  const sponsoredAccountTool = new SponsoredAccountTool(config.agentKeypair().secret());
  const anchorQuoteTool = new AnchorQuoteTool();
  const inflationTool = new InflationTool(config.agentKeypair().secret());
  const sorobanDeployTool = new SorobanDeployTool();
  const swapTool = new SwapTool(config.agentKeypair().secret());
  const accountHistoryTool = new AccountHistoryTool();
  const setOptionsTool = new SetOptionsTool(config.agentKeypair().secret());
  const sorobanEventIndexerTool = new SorobanEventIndexerTool();
  const stellarIdentityTool = new StellarIdentityTool(config.agentKeypair().secret());
  const friendBotTool = new FriendBotTool();
  const ledgerInfoTool = new LedgerInfoTool();
  const networkStatusTool = new NetworkStatusTool();
  const offerBookTool = new OfferBookTool();
  const sorobanStorageTool = new SorobanStorageTool();

  return [
    defineTool({
      name: 'stellar_payment',
      description:
        'Submit a native XLM or custom Stellar asset payment via Horizon. ' +
        'Spending limit enforced before submission.',
      inputSchema: PaymentInputSchema,
      valueMoving: true,
      execute: async (input, ctx) => {
        ctx.assertWithinSpendingLimit(input.amount);
        const paymentResult = await paymentTool.execute(input);
        return { ...paymentResult, network: ctx.network };
      },
    }),
    defineTool({
      name: 'soroban_invoke',
      description:
        'Invoke a Soroban smart contract function. Always simulates first; ' +
        'set simulateOnly for a dry-run.',
      inputSchema: SorobanInvokeInputSchema,
      valueMoving: true,
      execute: (input) => sorobanTool.execute(input),
    }),
    defineTool({
      name: 'soroban_query',
      description: 'Read-only Soroban contract state inspection. Simulates, never broadcasts.',
      inputSchema: SorobanQueryInputSchema,
      valueMoving: false,
      execute: (input) => sorobanQueryTool.query(input),
    }),
    defineTool({
      name: 'x402_respond',
      description:
        'Respond to an x402 402 Payment Required challenge by paying it and ' +
        'returning a payment proof. Spending limit enforced.',
      inputSchema: X402ChallengeSchema,
      valueMoving: true,
      execute: async (input, ctx) => {
        ctx.assertWithinSpendingLimit(input.amount);
        return x402Tool.respond(input);
      },
    }),
    defineTool({
      name: 'account_info',
      description: "Fetch the agent's balances, sequence number and subentry count from Horizon.",
      inputSchema: NoInputSchema,
      valueMoving: false,
      execute: () => accountInfoTool.fetch(),
    }),
    defineTool({
      name: 'change_trust',
      description: "Add or remove a custom asset trustline on the agent's account.",
      inputSchema: TrustlineInputSchema,
      valueMoving: false,
      execute: (input) => trustlineTool.execute(input),
    }),
    defineTool({
      name: 'multisig_payment',
      description:
        'Build an M-of-N multisig payment. Returns the unsigned XDR until enough ' +
        'signatures are collected, then submits.',
      inputSchema: MultiSigInputSchema,
      valueMoving: true,
      execute: (input) => multiSigTool.execute(input),
    }),
    defineTool({
      name: 'batch_payment',
      description:
        'Submit up to 100 payments in one atomic transaction. Aggregate spending limit enforced.',
      inputSchema: BatchPaymentInputSchema,
      valueMoving: true,
      execute: (input) => batchPaymentTool.execute(input),
    }),
    defineTool({
      name: 'balance_check',
      description: 'Query asset balances for any Stellar account.',
      inputSchema: BalanceCheckInputSchema,
      valueMoving: false,
      execute: async (input) => {
        const tool = balanceCheckTool as {
          execute?: (payload: unknown) => Promise<unknown>;
          getBalance?: (payload: unknown) => Promise<unknown>;
        };
        if (typeof tool.execute === 'function') {
          return tool.execute(input);
        }
        if (typeof tool.getBalance === 'function') {
          return tool.getBalance(input);
        }
        throw new Error('Balance check tool does not implement execute() or getBalance().');
      },
    }),
    defineTool({
      name: 'path_payment',
      description: 'Cross-asset strict-send path payment routed through the Stellar DEX.',
      inputSchema: PathPaymentInputSchema,
      valueMoving: true,
      execute: (input) => pathPaymentTool.execute(input),
    }),
    defineTool({
      name: 'fee_bump',
      description: 'Wrap a pre-built transaction XDR in a fee-bump envelope and submit it.',
      inputSchema: FeeBumpInputSchema,
      valueMoving: false,
      execute: (input) => feeBumpTool.execute(input),
    }),
    defineTool({
      name: 'dex_offer',
      description: 'Create, update or delete a manage-sell offer on the Stellar DEX.',
      inputSchema: DexOfferInputSchema,
      valueMoving: true,
      execute: (input) => dexOfferTool.execute(input),
    }),
    defineTool({
      name: 'liquidity_pool',
      description: 'Deposit into, withdraw from, or query a Stellar AMM liquidity pool.',
      inputSchema: LiquidityPoolInputSchema,
      valueMoving: true,
      execute: (input) => liquidityPoolTool.execute(input),
    }),
    defineTool({
      name: 'stellar_toml',
      description: "Fetch and parse a domain's SEP-1 stellar.toml.",
      inputSchema: StellarTomlInputSchema,
      valueMoving: false,
      execute: (input) => stellarTomlTool.fetchToml(input),
    }),
    defineTool({
      name: 'data_entry',
      description: "Set, delete or read a key-value data entry on the agent's account.",
      inputSchema: DataEntryInputSchema,
      valueMoving: false,
      execute: (input) => dataEntryTool.execute(input),
    }),
    defineTool({
      name: 'sequence_number',
      description: "Fetch or bump the agent's current sequence number.",
      inputSchema: SequenceNumberInputSchema,
      valueMoving: false,
      execute: (input) => sequenceNumberTool.execute(input),
    }),
    defineTool({
      name: 'sponsored_account',
      description: 'Create a new Stellar account with reserves sponsored by the agent.',
      inputSchema: SponsoredAccountInputSchema,
      valueMoving: true,
      execute: (input) => sponsoredAccountTool.execute(input),
    }),
    defineTool({
      name: 'anchor_quote',
      description: 'Fetch an SEP-38 quote from an anchor for an asset conversion.',
      inputSchema: AnchorQuoteInputSchema,
      valueMoving: false,
      execute: (input) => anchorQuoteTool.execute(input),
    }),
    defineTool({
      name: 'inflation',
      description: "Set or query the account's inflation destination.",
      inputSchema: InflationInputSchema,
      valueMoving: false,
      execute: (input) => inflationTool.execute(input),
    }),
    defineTool({
      name: 'soroban_deploy',
      description: 'Upload WASM bytecode and instantiate a Soroban smart contract.',
      inputSchema: SorobanDeployInputSchema,
      valueMoving: false,
      execute: (input) => sorobanDeployTool.execute(input),
    }),
    defineTool({
      name: 'swap',
      description: 'Atomic DEX asset swap via a strict-send path payment with slippage bound.',
      inputSchema: SwapInputSchema,
      valueMoving: true,
      execute: (input) => swapTool.execute(input),
    }),
    defineTool({
      name: 'account_history',
      description: 'Fetch paginated payment history for a Stellar account.',
      inputSchema: AccountHistoryInputSchema,
      valueMoving: false,
      execute: (input) => accountHistoryTool.fetch(input),
    }),
    defineTool({
      name: 'set_options',
      description: 'Manage account flags, thresholds, signers and home domain via setOptions.',
      inputSchema: SetOptionsInputSchema,
      valueMoving: false,
      execute: (input) => setOptionsTool.execute(input),
    }),
    defineTool({
      name: 'soroban_event_query',
      description: 'Query historical Soroban contract events by ledger range and topic filters.',
      inputSchema: SorobanEventIndexerInputSchema,
      valueMoving: false,
      execute: (input) => sorobanEventIndexerTool.query(input),
    }),
    defineTool({
      name: 'stellar_identity_auth',
      description: 'Perform SEP-10 Web Auth with an anchor and obtain a JWT.',
      inputSchema: WebAuthInputSchema,
      valueMoving: false,
      execute: (input) => stellarIdentityTool.execute(input),
    }),
    defineTool({
      name: 'friendbot',
      description: 'Fund a test account via Friendbot on testnet or futurenet.',
      inputSchema: FriendBotInputSchema,
      valueMoving: false,
      execute: (input) => friendBotTool.execute(input),
    }),
    defineTool({
      name: 'ledger_info',
      description: 'Fetch the latest ledger sequence and protocol version from Soroban RPC.',
      inputSchema: LedgerInfoInputSchema,
      valueMoving: false,
      execute: (input) => ledgerInfoTool.execute(input),
    }),
    defineTool({
      name: 'network_status',
      description: 'Check health and latency of the Horizon and Soroban RPC endpoints.',
      inputSchema: NoInputSchema,
      valueMoving: false,
      execute: () => networkStatusTool.execute(),
    }),
    defineTool({
      name: 'offer_book',
      description: 'Query the Stellar DEX order book for an asset pair, with spread.',
      inputSchema: OfferBookInputSchema,
      valueMoving: false,
      execute: (input) => offerBookTool.execute(input),
    }),
    defineTool({
      name: 'soroban_storage',
      description: "Read a Soroban contract's storage entry and decode its value.",
      inputSchema: SorobanStorageInputSchema,
      valueMoving: false,
      execute: (input) => sorobanStorageTool.execute(input),
    }),
  ];
}
