# Demo video scripts — ETHOnline 2026 Hedera track

Three videos, ≤5 min each. One per prize. Record with any screen-recorder + a short voiceover. Each script maps 1:1 to a qualification requirement so nothing gets missed on judging.

Recording tips:
- Full-screen browser (hide bookmark bar) at 1440×900 or larger
- Voiceover in one take — cut later if needed
- HashScan tabs at 100% zoom, code shown at 125% or larger
- Show the URL bar so judges see the real domain

---

## Video 1 — AI & Agentic Payments ($6K)

**Runtime target: 4 min 30 s.**

### 0:00–0:30 — Setup + the ask

- Open `https://www.zkward.com/`
- Voice: "ZkWard is a multichain AI vault. On Hedera Testnet we ship a pay-per-call inference endpoint that agents pay for in USDC, no API keys, no subscriptions. Every settled call writes an audit entry to Hedera Consensus Service. Live for anyone to use."
- Cut to the dashboard.

### 0:30–1:30 — The x402 endpoint itself

- Open a new tab: `https://www.zkward.com/api/hedera/x402/signal-quality?asset=BTC`
- Voice: "GET request with no payment header — HTTP 402 with the intent."
- Highlight in the JSON response:
  - `scheme: "exact"`, `network: "hedera-testnet"`
  - `maxAmountRequired: "100"` → **"sub-cent metering, $0.0001 per call"**
  - `payTo: 0xDB89…3bC8A` → the operator wallet on Hedera testnet
  - `facilitator: "https://api.blocky402.com"` → **"Blocky402 configured, real API host"**
  - `x402Version: 2`, `network: "hedera:testnet"` → **"spec-compliant intent matching Blocky402's `/supported` shape"**

### 1:30–3:00 — Live paid call from the dashboard

- Dashboard → `Agent Payments` tab
- Voice: "One-click paid call. Pick an asset. This wires the same x402 client-side flow any agent would use."
- Click **Buy signal · $0.0001** on BTC
- When response lands, highlight:
  - `signal: BULLISH`, `confidence: 59%`, `source: PredictionAggregatorService v0.4.0`
  - `hcs.txId` — click **HCS audit entry** → HashScan opens with the real Hedera transaction
  - `verification.mode` + `verification.facilitator` — **"the response is transparent about how verification ran"**
- Voice: "This is real. Real Hedera transaction, real HCS topic entry, real signal computed by the vault's aggregator."

### 3:00–4:00 — Multi-agent / A2A trace

- Open `/api/hedera/a2a/demo` (or the dashboard A2A section if present)
- Voice: "A2A negotiation between an analyst agent and an executor agent — proposal, acceptance, settlement — all in one round trip."
- Show the JSON: proposal → acceptance → settlement → paid inference result

### 4:00–4:30 — HCS audit trail proof

- Open `https://hashscan.io/testnet/topic/0.0.10393879`
- Voice: "Every paid call, immutable, public. Topic 0.0.10393879. Anyone can audit the vault's inference receipts."
- Scroll through recent messages.

### 4:30 — Close

- Cut to GitHub: `github.com/ZkVanguard/zkward-ethglobal`
- Voice: "Public repo, running in production, live x402 endpoint you can call right now. Thanks."

---

## Video 2 — Hedera Harness contribution ($2K)

**Runtime target: 3 min 30 s.**

### 0:00–0:30 — The gap

- Open `github.com/hedera-dev/hedera-harness/pull/43`
- Voice: "Hedera Harness has Tier 2 — Playwright — and Tier 3.5 — real signed testnet transactions. Between them there's a gap: no free way to assert 'this contract deploy target lives on-chain' or 'this HCS topic exists' without burning HBAR. My PR adds a Tier 2.5 Mirror Node validator that fills it."

### 0:30–2:00 — The code

- Show `src/validation/mirrorNode.ts` in the PR
- Voice: "Five assertion kinds — `contract-exists`, `token-exists`, `account-exists`, `topic-exists`, `recent-contract-call`. All read-only REST GETs against Hedera Mirror Node. Zero HBAR cost, no operator credentials required."
- Highlight the timeout + retry + exp-backoff logic — "handles Mirror's 2–4s indexer lag cleanly"
- Show the ValidationFinding shape — matches the existing harness pattern

### 2:00–3:00 — Running the tests

- Terminal: `cd hedera-harness && npm run build && node --test test/mirror-node.test.mjs`
- Voice: "Five node:test cases. Real testnet mirror calls. Passes."
- Show the `# tests 5, # pass 5` output.

### 3:00–3:30 — Docs + close

- Show `docs/mirror-node-validator.md` — YAML config example, tier comparison table, failure codes
- Voice: "Full docs with a tier comparison so future contributors know when Tier 2.5 wins over Tier 3.5. PR is open, tests green, ready for review."
- End on the PR page.

---

## Video 3 — Continuity ($1K)

**Runtime target: 3 min.**

### 0:00–0:30 — The baseline

- Open README §Continuity
- Voice: "ZkWard is a multichain AI vault. The SUI USDC pool has been live on mainnet since June 2026. This event, we brought the full stack to Hedera Testnet."

### 0:30–1:30 — What's new — Hedera code path

- Highlight the *Hedera track* table in the README
- Call out three commit hashes:
  - `a3627a97` — SimpleUsdcVault + test USDC deployed on Hedera testnet
  - `656ffab4` — HCS audit trail live (topic `0.0.10393879`)
  - `7911f218` — Agent Payments dashboard tab (x402 flow one-click demo)
- Voice: "Seventeen Hedera commits, split by prize track, every hash clickable."

### 1:30–2:30 — Show it live

- Dashboard → Pool tab → Hedera → point at:
  - Real balance chip (USDC balance from Mirror Node)
  - Recent activity feed (real deposit events)
  - Projected pool hedges (live prices)
  - Faucet button
  - Deposit → real tx
- Voice: "Everything on this tab is new work from this event. Real vault contract, real events, real prices."

### 2:30–3:00 — Roadmap + close

- Show the CHANGELOG or a short roadmap slide:
  - Real EIP-3009 signing for x402 payments
  - ATS-managed collateral vault (deferred this event, next up)
  - Graph subgraph for cross-vault comparison (blocked on Studio CORS ticket)
- Voice: "Continuity means shipping forward, not resubmitting. The Hedera chapter is now real, and the roadmap doesn't stop here."

---

## Video 4 — Graph × Hedera bridge (Composable + AI Continuity, $10K total)

**Runtime target: 3 min 30 s.** Covers both Graph tracks in one clip.

### 0:00–0:30 — The gap being closed

- Open `https://thegraph.com/explorer` → search "hedera" → 0 results.
- Voice: "The Graph indexes 129 EVM chains. Hedera isn't one of them. Every Graph-native tool — MCP servers, subgraph SKILLs, standardized queries — leaves Hedera dark. We built the bridge."
- Cut to `packages/hedera-graphql-adapter/README.md`.

### 0:30–1:15 — The library, on npm

- Terminal: `npm view @zkward/hedera-graphql-adapter version` → 0.1.0
- Voice: "Published to npm today. Any Hedera dApp can drop it into their stack — one config, standardized subgraph endpoint."
- Show the four exports: `createHederaGraphQLAdapter`, `MirrorClient`, event helpers, canonical hash.
- Terminal: `npm install @zkward/hedera-graphql-adapter` — install progress bar visible.

### 1:15–2:15 — Cross-backend parity in one command

- Terminal: `bun run scripts/demo-graph-parity.ts`
- Voice: "Same GraphQL query against two backends. Studio subgraph on Sepolia. Our Hedera adapter on testnet. Same shape. Same schema. Two different indexers, two different chains."
- Show:
  - Studio side: block number, schema green, hasIndexingErrors=false
  - Hedera side: real pool, TVL $987, 3 members, hedera-testnet
  - HCS attestation: seq number + txId + explorer link
  - Verify path: hash byte-match confirmation
- Voice punch: "That's the standards leverage. And every response can be cryptographically anchored on Hedera Consensus Service so an AI agent has proof of what it queried."

### 2:15–3:00 — MCP tool an AI agent can call

- Open Claude Desktop (or terminal): `cd mcp/zkward-vaults && node test-e2e.mjs`
- Voice: "Same schema, exposed as an MCP tool. AI agents can ask 'snapshot the vaults' and get merged data from both backends in one call. Live attestation captured during the test run."
- Show the 5/5 result including the HCS seq number that landed WHILE the test was running.

### 3:00–3:30 — Judges dashboard + close

- Open `https://www.zkward.com/judges` — 10/10 green.
- Voice: "Every claim we've made is live, on this URL, right now. Same schema, two chains, one tool. Adapter's on npm. That's the composable standard."

**Assets to have ready:**
- Terminal windows pre-warmed (`bun run` and `node test-e2e.mjs` outputs visible)
- Claude Desktop config already set up (or use the terminal test as substitute)
- npm.com/package/@zkward/hedera-graphql-adapter tab open

---

## Submission checklist

Per prize, when submitting:

- [ ] Public repo URL: `github.com/ZkVanguard/zkward-ethglobal`
- [ ] Demo video URL (YouTube unlisted works)
- [ ] Live prod URL: `https://www.zkward.com`
- [ ] Endpoint URL to hit (AI track): `https://www.zkward.com/api/hedera/x402/signal-quality?asset=BTC`
- [ ] HashScan links: vault `0xe7E6fEDce9d72D112137B631E8D51831D30729A9`, USDC `0x704365B35AeF0b7F9fc17c18B5162D4A6d600ae1`, HCS topic `0.0.10393879`
- [ ] PR URL (Harness track): `github.com/hedera-dev/hedera-harness/pull/43`
- [ ] Wallet address: `0xDB89EC1c81dcD362FB0F9CA3da232697b583bC8A` (operator, Hedera testnet)
- [ ] npm package URL (Graph track): `https://www.npmjs.com/package/@zkward/hedera-graphql-adapter`
- [ ] Live judges dashboard: `https://www.zkward.com/judges`
- [ ] Subgraph on Studio: `https://api.studio.thegraph.com/query/1758819/zkward/v0.1.1`
