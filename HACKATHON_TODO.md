# ETHGlobal Online — Hackathon TODO

**Repo:** `ZkVanguard/zkward-ethglobal` (canonical production repo since 2026-09-04)
**Tracks:** 3 partners max — The Graph · Hedera · Privy
**Addressable prize pool:** ~$18,000
**Pool eligibility:** every submission is **Continuity** (live product on Sui mainnet since 2026-06-12, v0.4.0)

See `docs/HACKATHON_STRATEGY.md` for the analysis behind these three picks and why the others were skipped.

---

## Coherent story (memorize for demos)

> "Multi-chain AI-managed stablecoin pool where agents allocate capital autonomously across chains, discover on-chain state via The Graph, pay for their own inference on Hedera x402, and give users + admins first-class custody via Privy."

Each partner is load-bearing, not a token integration. Each demo video opens with 15 seconds on the pre-existing v0.4.0 mainnet product, then focuses on the new hackathon work.

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

## Priority 1 — The Graph ($10K addressable) — full Aiven retirement

**Why first:** we're **retiring Aiven Postgres entirely**, not just relieving pressure. All indexable state moves to The Graph; residual key-value state (cron heartbeats, halt keys, alert ring buffer, autohedge configs) moves to Upstash Redis (already in the stack for QStash). Zero Postgres after this. Would build this regardless of the prize. Two prize tracks addressable from one build.

### Data plane after migration

| Data | Old (Aiven) | New | Why |
|---|---|---|---|
| Pool NAV history | `community_pool_nav_history` | Subgraph indexes `NavSnapshot` events | Derivable from on-chain state |
| Hedge lifecycle | `hedges` | Subgraph indexes `HedgeOpened` / `HedgeClosed` | On-chain event stream |
| Pool state + allocations | `community_pool_state` | Subgraph (latest state per chain) | On-chain |
| Deposit / withdraw history | `community_pool_transactions` | Subgraph indexes pool events | On-chain |
| Cron heartbeats (`cron:lastRun:*`) | `cron_state` table | Upstash Redis KV | Not on-chain; 15-min TTL fine |
| Halt keys (`cron:haltUntil:*`) | `cron_state` table | Upstash Redis KV + on-chain admin flags in pool contract (Subgraph indexes) | Redis for fast cron read; on-chain as source of truth |
| Alert ring buffer | `cron_state` key | Upstash Redis LIST (native trim) | Actually a better fit than Postgres |
| Autohedge configs | `autohedge_configs` | Upstash Redis KV + on-chain pool config | Mutable user config |
| Agent decisions log | `agent_decisions` | Upstash Redis LIST (TTL 30d) | Audit trail, not queryable |
| Signal outcomes | `signal_outcomes` | Upstash Redis LIST (TTL 30d) | Same |

**Result:** Aiven Postgres retired. Reads flow through The Graph. Writes flow through on-chain contracts (indexed by Subgraph) + Upstash Redis for the residual off-chain metadata. Substreams push obviates the polling crons that were the biggest Aiven consumers.

### Prize tracks

- [ ] **Composable/Standardized Graph Products** — $5K pool (1st $2.5K · 2nd $1.5K · 3rd $1K)
- [ ] **AI Tooling / AI Use Case (Continuity)** — $5K pool (1st $2.5K · 2nd $1.5K · 3rd $1K)

### Build checklist

**Phase 1 — spike & Redis groundwork (2 days)**
- [ ] Deploy Sepolia `CommunityPool.sol` subgraph via Subgraph Studio (standardized ERC-4626-style schema from day one)
- [ ] Add `HedgeOpened` / `HedgeClosed` / `NavSnapshot` events to `CommunityPool.sol` + `HedgeExecutor.sol` if missing
- [ ] Rewrite `/api/platform/nav-history` to hit the subgraph behind `AIVEN_DISABLE` env flag (start with one endpoint)
- [ ] Set up Upstash Redis client for `cron_state` writes (`lib/db/cron-state-redis.ts`) with the same interface as current Postgres impl
- [ ] Dual-write cron_state to both Aiven and Redis during migration window

**Phase 2 — extend subgraph coverage + Redis cutover (3 days)**
- [ ] Extend subgraph to cover hedges, transactions, allocations, per-user positions
- [ ] Migrate `/api/community-pool/*` and dashboard reads to subgraph
- [ ] Cut cron_state reads from Redis (writes still dual-writing)
- [ ] Move alert ring buffer to Redis LIST (native LPUSH + LTRIM instead of read-modify-write)
- [ ] Move autohedge configs + agent_decisions + signal_outcomes to Redis
- [ ] Health endpoint (`/api/health/production`) hits Subgraph + Redis only

**Phase 3 — Substreams push replaces polling crons (2 days)**
- [ ] Package `CommunityPool.sol` events as a reusable Substreams module (matches the "composable Substreams module" prize criterion)
- [ ] Publish on the Substreams registry
- [ ] Replace `pool-nav-monitor` cron with Substreams push → dashboard SSE
- [ ] Consider replacing `bluefin-db-reconcile` polling with venue webhooks + Substreams

**Phase 4 — Subgraph MCP wired into agents + Aiven kill (2 days)**
- [ ] Add Subgraph MCP as a tool in the 7-agent orchestrator
- [ ] Replace direct `getActiveHedges()` DB reads with MCP tool calls
- [ ] Flip `AIVEN_DISABLE=1` — every read must route to Subgraph or Redis
- [ ] Delete `lib/db/postgres.ts` + Aiven env vars from Vercel
- [ ] Optional stretch: x402-paid queries when agent needs bulk historical data

### Qualification proof (per official rules)

- [ ] Public repo (this one) with README linking to hackathon README section
- [ ] Consume live data from Subgraph Studio (real API key, not mocked)
- [ ] Compose ≥ 2 Graph products (Subgraphs + Substreams + MCP)
- [ ] Standards leverage clear — one query pattern spans Cronos/Hedera/Sepolia pools
- [ ] 2-4 min demo video showing (a) old Aiven query, (b) new subgraph query, (c) agent using MCP
- [ ] FEEDBACK.md documenting what became easier

---

## Priority 2 — Hedera ($3K addressable)

**Why:** we already have `hedera-community-pool` cron scaffolded, `CommunityPool.sol` is EVM-compatible via Hashio, portfolio ID -3 reserved. Deployment path is 90% done.

### Prize tracks

- [ ] **AI & Agentic Payments on Hedera** — up to $2K (3 teams × $2K)
- [ ] **Continuity** — $1K

### Build checklist

**Live Hedera pool (2 days)**
- [ ] Deploy `CommunityPool.sol` to Hedera testnet via Hashio
- [ ] Wire hedera-community-pool cron end-to-end (already scaffolded)
- [ ] First live deposit → AI allocation → NAV snapshot on Hedera
- [ ] Add `HEDERA_AUTO_HEDGE_DISABLE` env kill switch (helper already exists — `isChainAutoHedgeDisabled('hedera')`)

**x402-gated inference (2 days)**
- [ ] Stand up an x402-gated signal-quality endpoint (wraps our existing predictions service) on Hedera testnet via Blocky402
- [ ] Modify `polymarket-edge-trader` to pay per-call in HBAR/USDC for signal quality checks
- [ ] Budget across providers (fall back to free tier when x402 balance is low)
- [ ] Log every fill on HCS for auditable payment trail

**Bonus-points signals (1 day, if time)**
- [ ] Agent identity via HCS-14 or ERC-8004
- [ ] Multi-agent A2A negotiation for signal-quality vs cost tradeoff

### Qualification proof

- [ ] x402-gated service live on Hedera testnet, settled through Blocky402
- [ ] Agent completes at least one real paid request end-to-end
- [ ] README covers setup, architecture, payment flow
- [ ] ≤5 min demo video showing the paid request executing
- [ ] Continuity submission clearly separates pre-existing hedera-community-pool scaffold from new x402 + activation work

---

## Priority 3 — Privy ($5K addressable)

**Why:** deleted WDK, left `lib/evm-wallet/hooks.ts` as a disconnected shim explicitly waiting for a universal EVM wallet. Privy IS that wallet. Prize + fills a real architectural gap.

### Prize tracks

- [ ] **Best B2B financial product** — $2.5K
- [ ] **Best financial flow** — $2.5K

### Build checklist

**Wire Privy into the shim (2 days)**
- [ ] Replace stub hooks in `lib/evm-wallet/hooks.ts` with Privy React hooks (useAccount, useWalletClient, useSignMessage, etc.)
- [ ] Configure Privy for Sepolia, Cronos, Hedera chain IDs
- [ ] Restore `lib/evm-wallet/context.ts` to bridge Privy state → existing `useWdkSafe` / `useWdkAccountSafe` API (kept for back-compat)
- [ ] Wire Privy provider back into `app/wallet-providers.tsx`
- [ ] Re-add EVM branch to `ConnectButton.tsx` (chain-family picker: SUI vs EVM)

**B2B financial product — Privy organization wallet for admin (2 days)**
- [ ] Migrate pool AdminCap operations to a Privy org wallet
- [ ] Admin actions (fee sweep, TVL cap raise, hedge reset) gated by policies + quorum
- [ ] Document what's still hot vs what's org-wallet-gated

**Financial flow — user deposit UX (2 days)**
- [ ] Embedded Privy wallet on Hedera/Sepolia for user deposits
- [ ] One signed intent: USDC approve + pool `deposit()`
- [ ] Onramp integrated via Privy funding tools
- [ ] Demo the flow end-to-end on Hedera testnet (ties into Priority 2)

### Qualification proof

- [ ] Privy is a core part of the product, not a token integration
- [ ] Uses at least one Privy wallet (embedded + org wallet = both)
- [ ] B2B track: functional workflow with policies / quorum
- [ ] Financial flow track: complete deposit end-to-end via Privy
- [ ] Working demo + public repo + explanation of how Privy enables the product

---

## Timeline (2-week hackathon window)

**Week 1 — data + Hedera activation**
- Day 1-2: The Graph Phase 1 (spike + measure Aiven relief)
- Day 3-4: The Graph Phase 2 (standardized schema + coverage extension)
- Day 5-7: Hedera pool activation + x402-gated inference

**Week 2 — Privy + polish**
- Day 8-9: Privy wiring (replace shim)
- Day 10-11: Privy org wallet + embedded wallet flows
- Day 12: The Graph Phase 3+4 (Substreams module + MCP tool)
- Day 13: End-to-end demo path per partner, record 3 videos
- Day 14: Submission polish, cross-linking, buffer for bugs

**Fallback plan:** if any partner slips, drop the weakest single track first (Hedera Continuity $1K, then Privy B2B $2.5K). Never ship a half-baked demo.

**Honorable-mention bolt-on:** if week-2 buffer opens, drop in a Bazantic recipe combining our Hedera x402 endpoint with a Graph subgraph query — $500, ~1 afternoon.

---

## Deliverables per partner

Every submission requires the same shape:

- Public repo link (this one)
- Track selection clearly stated (Continuity pool)
- 2-5 min demo video (per each partner's time limit)
- README section documenting pre-existing vs new work
- FEEDBACK.md where required (The Graph, some others)
- Architecture diagram
- Live/deployed proof (subgraph URL, Hedera contract, Privy live app)

---

## Live progress tracker (updated as we ship)

| Partner | Phase | Status | Notes |
|---|---|---|---|
| The Graph | Phase 1 spike + Redis groundwork | ⬜ Not started | Sepolia subgraph + Redis cron_state client |
| The Graph | Phase 2 coverage + Redis cutover | ⬜ Not started | Subgraph covers hedges/txs; Aiven reads gone |
| The Graph | Phase 3 Substreams | ⬜ Not started | pool-nav-monitor → push |
| The Graph | Phase 4 MCP + Aiven kill | ⬜ Not started | `AIVEN_DISABLE=1`, delete postgres.ts |
| Hedera | Pool live | ⬜ Not started | `HEDERA_AUTO_HEDGE_DISABLE` helper already in place |
| Hedera | x402 endpoint | ⬜ Not started | Blocky402 facilitator |
| Hedera | Agent consumer | ⬜ Not started | Wire into `polymarket-edge-trader` |
| Privy | Shim replaced | ⬜ Not started | `lib/evm-wallet/hooks.ts` swap |
| Privy | Org wallet admin | ⬜ Not started | AdminCap ops |
| Privy | Embedded user wallet | ⬜ Not started | Hedera deposit flow |

---

## Do NOT touch during hackathon

Non-negotiable "SUI stays safe" guardrails — everything below has been tested green and any regression risks the mainnet pool:

- `contracts/sui/**` — no Move changes without a full audit reround
- `lib/services/sui/**` — SUI-side service code is off-limits
- `app/api/cron/sui-*` — SUI crons stay as they are
- `test/integration/pool-drawdown-defense.test.ts` must stay 10/10 green as merge gate
- Anything in `lib/db/hedges.ts` write path (reconciler is load-bearing) — new Subgraph coverage replaces READS only; hedge WRITES still route through the reconciler until proven safe

## Aiven → Redis + Graph migration safety rails

- **Never delete `lib/db/postgres.ts` before Phase 4 flip.** Dual-write during migration; single-source only after full Subgraph coverage is proven.
- **`test/integration/pool-drawdown-defense.test.ts` uses live Aiven DB today** — during migration this test needs a version that hits Redis + Subgraph fixtures. Add before removing Aiven, not after.
- **Redis TTLs matter.** `cron:lastRun:*` needs no TTL (heartbeat). Alert ring buffer = LTRIM to 200. Agent decisions = 30d TTL. Don't lose halt keys to TTL misconfig.
- **Subgraph indexing lag (typ. 1-3 blocks).** Fine for dashboard, wrong for reconciler / fill verifier. Hot paths stay on venue-direct (BlueFin API) as they are today.
- **On-chain halt flags need admin ops.** Adding `haltUntil` fields to `CommunityPool.sol` = new contract deploy. For hackathon window, keep halts in Redis; contract-level halts are v0.5.0 material.

If a hackathon build touches any of the above, stop and ask.
