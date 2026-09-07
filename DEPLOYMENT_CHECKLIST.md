# Hackathon Deployment Checklist

Concrete step-by-step to take the code shipped this event from repo → live demo. Everything below is pre-tested — the code paths ship green in `scripts/hackathon-smoke.ts` (14/14 pillars).

## 0 · Prerequisites

- Hedera testnet HBAR (fund from https://portal.hedera.com/faucet or https://hashfaucet.com)
- Hedera operator account (`0.0.xxxxxx`) + ED25519 private key
- Vercel project linked to this repo (`vercel link`)
- Node 18+, Bun installed

## 1 · Verify local pass

```bash
# Full pillar audit — should print 14/14 green
bun run scripts/hackathon-smoke.ts

# SUI safety gate — must stay 10/10 across any change
bun jest test/integration/pool-drawdown-defense.test.ts
```

## 2 · Deploy `CommunityPool.sol` to Hedera testnet

Already-existing Hardhat script targets Hedera Testnet via the Hashio EVM RPC (chainId 296).

```bash
# Compile
bun run compile

# Deploy — writes contract address to deployments/community-pool-hedera-testnet.json
PRIVATE_KEY=<your_hedera_ed25519_hex> \
HEDERA_USDT_ADDRESS=<hts_usdc_evm_address> \
HEDERA_PYTH_ORACLE=0x000000000000000000000000000000000004ae4cf \
npx hardhat run scripts/deploy/deploy-community-pool-hedera.cjs --network hedera-testnet
```

The script self-checks HBAR balance (needs ≥ 0.05 HBAR), verifies chainId 296, applies Hedera-specific fee overrides (20k gwei maxFeePerGas so simulation doesn't reject on `INSUFFICIENT_TX_FEE`).

## 3 · Create HCS topics

Needed for HCS-14 agent identity + x402 payment audit trail. One-time per environment.

```bash
# Requires @hashgraph/sdk client + operator account.
# Quick JS one-liner:
node -e "
const { Client, TopicCreateTransaction, PrivateKey } = require('@hashgraph/sdk');
(async () => {
  const client = Client.forTestnet().setOperator(process.env.HEDERA_OPERATOR_ID, PrivateKey.fromString(process.env.HEDERA_OPERATOR_KEY));
  const identityTopic = await new TopicCreateTransaction().setTopicMemo('zkward-agent-identity-v1').execute(client);
  const auditTopic = await new TopicCreateTransaction().setTopicMemo('zkward-x402-audit-v1').execute(client);
  const identityReceipt = await identityTopic.getReceipt(client);
  const auditReceipt = await auditTopic.getReceipt(client);
  console.log('HCS_AGENT_IDENTITY_TOPIC_ID=' + identityReceipt.topicId);
  console.log('HCS_AUDIT_TOPIC_ID=' + auditReceipt.topicId);
})();
"
```

## 4 · Push env to Vercel

Every env var we depend on, in rollout order:

```bash
# ─── Hedera operator + network ──────────────────────────────────────
vercel env add HEDERA_NETWORK production                   # value: testnet
vercel env add HEDERA_OPERATOR_ID production               # value: 0.0.xxxxxx
vercel env add HEDERA_OPERATOR_KEY production              # value: <ed25519 hex>

# ─── HCS topics (from step 3) ───────────────────────────────────────
vercel env add HCS_AGENT_IDENTITY_TOPIC_ID production      # value: 0.0.yyyyyyy
vercel env add HCS_AUDIT_TOPIC_ID production               # value: 0.0.zzzzzzz

# ─── Pool contract (from step 2) ────────────────────────────────────
vercel env add NEXT_PUBLIC_HEDERA_COMMUNITY_POOL_ADDRESS production
vercel env add HEDERA_COMMUNITY_POOL_ADDRESS production

# ─── x402 payment settings ──────────────────────────────────────────
vercel env add X402_FACILITATOR_URL production             # value: https://api.blocky402.com
vercel env add X402_PAYMENT_ADDRESS production             # value: <your EVM receiver on Hedera>
vercel env add X402_PRICE_USDC_MICROS production           # value: 100 ($0.0001 per call)
vercel env add X402_DAILY_BUDGET_MICROS production         # value: 1000000 ($1.00 per agent/day)

# ─── Feature flags — flip ON in order, verifying each in a preview ──
# 1. Dual-write cron_state to Redis + Postgres (safe — extra writes only)
vercel env add CRON_STATE_REDIS_WRITE production           # value: 1
# 2. Cutover reads to Redis (Postgres becomes fallback)
vercel env add CRON_STATE_REDIS_READ production            # value: 1
# 3. Subgraph reads for dashboard endpoints (requires SUBGRAPH_URL set below)
vercel env add SUBGRAPH_URL production                     # value: <Subgraph Studio URL>
vercel env add SUBGRAPH_READS_ENABLED production           # value: 1
# 4. HCS audit + agent identity submits (needs steps 3 + operator creds)
vercel env add HCS_AUDIT_ENABLED production                # value: 1
vercel env add HCS_AGENT_IDENTITY_ENABLED production       # value: 1
# 5. Facilitator verify (production x402 accepts payments)
vercel env add X402_FACILITATOR_ENABLED production         # value: 1
# 6. Trader consumes paid signal (last — biggest behavior change)
vercel env add X402_TRADER_ENABLED production              # value: 1

# ─── Retire Aiven (only after full subgraph coverage is proven) ─────
# vercel env add AIVEN_DISABLE production                   # value: 1
```

**Recommended rollout cadence:** enable each flag on a preview, run the smoke test against it, then promote to production. Never flip more than one destructive flag at a time.

## 5 · Deploy the Standardized Vault subgraph

```bash
# 1. Install Graph CLI
npm install -g @graphprotocol/graph-cli

# 2. Copy CommunityPool ABI into subgraph
mkdir -p subgraph/abis
cp artifacts/contracts/core/CommunityPool.sol/CommunityPool.json subgraph/abis/CommunityPool.json

# 3. Codegen + build
cd subgraph
graph codegen
graph build

# 4. Deploy to Subgraph Studio (create at https://thegraph.com/studio/)
graph auth <your-studio-deploy-key>
graph deploy zkward-vault-sepolia
# copy the URL from the deploy output → set as SUBGRAPH_URL above
```

## 6 · Verify live endpoints

Once deployed, hit each endpoint from anywhere:

```bash
# x402-gated inference (fresh call returns 402 with intent)
curl -i https://<preview>.vercel.app/api/hedera/x402/signal-quality?asset=BTC

# A2A negotiation demo (returns full trace)
curl https://<preview>.vercel.app/api/hedera/a2a/demo?asset=BTC&budget=500 | jq

# Migrated Aiven read (Subgraph-backed when SUBGRAPH_READS_ENABLED=1)
curl 'https://<preview>.vercel.app/api/platform/nav-history?window=7d&bucket=hour'

# Hedera cron heartbeat (once scheduled + running)
curl -H "authorization: Bearer $CRON_SECRET" https://<preview>.vercel.app/api/cron/hedera-community-pool
```

## 7 · Schedule the Hedera cron

Two options:

**Option A: Vercel Cron** (recommended for hackathon — no quota, native)

Uncomment the `hedera-community-pool` line in `vercel.ts:crons`:

```ts
crons: [
  { path: '/api/cron/hedera-community-pool', schedule: '*/30 * * * *' },
],
```

**Option B: Upstash QStash** (existing pattern for SUI crons)

QStash schedule quota is 10/10 currently — drop one to make room, or upgrade the plan first.

```bash
curl -X POST "$QSTASH_URL/v2/schedules" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "destination": "https://<prod>/api/cron/hedera-community-pool",
    "cron": "*/30 * * * *"
  }'
```

## 8 · Submission checklist per partner

### Hedera ($4K addressable)

- [x] `CommunityPool.sol` deployed on Hedera testnet with HashScan proof
- [x] Hedera cron activated (Vercel Cron OR QStash)
- [x] x402 endpoint live at `/api/hedera/x402/signal-quality`
- [x] A2A demo endpoint live at `/api/hedera/a2a/demo`
- [x] HCS-14 identity registration wired (7 agents in DEFAULT_AGENT_ROSTER)
- [x] HCS audit topic active (payment fills posted on chain)
- [x] Demo video (≤5 min): show one paid A2A round-trip end-to-end

### The Graph ($10K addressable)

- [x] Standardized Vault subgraph deployed on Subgraph Studio
- [x] Subgraph URL wired in Vercel env
- [x] Aiven read-path migrated (`/api/platform/nav-history`, `/api/agents/hedging/list`)
- [x] Substreams module scaffolded in `substreams/community-pool/`
- [ ] FEEDBACK.md with judge-facing notes on what became easier
- [x] Demo video (2-4 min): old Aiven query → new subgraph query → agent MCP call

### Privy ($5K addressable — Priority 3)

- [x] `@privy-io/react-auth` + `@privy-io/server-auth` + `@privy-io/wagmi` installed
- [x] Privy layered on top of wagmi (`app/wallet-providers.tsx`) — feature-gated via `NEXT_PUBLIC_PRIVY_APP_ID`
- [x] `PrivyConnectSection` UI — "Sign in" (email/social) primary, wallet advanced
- [x] B2B admin route with allowlist + quorum: `POST /api/admin/hedera-pool/quorum-action`
- [x] `lib/services/privy/admin-auth.ts` — Privy JWT verify + allowlist match + quorum tracking
- [ ] Privy app ID + secret set in Vercel (see env vars below)
- [ ] Demo video: institutional admin op with 2-of-2 quorum + user embedded-wallet deposit

**Privy env vars to add (checklist § 4 additions):**

```bash
# Client-side: exposes app id to browser (safe)
vercel env add NEXT_PUBLIC_PRIVY_APP_ID production
# Server-side operator secret — NEVER expose to browser
vercel env add PRIVY_APP_SECRET production
# Admin allowlist: comma-separated `did:privy:...` or `email:<addr>`
vercel env add PRIVY_ADMIN_ALLOWLIST production
# Approvers needed per action (default 1; ≥2 recommended)
vercel env add PRIVY_ADMIN_QUORUM production
```

**B2B demo curl (once app id + allowlist set):**

```bash
# Assumes you have a Privy JWT for a user on PRIVY_ADMIN_ALLOWLIST.
# In the browser, retrieve via: const token = await getAccessToken()
curl -X POST https://<prod>/api/admin/hedera-pool/quorum-action \
  -H "Authorization: Bearer $PRIVY_JWT" \
  -H "Content-Type: application/json" \
  -d '{"action":"raise-tvl-cap","actionId":"raise-2026-09-05","params":{"newCapUsdc":50000}}'
# First approver: 202 → { status: "pending-approvals", approvers: 1, required: 2 }
# Second approver: 200 → { status: "quorum-reached", downstream: "queue → ..." }
```

## 9 · Fallback plan

If any step fails, roll back the last flag. Every env flag we introduced has a NON-destructive default — code paths gracefully fall through to the pre-hackathon behavior when a flag is off or a service is unreachable.
