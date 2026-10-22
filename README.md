# Nodal AI

[![CI](https://github.com/Nodal-stellar/Nodal-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/Nodal-stellar/Nodal-AI/actions/workflows/ci.yml)
**Modular, production-ready Agent Kit for autonomous PayFi (Payment-Finance) flows on the Stellar Network.**

Nodal AI empowers developers to build autonomous agents capable of handling complex financial interactions. Whether you’re automating cross-border settlements, building machine-to-machine payment gateways, or orchestrating smart contract executions, Nodal AI provides the primitives to do it securely and efficiently on Stellar.

---

## Why Nodal AI?

In the era of **PayFi**, payments are no longer just passive transfers they are programmable, autonomous, and integrated into the global financial fabric. Nodal AI bridges the gap between AI reasoning and Stellar's high-speed, low-cost network.

- **Autonomous PayFi:** Built-in support for the `x402` payment standard, enabling seamless machine-to-machine value exchange.
- **Modular Architecture:** Swap in new tools, chain actions, and orchestrate complex workflows without touching core signing logic.
- **Safety-First Design:** Every transaction is simulated via Soroban RPC before broadcast, and all secrets remain strictly externalized.

---

## Architecture

Nodal AI is built on a clean, three-pillar separation of concerns. For a deep dive into the system design, tool dispatch, simulation gates, and state machines, please read the [Architecture Guide](./ARCHITECTURE.md).

```text
/
├── backend/            # Agent orchestration (TypeScript/Node.js)
├── contracts/          # Soroban smart contracts (Rust)
└── tests/              # E2E & integration tests (Vitest)

```

---

## Quick Start

1. **Clone & Configure:**

   ```bash
   git clone https://github.com/your-username/nodal-ai.git
   cd nodal-ai
   cp .env.example .env
   ```

   Open `.env` and fill in at minimum `AGENT_SECRET_KEY`, `HORIZON_URL`, `SOROBAN_RPC_URL`, and `X402_ASSET_ISSUER`. See [`.env.example`](./.env.example) for the full list of variables and their descriptions.

2. **Install Dependencies:**

   ```bash
   npm install
   ```

3. **Verify Installation:**
   ```bash
   npm run build
   npm run test:all
   ```

---

## Development & Testing

### Backend (TypeScript)

The `backend/` pillar contains the "Agent Brain." Use it to define tools and manage agent state.

- `npm run build`: Compiles the TypeScript agent core.

### Smart Contracts (Rust/Soroban)

The `contracts/` pillar holds your escrow and payment logic.

- `cd contracts/escrow && cargo test`: Run the suite of Soroban unit tests to ensure contract safety.

### Integration Testing

We use `Vitest` to ensure the entire flow—from AI reasoning to network settlement—works as expected.

- `npm run test`: Executes the `/tests` suite.
- `npm run test:ui`: Runs the test suite with the interactive Vitest UI.

---

## Docker

Nodal AI includes a multi-stage Dockerfile and Docker Compose stack for local development, testing, and deployment.

### Running with Docker Compose

1. **Start the local Stellar network and Nodal agent:**

   ```bash
   docker-compose up --build
   ```

   This will spin up:
   - `stellar-quickstart` at `http://localhost:8000` (Horizon) and `http://localhost:8001` (Soroban RPC).
   - `agent` which automatically connects to the quickstart services once they are healthy.

2. **Stop the services and clean up containers:**
   ```bash
   docker-compose down
   ```

### Run Tests in Docker

You can run the test suite within an isolated test runner container:

```bash
docker-compose --profile test up --build
```

---

## Security Policy

Security is the foundation of PayFi. See [SECURITY.md](./SECURITY.md) for the full responsible disclosure policy, response SLAs, core security invariants, and secret management guidelines.

To report a vulnerability privately, use [GitHub Security Advisories](https://github.com/Dami24-hub/nodal-ai/security/advisories/new).

### Spending Limit Enforcement

PayFiAgent enforces three layers of spending limits to prevent runaway payments:

- **`AGENT_SPENDING_LIMIT`**: Global per-asset ceiling (used when no per-asset map is configured). Defaults to `"100"`.
- **`SPENDING_LIMITS`** *(new)*: Per-asset limits in the format `ASSET_CODE:LIMIT` (native) or `ASSET_CODE:ISSUER:LIMIT` (credit assets), comma-separated. Example: `XLM:1000,USDC:GA5Z…:500`. When set, each asset is tracked and limited independently.
- **Mainnet Spending Cap**: A hardcoded safety ceiling of **10,000** per single payment on mainnet.

#### Per-Asset Configuration

```bash
# Limit XLM to 1000, USDC to 500 per rolling 24-hour window
SPENDING_LIMITS=XLM:1000,USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN:500

# Deny any asset not in the list (default behaviour)
SPENDING_LIMITS_ALLOW_UNKNOWN=false

# Allow unlisted assets but still apply global limit
SPENDING_LIMITS_ALLOW_UNKNOWN=true
```

#### Key behaviours

| Scenario | Result |
|---|---|
| Asset in `SPENDING_LIMITS` | Per-asset limit enforced |
| Asset not in map, `ALLOW_UNKNOWN=false` | Payment denied |
| Asset not in map, `ALLOW_UNKNOWN=true` | Global `AGENT_SPENDING_LIMIT` applied |
| Empty `SPENDING_LIMITS` (default) | Global `AGENT_SPENDING_LIMIT` applies to all assets |
| Amount uses scientific notation or hex | Rejected by strict stroop parser |

#### Rolling window

All cumulative limits use a rolling window of `SPENDING_WINDOW_MS` (default `86_400_000` ms = 24 hours). The current window usage is available at `GET /spending`.

#### `GET /spending` endpoint

```json
{
  "windowMs": 86400000,
  "usage": [
    { "assetKey": "XLM",         "spent": "490.0000000", "limit": "1000" },
    { "assetKey": "USDC:GA5Z…",  "spent": "200.0000000", "limit": "500"  }
  ]
}
```

#### Atomic reservation & rollback

Spending is tracked with a **reserve → commit / rollback** pattern:
- `reserve()` atomically checks the limit and persists the reservation to SQLite.
- `commit()` confirms the payment completed.
- `rollback()` removes the reservation from memory **and** deletes the persisted row so rolled-back spend is not counted after a process restart (fixes [#731](https://github.com/Nodal-stellar/Nodal-AI/issues/731)).

#### BigInt stroop arithmetic

All amount comparisons use integer stroop arithmetic (`BigInt`) — `parseFloat` is never used on monetary values. This prevents precision loss and rejects inputs like `1e3`, `0x10`, or ` 5 ` that Stellar would reject (fixes [#734](https://github.com/Nodal-stellar/Nodal-AI/issues/734)).

### Mainnet Checklist

Before deploying to **Stellar mainnet**, verify the following:

- [ ] **Set `STELLAR_NETWORK=mainnet`** — This enables the mainnet spending cap and enforces HTTPS-only RPC connections.
- [ ] **Set `AGENT_SPENDING_LIMIT` below 10,000** — The limit should reflect your acceptable per-transaction maximum (e.g., `1000` for USD denominations). Values above 10,000 will be rejected on mainnet.
- [ ] **Verify `X402_ASSET_ISSUER`** — Confirm this is the canonical USDC anchor account on mainnet. Misconfiguration sends payments to the wrong issuer.
- [ ] **Test with `simulateOnly: true` first** — For `soroban_invoke` tasks, set `simulateOnly: true` to dry-run contract logic without broadcasting. This validates gas estimation and state changes in a safe sandbox.

All four checks are enforced at startup via `backend/config.ts` validation and at task dispatch time via `backend/agent.ts` guards.

---

## Contributing

We are actively participating in the **Stellar Wave** program! We welcome contributions ranging from bug fixes to new tool modules.

1.  Check the [Issues](https://github.com/your-username/nodal-ai/issues) tab for tickets tagged `good first issue` or `help wanted`.
2.  Follow the [CONTRIBUTING.md](./CONTRIBUTING.md) guide.
3.  Submit a Pull Request and join our community in the next Wave sprint to earn Drips points for your contributions!

---

## Examples

Three runnable scripts in `scripts/examples/` demonstrate each `TaskType` with real payloads. Copy `.env.example` to `.env` and fill in your values, then run any script with:

```bash
npx ts-node scripts/examples/<script>.ts
```

### `send_xlm.ts` — stellar_payment

Sends 1 XLM to a recipient account on testnet.

```bash
npx ts-node scripts/examples/send_xlm.ts
```

### `invoke_escrow.ts` — soroban_invoke

Calls `get_state` on a deployed escrow contract (simulate-only, no broadcast). Pass the contract address via `CONTRACT_ID`:

```bash
CONTRACT_ID=C... npx ts-node scripts/examples/invoke_escrow.ts
```

### `respond_x402.ts` — x402_respond

Responds to a sample x402 payment challenge and prints the resulting `X402PaymentProof`.

```bash
npx ts-node scripts/examples/respond_x402.ts
```

---

## E2E Tests

End-to-end tests run against the live Stellar testnet (not mocked). They require network access to Friendbot and Soroban RPC.

```bash
npm run test:e2e
```

The E2E suite is excluded from the default `npm run test` to keep CI fast. Run it separately before releases or after SDK upgrades.

---

## License

Released under the [MIT License](LICENSE).

---

_Built for the Stellar ecosystem by [Dami24-hub]._

````

## API Reference

### PayFiAgent

The primary integration surface for developers. Dispatch tasks to the agent via `run()` or `runSequence()`.

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `run(task)` | `AgentTask` | `Promise<AgentResult>` | Execute a single task. Routes to the appropriate tool based on task type. |
| `runSequence(tasks)` | `AgentTask[]` | `Promise<AgentResult[]>` | Execute an ordered list of tasks sequentially, stopping on first failure. |
| `destroy()` | — | `void` | Detach all event listeners and release resources. Call when decommissioning the agent. |

### TaskType

```typescript
type TaskType = "stellar_payment" | "soroban_invoke" | "x402_respond" | "path_payment" | "fee_bump"
```

| Value | Description |
|-------|-------------|
| `stellar_payment` | Native XLM or custom asset payment via Horizon |
| `soroban_invoke` | Smart contract invocation via Soroban RPC with simulation |
| `x402_respond` | Respond to an x402 payment challenge with spending limit guard |
| `path_payment` | Cross-asset path payment strict send via the Stellar DEX |
| `fee_bump` | Wrap an existing transaction in a fee-bump envelope for sponsored retry |

### AgentTask

```typescript
interface AgentTask {
  type: TaskType;
  payload: unknown;
}
```

Input wrapper for task dispatch. The `payload` shape depends on `type`:
- `stellar_payment`: `{ destination: string; amount: string; assetCode?: string; assetIssuer?: string; memo?: string }`
- `soroban_invoke`: `{ contractId: string; method: string; args: SorobanValue[]; ... }`
- `x402_respond`: `{ resource: string; amount: string; assetCode?: string; assetIssuer?: string; payTo: string; nonce: string; expiresAt: string }`

### AgentResult

```typescript
interface AgentResult {
  success: boolean;
  taskType: TaskType;
  data?: unknown;
  error?: string;
}
```

Task execution result. On success, `data` contains the tool's output. On failure, `error` is populated.

### Usage Example

```typescript
import { PayFiAgent } from "./backend/agent";

const agent = new PayFiAgent();

// Execute a Stellar payment
const result = await agent.run({
  type: "stellar_payment",
  payload: {
    destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    amount: "100",
    assetCode: "USDC",
    assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
});

if (result.success) {
  console.log("Payment settled:", result.data);
} else {
  console.error("Payment failed:", result.error);
}

// Clean up
agent.destroy();
```

---

## x402 Payment Flow

Nodal AI implements the [x402](https://github.com/x402-foundation/x402) protocol so the agent can pay for gated resources autonomously. The verified flow below covers what happens once `PayFiAgent.run()` is dispatched an `x402_respond` task — the upstream step of a resource server actually issuing the 402 challenge happens outside this codebase (in whatever client first calls `PayFiAgent.run()`), so it's described in prose rather than diagrammed.

```mermaid
sequenceDiagram
    participant C as Caller
    participant PA as PayFiAgent
    participant X as X402PaymentTool
    participant ST as StellarPaymentTool
    participant H as Horizon

    C->>PA: run({ type: "x402_respond", payload })
    PA->>PA: assertWithinSpendingLimit(amount)
    PA->>X: respond(challenge)
    X->>X: X402ChallengeSchema.parse(challenge)
    Note over X: reject if amount > AGENT_SPENDING_LIMIT<br/>reject if expiresAt has passed
    X->>ST: execute({ destination: payTo, amount, memo })
    ST->>H: sign + submit transaction
    H-->>ST: txHash, ledger
    ST-->>X: { txHash, ledger }
    X-->>PA: X402PaymentProof
    PA-->>C: AgentResult
````

In practice, the `payload` handed to `run()` is the parsed body of a `402 Payment Required` response from a resource server, conforming to `X402ChallengeSchema` — but the HTTP exchange that obtains and replays that challenge is the caller's responsibility, not `X402PaymentTool`'s.

### Spending limit guard

Before `PayFiAgent.run()` delegates to `X402PaymentTool`, it calls `assertWithinSpendingLimit()` on the payload's `amount` field. If the requested amount exceeds `config.AGENT_SPENDING_LIMIT`, the task throws immediately and `X402PaymentTool.respond()` is never invoked — the agent will not even attempt to validate or pay a challenge above its configured budget.

### `X402ChallengeSchema`

Once past the spending check, `X402PaymentTool.respond()` validates the challenge against this schema before doing anything else:

| Field         | Type                    | Description                                                                                                              |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `resource`    | `string` (URL)          | The URL of the resource being gated. Must be a valid URL.                                                                |
| `amount`      | `string`                | The amount due, as a string to avoid floating-point precision issues in transit.                                         |
| `assetCode`   | `string`                | The Stellar asset code to pay in (e.g. `USDC`, or `XLM` for native). Defaults to `config.X402_ASSET_CODE`.               |
| `assetIssuer` | `string`                | The issuing account of the asset. Defaults to `config.X402_ASSET_ISSUER`. Ignored when `assetCode` is `XLM`.             |
| `payTo`       | `string`                | The recipient Stellar account. Must be exactly 56 characters (a valid Stellar public key).                               |
| `nonce`       | `string` (UUID v4)      | A unique identifier for this challenge, used to correlate the resulting payment with the original request.               |
| `expiresAt`   | `string` (ISO datetime) | The deadline after which the challenge is no longer valid. Checked against `new Date()` before any payment is attempted. |

If `rawChallenge` doesn't conform to this shape, `X402ChallengeSchema.parse()` throws and no payment is attempted.

### Nonce → memo derivation

The challenge's `nonce` is a UUID v4 (36 characters), but Stellar's text memo field caps at 28 bytes. `X402PaymentTool` truncates it directly:

```typescript
memo: challenge.nonce.slice(0, 28);
```

This embeds enough of the nonce on-chain for a resource server to correlate a settled transaction with the original challenge by memo lookup on Horizon. Note this is a string truncation, not a hash — a resource server verifying the proof should compare against the same `slice(0, 28)` of the nonce it issued.

### `X402PaymentProof`

Once `StellarPaymentTool.execute()` returns a settled `txHash`, `respond()` builds and returns:

```typescript
interface X402PaymentProof {
  protocol: "x402"; // protocol tag, always "x402"
  network: string; // config.STELLAR_NETWORK
  txHash: string; // settled Stellar transaction hash
  nonce: string; // the original challenge nonce, in full
  payer: string; // the agent's Stellar public key
  signedAt: string; // ISO timestamp the proof was issued
}
```

The proof carries no embedded signature of its own. Verification is delegated to whatever consumes the proof: it looks up `txHash` on Horizon and confirms the payment's destination, amount, and memo match what the original challenge demanded. The proof is a pointer to on-chain truth, not a self-contained credential.

One thing to flag for reviewers: `StellarPaymentTool.execute()` does **not** run a Soroban simulation pass before submission — its own comments note that Horizon has no simulation endpoint, so it validates the transaction envelope locally, signs, and submits directly. Simulation-before-broadcast is real elsewhere in this codebase (`SorobanInvokeTool`), but not on this payment path — worth keeping the README's general security claims scoped accordingly if they currently imply otherwise project-wide.

### Minimal usage example

```typescript
import { PayFiAgent } from "./backend/agent";

const agent = new PayFiAgent();

// `challenge` is the parsed JSON body of a 402 response from a resource server
const result = await agent.run({
  type: "x402_respond",
  payload: challenge,
});

if (result.success) {
  const proof = result.data; // X402PaymentProof
  // retry the original resource request, attaching `proof`
}
```

See [`backend/agent.ts`](./backend/agent.ts) for task dispatch and the spending-limit guard, and [`backend/tools/X402PaymentTool.ts`](./backend/tools/X402PaymentTool.ts) for challenge validation and proof construction.
