# ETHGlobal Online — Hackathon Execution Plan

**Repo:** `ZkVanguard/zkward-ethglobal` (canonical production repo since 2026-09-04)
**Tracks:** 3 partners max — **Hedera (primary)** · The Graph · Privy
**Addressable prize pool:** ~$18,000
**Pool eligibility:** every submission is **Continuity** (live product on Sui mainnet since 2026-06-12, v0.4.0)

**Chain-primary pivot (2026-09-04):** Hedera is the primary chain for the hackathon submission — main wallet + main deposit UX. SUI stays live as the secondary optional path (existing mainnet pool untouched). Reordering below reflects the pivot.

---

## Coherent story (memorize for demos)

> "Multi-chain AI-managed vault where seven agents allocate capital autonomously across chains, discover on-chain state through a **new Standardized Subgraph schema for AI-managed vaults** we're proposing, pay for their own signal-quality inference on **Hedera x402** with HCS-14 identity, and expose institutional admin controls (**Privy** org wallet + quorum) plus one-tap user deposits (**Privy** embedded wallet) to the humans in the loop."

Every demo video opens with 15s on the pre-existing v0.4.0 mainnet product, then focuses on the new hackathon work.

---

## Pre-existing baseline (document once, reuse in every submission)

Every Continuity README must clearly separate this baseline from event work.

- **SUI USDC Community Pool** — v0.2.0 Move + v0.4.0 off-chain defense, live on Sui mainnet since 2026-06-12. Package `0x1072…7b726`, state `0xe814…2fb3a`. TVL cap $10K.
- **8-gate autonomy defense system** shipped 2026-07-15 — PortfolioDriver, Fill verifier, Hedgeability spot-cap, Symmetric sell, Stale-hedge detector, Signal-flip drift-close, Regret weighting, Alert response.
- **7-agent AI system** (`agents/specialized/`) with SafeExecutionGuard (per-chain volume buckets added 2026-09-03 in PR #99).
- **ZK-STARK prover** (Python + Move verifier).
- **BlueFin V2 perp integration** with silent-reject prevention (ISOLATED-only, per-symbol step-size snap, fill delta verification).
- **Multi-chain infrastructure** (PR #99, 2026-09-03) — WDK removed, `lib/evm-wallet/` shim ready for universal EVM wallet, portfolio IDs -3/-4/-5 reserved, alert-log chain-tagged, `<CHAIN>_AUTO_HEDGE_DISABLE` per-chain kill switches, per-chain SafeExecutionGuard volume buckets.
- **15 internal audit phases** (Jun 4-12, 2026) — documented in `docs/history/`.
- **Bulletproof drawdown test** (`test/integration/pool-drawdown-defense.test.ts`) as the required 10/10-green merge gate.

**Anything below this line is event work.**

---

## Priority 1 — The Graph ($10K addressable)

### Winning angle (what actually beats other submissions)

The Composable/Standardized track is judged on **"leverage of standards: one query pattern spanning many protocols, or one pipeline reused across chains."** Most teams will submit a subgraph for ONE protocol on ONE chain. Winning move:

**Publish a proposed Standardized Subgraph schema for AI-managed vaults, deploy it across three chains, and contribute a reusable Substreams module.**

No such standard exists today. Messari's Standardized Subgraphs cover DEXs, lending, yield aggregators — not AI-managed vaults. We define the schema (following the Messari conventions), deploy for our pool on Cronos/Hedera/Sepolia, publish the Substreams module for `CommunityPool.sol` on GitHub. That's category-creating standards work, not usage.

For the AI Continuity track, the killer angle is a **live 7-agent orchestrator using Subgraph MCP for decision-making** — not just querying, but reasoning over the returned data to size positions.

### Prize tracks

- [ ] **Composable/Standardized Graph Products** — $5K pool (1st $2.5K · 2nd $1.5K · 3rd $1K)
- [ ] **AI Tooling / AI Use Case (Continuity)** — $5K pool (1st $2.5K · 2nd $1.5K · 3rd $1K)

### Data plane after migration (Aiven retired)

| Data | Old (Aiven) | New | Why |
|---|---|---|---|
| Pool NAV history | `community_pool_nav_history` | Subgraph indexes `NavSnapshot` events | Derivable from on-chain state |
| Hedge lifecycle | `hedges` | Subgraph indexes `HedgeOpened` / `HedgeClosed` | On-chain event stream |
| Pool state + allocations | `community_pool_state` | Subgraph (latest state per chain) | On-chain |
| Deposit / withdraw history | `community_pool_transactions` | Subgraph indexes pool events | On-chain |
| Cron heartbeats (`cron:lastRun:*`) | `cron_state` table | Upstash Redis KV | Not on-chain; 15-min TTL fine |
| Halt keys (`cron:haltUntil:*`) | `cron_state` table | Upstash Redis KV | Redis for fast cron read; contract-level halts are v0.5.0 |
| Alert ring buffer | `cron_state` key | Upstash Redis LIST (native LPUSH + LTRIM) | Better fit than Postgres |
| Autohedge configs | `autohedge_configs` | Upstash Redis KV | Mutable user config |
| Agent decisions log | `agent_decisions` | Upstash Redis LIST (TTL 30d) | Audit trail |
| Signal outcomes | `signal_outcomes` | Upstash Redis LIST (TTL 30d) | Same |

**Result:** Aiven Postgres retired. Reads flow through The Graph. Writes flow through on-chain contracts (indexed by Subgraph) + Upstash Redis for the residual off-chain metadata. Substreams push obviates the polling crons that were the biggest Aiven consumers.

### Build checklist

**Phase 1 — Redis client + subgraph scaffold (Day 1-2)**
- [ ] `lib/db/cron-state-redis.ts` — Redis-backed implementation matching the current Postgres `cron-state.ts` interface (getCronState, setCronState, tryClaimCronRun with Redis WATCH/MULTI CAS, setCronHalt/getCronHalt)
- [ ] Dual-write wrapper in `lib/db/cron-state.ts` — `CRON_STATE_REDIS_WRITE=1` writes to both, `CRON_STATE_REDIS_READ=1` reads from Redis
- [ ] Unit test asserting Redis + Postgres return identical values for the full API surface
- [ ] `subgraph/` directory with `schema.graphql` (Messari-style ERC-4626-inspired vault schema), `subgraph.yaml` for Sepolia deployment
- [ ] Add `NavSnapshot`, `HedgeOpened`, `HedgeClosed` events to `CommunityPool.sol` + `HedgeExecutor.sol` if missing (contract diff, ready to deploy)

**Phase 2 — deploy subgraph, migrate one endpoint (Day 3)**
- [ ] Deploy Sepolia `CommunityPool.sol` subgraph via Subgraph Studio (real API key)
- [ ] Rewrite `/api/platform/nav-history` to hit Subgraph behind `SUBGRAPH_READS_ENABLED` env flag
- [ ] Vercel preview measures Aiven conn-count drop for the demo

**Phase 3 — extend coverage + Redis cutover (Day 4-5)**
- [ ] Extend subgraph to cover hedges, transactions, per-user positions
- [ ] Migrate `/api/community-pool/*` and dashboard reads to Subgraph
- [ ] Flip cron_state reads to Redis (writes still dual-writing)
- [ ] Move alert ring buffer to Redis LIST (LPUSH + LTRIM instead of JSONB read-modify-write)
- [ ] Move autohedge configs + agent_decisions + signal_outcomes to Redis

**Phase 4 — Substreams module + MCP wiring (Day 6-7)**
- [ ] Package `CommunityPool.sol` events as a reusable Substreams module (`substreams/community-pool/`)
- [ ] Publish on the Substreams registry (matches "composable Substreams module for an emerging standard" prize wording)
- [ ] Replace `pool-nav-monitor` cron with Substreams push → dashboard SSE
- [ ] Add Subgraph MCP as a tool in the 7-agent orchestrator (`agents/mcp-tools/subgraph.ts`)
- [ ] Replace direct `getActiveHedges()` DB reads in agents with MCP tool calls

**Phase 5 — Aiven kill (Day 8)**
- [ ] Flip `AIVEN_DISABLE=1` — every read routes to Subgraph or Redis
- [ ] Delete `lib/db/postgres.ts` + Aiven env vars from Vercel
- [ ] Remove `pg` + `pg-pool` from package.json
- [ ] Update `test/integration/pool-drawdown-defense.test.ts` to use Redis + Subgraph fixtures
- [ ] Confirm bulletproof-drawdown test 10/10 green with new backing

### Qualification proof (per official rules)

- [ ] Public repo (this one) with README linking to hackathon story
- [ ] Consume live data from Subgraph Studio (real API key, not mocked)
- [ ] Compose ≥ 2 Graph products (Subgraphs + Substreams + MCP)
- [ ] Standards leverage clear — one query pattern spans Cronos/Hedera/Sepolia pools
- [ ] 2-4 min demo video showing (a) old Aiven query, (b) new subgraph query, (c) agent using MCP
- [ ] FEEDBACK.md documenting what became easier

---

## Priority 1 — Hedera ($6K addressable, up to $4K in wins) — PRIMARY CHAIN

### Winning angle

The $6K AI & Agentic Payments track pays "up to 3 teams × $2K." Rules list explicit **extra points**: pay-per-call metering (not flat), A2A multi-agent negotiation, ERC-8004 / HCS-14 agent identity, HTS tokens, HCS audit trails, Scheduled Transactions.

Most teams will submit a single agent that pays for one endpoint via x402. Winning move:

**Multi-agent x402 payment negotiation where each of our 7 agents has an HCS-14 identity, they A2A-negotiate over signal-quality inference cost, budget across providers, and every fill lands on HCS as an auditable trail. All happening on Hedera as the primary chain — deposits, hedge management, agent payments settle here first.**

Nearly every "extra points" checkbox lit. Uses our existing 7-agent system as the "already impressive" baseline; agent-payment + primary-chain flip as the new work.

### Prize tracks

- [ ] **AI & Agentic Payments on Hedera** — up to $2K (3 teams × $2K)
- [ ] **Continuity** — $1K
- [ ] **Open Source — Improve the Hedera Harness** — up to $1K (2 teams × $1K) — bolt-on if time allows

**Total addressable:** $4K (AI $2K + Continuity $1K + Open Source $1K)

### Build checklist

**Hedera cron guardrails (Day 1 — shipped)**
- [x] `hedera-community-pool` cron wired: `isChainAutoHedgeDisabled('hedera')` kill switch, `getCronHalt('hedera-community-pool')` halt window, `tryClaimCronRun` cluster-wide claim, heartbeat via `cron:lastRun:hedera-community-pool`, portfolio ID `-3` on all DB writes, chain-tagged `notifyDiscord` so Hedera errors don't halt SUI trader.

**x402-gated inference endpoint (Day 1 — shipped)**
- [x] `/api/hedera/x402/signal-quality` — 402 Payment Required with X-PAYMENT intent, Blocky402 facilitator verify, wraps `PredictionAggregatorService`, HCS audit hook. Sub-cent pay-per-call metering ($0.0001 default via `X402_PRICE_USDC_MICROS`).

**HCS-14 agent identity (Day 1 — shipped)**
- [x] `lib/services/hedera/agent-identity.ts` — W3C DID doc builder, `registerAgentIdentity` (idempotent, Redis-cached), `DEFAULT_AGENT_ROSTER` for all 7 agents with capabilities + budget hints. Real HCS submit lands when `HCS_AGENT_IDENTITY_ENABLED=1` + operator creds set.

**Live Hedera pool (needs creds)**
- [ ] Deploy `CommunityPool.sol` to Hedera testnet via Hashio (needs testnet HBAR)
- [ ] Set `HEDERA_MAINNET_CONTRACT_COMMUNITY_POOL` in Vercel via `vercel env add`
- [ ] First live deposit → AI allocation → NAV snapshot on Hedera
- [ ] Schedule the hedera-community-pool cron (Vercel Cron via `vercel.ts` or QStash)

**Extra-points harvest (Day 2-3)**
- [ ] Wire agent orchestrator boot to call `registerAllAgents(DEFAULT_AGENT_ROSTER)` on cold start
- [x] A2A negotiation between analyst-agent (proposes cost budget) and executor-agent (picks provider that fits budget) — shipped: `lib/services/a2a/{protocol,bus,provider-registry,negotiate}.ts` + demo endpoint `/api/hedera/a2a/demo` + 10 tests. Full round-trip: proposal → acceptance → settlement with HCS audit hook.
- [x] `polymarket-edge-trader` calls the x402 endpoint per-tick with signed payment — shipped: `lib/services/x402/{client,budget}.ts` + trader integration + 7 parity tests. Gated via `X402_TRADER_ENABLED=1`.
- [ ] Real HCS submit for x402 fills + A2A messages (currently stubbed via `HCS_AUDIT_ENABLED`)
- [ ] Optional: HTS token for internal agent credits
- [ ] Optional: Scheduled Transactions for recurring signal subscriptions

**Wallet + UX pivot (next session — Task #28, #29)**
- [ ] Replace `lib/evm-wallet/hooks.ts` shim with real wagmi + Hedera EVM chain config
- [ ] `ConnectButton` chain-family picker: Hedera EVM first, SUI second
- [ ] Dashboard defaults to Hedera pool view; SUI moves to secondary tab

### Qualification proof

- [ ] x402-gated service live on Hedera testnet, settled through Blocky402
- [ ] Agent completes at least one real paid request end-to-end
- [ ] README covers setup, architecture, payment flow, agent identities
- [ ] ≤5 min demo video showing the paid request executing + HCS audit trail
- [ ] Continuity submission clearly separates pre-existing scaffold from new x402 + activation work

---

## Priority 3 — Privy ($5K addressable) — SHIPPED 2026-09-05

### Winning angle

Two independent $2.5K tracks. B2B rewards "organization wallets, policies, team permissions, quorum approvals, intents." Financial-flow rewards "hide unnecessary onchain complexity from the user."

Most teams will use Privy for a single embedded wallet. Winning move:

**One integration serves BOTH tracks — org wallet with policies + quorum gates institutional admin ops (fee sweep, TVL cap raise, hedge reset), embedded wallet + funding tools power one-tap user deposits on Hedera.**

Fills our real product gap (the WDK-removal shim), which reads as authenticity vs demo-ware.

### Prize tracks

- [ ] **Best B2B financial product** — $2.5K
- [ ] **Best financial flow** — $2.5K

### Build checklist

**Wire Privy into the shim (Day 8-9)**
- [ ] Replace stub hooks in `lib/evm-wallet/hooks.ts` with Privy React hooks (useAccount, useWalletClient, useSignMessage, etc.)
- [ ] Configure Privy for Sepolia, Cronos, Hedera chain IDs
- [ ] Restore `lib/evm-wallet/context.ts` to bridge Privy state → existing `useWdkSafe` / `useWdkAccountSafe` API (kept for back-compat)
- [ ] Wire Privy provider back into `app/wallet-providers.tsx`
- [ ] Re-add EVM branch to `ConnectButton.tsx` (chain-family picker: SUI vs EVM)

**B2B — Privy organization wallet for admin (Day 10-11)**
- [ ] Migrate pool AdminCap operations to a Privy org wallet
- [ ] Admin actions (fee sweep, TVL cap raise, hedge reset, Aiven-kill flag flip) gated by policies + quorum (2-of-3 for most, 3-of-3 for cap raise)
- [ ] Document what's still hot vs what's org-wallet-gated

**Financial flow — user deposit UX (Day 11-12)**
- [ ] Embedded Privy wallet on Hedera for user deposits (ties into Priority 2)
- [ ] One signed intent: USDC approve + pool `deposit()`
- [ ] Onramp integrated via Privy funding tools
- [ ] Demo the flow end-to-end on Hedera testnet

### Qualification proof

- [ ] Privy is a core part of the product, not a token integration
- [ ] Uses at least one Privy wallet (embedded + org wallet = both)
- [ ] B2B track: functional workflow with policies / quorum executing admin op
- [ ] Financial flow track: complete deposit end-to-end via Privy
- [ ] Working demo + public repo + explanation of how Privy enables the product

---

## Timeline (2-week hackathon window)

**Week 1 — data plane + Hedera activation**
- Day 1-2: Redis cron-state client + Subgraph scaffold (Graph Phase 1)
- Day 3: Subgraph deployed on Sepolia, `/api/platform/nav-history` migrated (Graph Phase 2). Hedera pool contract deployed.
- Day 4: Subgraph coverage extension. Hedera cron activation.
- Day 5-6: Hedera x402 + agent consumer. Redis cutover for cron_state.
- Day 7: Substreams module + MCP wiring. Extra-points Hedera work.

**Week 2 — Privy + Aiven kill + polish**
- Day 8: Aiven kill flip + fallout fixes.
- Day 9-10: Privy shim replacement + org wallet.
- Day 11-12: Privy user deposit flow on Hedera.
- Day 13: End-to-end demo path per partner, record 3 videos.
- Day 14: Submission polish, cross-linking READMEs, buffer for bugs.

**Fallback plan:** if any partner slips, drop the weakest single track first (Hedera Continuity $1K, then Privy B2B $2.5K). Never ship a half-baked demo.

**Honorable-mention bolt-on:** if week-2 buffer opens, Bazantic recipe combining our Hedera x402 endpoint with a Graph subgraph query — $500, ~1 afternoon.

---

## Live progress tracker (updated as we ship)

| Partner | Phase | Status | Notes |
|---|---|---|---|
| The Graph | 1 · Redis client + subgraph scaffold | ✅ Shipped (135ce5a4) | Redis singleton, Standardized Vault schema, 14 parity tests |
| The Graph | 2 · Subgraph client + first endpoint | ✅ Shipped (dbb9a672) | nav-history behind SUBGRAPH_READS_ENABLED, 13 tests |
| The Graph | 3 · Coverage extension + Redis cutover | ✅ Code shipped, waits on live deploy | +4 typed queries (hedges/txs/state/member), hedging/list migrated, alert-log Redis cutover, Vercel Cron config as QStash alt, Substreams scaffold |
| The Graph | 4 · Substreams module impl + MCP | ⬜ Rust impl outstanding | Scaffold + proto in substreams/community-pool/; MCP tool next |
| The Graph | 5 · Aiven kill | ⬜ Not started | Blocked on subgraph live deploy + parity soak |
| Hedera | Pool live | ⬜ Not started | `HEDERA_AUTO_HEDGE_DISABLE` helper in place |
| Hedera | x402 endpoint | ⬜ Not started | Blocky402 facilitator |
| Hedera | Agent consumer + HCS-14 | ⬜ Not started | Multi-agent A2A budget negotiation |
| Privy | Provider wired (feature-gated) | ✅ Shipped | `app/wallet-providers.tsx` conditional on `NEXT_PUBLIC_PRIVY_APP_ID` |
| Privy | Email/social connect UI | ✅ Shipped | `components/PrivyConnectSection.tsx` |
| Privy | B2B admin route + policy + quorum | ✅ Shipped | `/api/admin/hedera-pool/quorum-action`, `lib/services/privy/admin-auth.ts`, 7 tests |
| Privy | Embedded user wallet deposit flow | ⬜ Needs app id | Wallet plumbing done — just needs live Privy app id + demo |

---

## Deliverables per partner

Every submission requires the same shape:

- Public repo link (this one)
- Track selection clearly stated (Continuity pool)
- 2-5 min demo video (per each partner's time limit)
- README section documenting pre-existing vs new work
- FEEDBACK.md where required (The Graph, others)
- Architecture diagram
- Live/deployed proof (subgraph URL, Hedera contract, Privy live app)

---

## Do NOT touch during hackathon

Non-negotiable "SUI stays safe" guardrails — everything below has been tested green and any regression risks the mainnet pool:

- `contracts/sui/**` — no Move changes without a full audit reround
- `lib/services/sui/**` — SUI-side service code is off-limits
- `app/api/cron/sui-*` — SUI crons stay as they are
- `test/integration/pool-drawdown-defense.test.ts` must stay 10/10 green as merge gate
- Anything in `lib/db/hedges.ts` write path (reconciler is load-bearing) — new Subgraph coverage replaces READS only; hedge WRITES still route through the reconciler until proven safe

If a hackathon build touches any of the above, stop and ask.

## Aiven → Redis + Graph migration safety rails

- **Never delete `lib/db/postgres.ts` before Phase 5 flip.** Dual-write during migration; single-source only after full Subgraph coverage is proven.
- **`test/integration/pool-drawdown-defense.test.ts` uses live Aiven DB today** — during migration this test needs a version that hits Redis + Subgraph fixtures. Add before removing Aiven, not after.
- **Redis TTLs matter.** `cron:lastRun:*` needs no TTL (heartbeat). Alert ring buffer = LTRIM to 200. Agent decisions = 30d TTL. Don't lose halt keys to TTL misconfig.
- **Subgraph indexing lag (typ. 1-3 blocks).** Fine for dashboard, wrong for reconciler / fill verifier. Hot paths stay on venue-direct (BlueFin API) as they are today.
- **On-chain halt flags need admin ops.** Adding `haltUntil` fields to `CommunityPool.sol` = new contract deploy. For hackathon window, keep halts in Redis; contract-level halts are v0.5.0 material.
- **Redis CAS for `tryClaimCronRun`.** Postgres has native atomic CAS via `UPDATE ... WHERE value = $prev`. Redis needs WATCH/MULTI/EXEC transaction. Get this right or you'll fire duplicate hedges under load.
