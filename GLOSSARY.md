# Glossary

This glossary keeps the Stellar- and PayFi-specific terms used in the repo in one place. The term links point to the canonical source for each definition, either Stellar docs/specs or this codebase.

| Term | Definition |
| --- | --- |
| [Claimable balance](https://developers.stellar.org/docs/build/guides/transactions/claimable-balances) | A ledger entry that reserves an asset until one of its claimants satisfies the predicate and claims it later. |
| [Circuit breaker](./backend/rpc_client.ts) | An opossum-backed guard around RPC calls that opens after repeated failures and short-circuits new calls until recovery. |
| [Horizon](https://developers.stellar.org/docs/data/apis/horizon) | Stellar's HTTP API for account, transaction, and ledger data, plus transaction submission. |
| [nonce](./backend/tools/X402PaymentTool.ts) | A one-time x402 challenge value used to prevent replay and to correlate the settled payment back to the original request. |
| [PayFi](./README.md) | Payment-finance flows where value transfer is part of automated application logic, not just a manual user action. |
| [SAC](https://developers.stellar.org/docs/tokens/stellar-asset-contract) | Stellar Asset Contract, the built-in contract interface for Stellar assets and trustline balances used by Soroban contracts. |
| [SEP-0001](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep1) | Stellar Info File, the `stellar.toml` metadata file anchors and apps use to discover endpoints, assets, and signing info. |
| [SEP-0010](https://developers.stellar.org/docs/build/apps/wallet/sep10) | Stellar Authentication, the challenge-response web auth standard used to establish an authenticated session with an anchor. |
| [SEP-0031](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31) | Cross-Border Payments, the standard for anchor-to-anchor and wallet-mediated cross-border payment flows. |
| [SEP-0038](https://developers.stellar.org/docs/build/apps/wallet/sep38) | Quote, the standard for requesting indicative or firm exchange quotes between Stellar and off-chain assets. |
| [Soroban](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/contracts) | Stellar's smart-contract platform and runtime for on-chain logic compiled to Wasm. |
| [trustline](https://developers.stellar.org/docs/build/guides/basics/verify-trustlines) | An opt-in ledger relationship that lets an account hold or send a non-XLM asset issued by another account. |
| [WASM](https://developers.stellar.org/docs/learn/fundamentals/contract-development/environment-concepts) | WebAssembly, the portable binary format used to compile Soroban contracts for on-chain execution. |
| [x402](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) | An HTTP 402-based payment standard for machine-to-machine payment of gated resources. |
| [XDR](https://developers.stellar.org/docs/learn/fundamentals/data-format/xdr) | External Data Representation, Stellar's binary serialization format for transactions, ledger data, and smart-contract metadata. |
