# Composable Substreams Module — CommunityPool Vault Events

Reusable Substreams module for `CommunityPool.sol` — the AI-managed vault contract deployed to Sepolia, Cronos, and (planned) Hedera. Emits a normalized stream of vault events that any downstream sink can consume: subgraphs, custom indexers, dashboard SSE, alert pipelines.

Directly targets the Graph prize wording:

> **"Contributing a new composable Substreams module for an emerging standard, such as ERC-4626 tokenized-vault flows, also counts."**

## Why

Polling the pool contract via QStash cron (`pool-nav-monitor` every 15min) has three costs:

1. Eats a QStash schedule slot (10/10 cap on our plan).
2. Fires one Aiven Postgres write per tick even when nothing changed.
3. Adds 15-min lag between the on-chain state change and dashboard update.

Substreams replaces polling with push: the module produces `NavSnapshot`, `Rebalance`, `PoolHedgeOpened`, `PoolHedgeClosed`, `Deposit`, `Withdraw` events at block cadence. Consumers subscribe once, get every event in order, no polling.

## Module inputs / outputs

- **Input:** `sf.ethereum.type.v2.Block` (raw Ethereum blocks from the Substreams provider)
- **Output:** `zkward.vault.v1.VaultEvents` (proto-defined event union — see `proto/vault.proto`)
- **Chains supported:** Sepolia (chainId 11155111), Cronos mainnet (25), Cronos testnet (338), Hedera testnet/mainnet (296/295)
- **Cardinality:** one `VaultEvents` message per block containing 0..N events

## Files (to build)

```
substreams/community-pool/
├── README.md              # this file
├── Cargo.toml             # Rust module manifest
├── substreams.yaml        # module manifest (inputs, outputs, network)
├── proto/
│   └── vault.proto        # VaultEvents union definition
├── src/
│   └── lib.rs             # map_vault_events handler
└── abi/
    └── CommunityPool.json # ABI copy for eth_call sig-decoding
```

## Deployment steps (once implemented)

```bash
# 1. Install Substreams CLI
brew install streamingfast/tap/substreams

# 2. Build
substreams pack

# 3. Deploy to the Substreams registry (matches "reusable module" prize criterion)
substreams registry publish

# 4. Consumers subscribe via streaming-fast SDK or as a subgraph data source
```

## Consumer pattern — subgraph replacement for pool-nav-monitor

Instead of the current QStash-triggered polling cron writing to Aiven's `community_pool_nav_history` table, the subgraph in `subgraph/` will ingest this Substreams module as its data source. Result: one contract → one module → one subgraph → every downstream reader gets sub-block latency.

## Standards leverage

The `VaultEvents` proto union is intentionally generic:

- `NavSnapshot { totalNav, totalShares, sharePrice, timestamp }`
- `Rebalance { previousBps[], newBps[], reasonHash, executor }`
- `HedgeOpened { hedgeId, pairIndex, collateralAmount, leverage, isLong, reasonHash }`
- `HedgeClosed { hedgeId, realizedPnl, reasonHash }`
- `Deposit { member, amountUsd, sharesMinted, sharePrice }`
- `Withdraw { member, sharesBurned, amountUsd, sharePrice }`
- `FeesCollected { managementFee, performanceFee }`

Any AI-managed vault protocol that emits the equivalent events on-chain can plug into this module by swapping the contract address in `substreams.yaml` — no protobuf changes. That's the "one pipeline reused across chains" criterion the Graph judges' rubric explicitly rewards.

## Status

**Scaffolded (this PR).** Full Rust implementation lands in Phase 4 alongside the module publish. The scaffold defines the interface contract; the implementation reads the ABI and decodes logs into the proto union.
