# ZkWard Standardized Vault Subgraph

Proposed **Standardized Subgraph schema for AI-managed vaults**. Category-creating standards work: one query pattern that works across every AI vault protocol on every chain.

## Why this exists

Messari's Standardized Subgraphs cover DEXs, lending markets, yield aggregators — but not AI-managed vaults. AI vaults have a distinct data model:

- **Rebalance events carry a `reasonHash`** — keccak of the off-chain AI reasoning, so the on-chain event points at an auditable off-chain decision log.
- **Hedges have their own lifecycle** (opened / closed / realized PnL) separate from spot allocation.
- **Fees split management vs performance** — two independent revenue streams.

This subgraph defines a shared schema for that category and demonstrates it on `CommunityPool.sol` deployed to Sepolia. The same schema drops onto any chain (Cronos / Hedera / Arbitrum) with the same contract or event surface.

## Reference deployment

- **Contract:** [`0x07d68C2828F35327d12a7Ba796cCF3f12F8A1086`](https://sepolia.etherscan.io/address/0x07d68C2828F35327d12a7Ba796cCF3f12F8A1086) (Sepolia CommunityPool proxy)
- **Chain:** Sepolia testnet (chainId 11155111)
- **Events indexed:** `Deposited`, `Withdrawn`, `Rebalanced`, `RebalanceTradeExecuted`, `AllocationUpdated`, `PoolHedgeOpened`, `PoolHedgeClosed`, `FeesCollected`, `FeesWithdrawn`, `MemberJoined`

## Deploy steps

```bash
# 1. Install Graph CLI
npm install -g @graphprotocol/graph-cli

# 2. Copy the CommunityPool ABI into ./abis/
mkdir -p abis
# Paste the CommunityPool ABI JSON as ./abis/CommunityPool.json
# (Extract from artifacts/contracts/core/CommunityPool.sol/CommunityPool.json)

# 3. Codegen (generates AssemblyScript types from schema.graphql + ABI)
graph codegen

# 4. Build
graph build

# 5. Deploy to Subgraph Studio
graph auth <YOUR_DEPLOY_KEY>
graph deploy zkward-vault-sepolia
```

## Example queries

**Latest 10 NAV snapshots (replaces `SELECT * FROM community_pool_nav_history LIMIT 10`):**

```graphql
{
  navSnapshots(first: 10, orderBy: timestamp, orderDirection: desc) {
    totalNav
    totalShares
    sharePrice
    timestamp
  }
}
```

**All open hedges with reason-hash pointer:**

```graphql
{
  hedges(where: { status: OPEN }) {
    id
    pairIndex
    collateralAmount
    leverage
    isLong
    openReasonHash
    openedAtTimestamp
  }
}
```

**Cross-chain query template (same shape on any chain the schema is deployed to):**

```graphql
{
  pool(id: "0x07d68c2828f35327d12a7ba796ccf3f12f8a1086") {
    totalNav
    sharePrice
    memberCount
    allocations { assetIndex targetBps }
    rebalances(first: 5, orderBy: timestamp, orderDirection: desc) {
      reasonHash
      newBps
      trades { assetIndex amountIn amountOut isBuy }
    }
  }
}
```

## Standards-leverage story (for the hackathon judges)

The Composable/Standardized Graph Products track rewards work where "one query pattern spans many protocols." That's exactly what this schema enables:

- **Today:** ZkWard on Sepolia (this deployment)
- **Same schema, next week:** ZkWard on Hedera (chainId 296) and Cronos (chainId 25)
- **Same schema, any future AI vault:** a competitor that emits the same event surface gets indexed the same way — no per-protocol query rewrite

That's the "one query pattern spanning many protocols" test the judges' rubric points at.

## Reusable Substreams module

A companion **Substreams module** for `CommunityPool.sol` events lives at `../substreams/community-pool/` (Phase 4 of `HACKATHON_TODO.md`). Push-based delivery of the same event set — swap this subgraph's polling ingestion for the module and any chain with a Substreams provider gets sub-block latency.
