# zkward-vaults-mcp

MCP server exposing ZkWard's standardized AI-vault schema to AI agents. One tool call fans out to multiple indexing backends and returns merged results — the composable / cross-protocol pattern in tool form.

## What it does

Backends this server queries:

| Endpoint | Backend | Chain |
|---|---|---|
| `https://api.studio.thegraph.com/query/1758819/zkward/v0.1.1` | The Graph Studio | Sepolia |
| `https://www.zkward.com/api/subgraph/hedera` | `@zkward/hedera-graphql-adapter` (Mirror Node bridge — open source, drop into any Hedera dApp) | Hedera testnet |

Both return the SAME GraphQL schema (`pools`, `transactions`, `members`, `_meta`). The MCP server merges responses, so an AI agent can ask *"what's the TVL across all AI vaults"* and get one number.

**Why this matters for MCP:** The Graph doesn't index Hedera. Without our adapter, an MCP over subgraphs would leave Hedera dark. With it, the same tool queries both a Studio-hosted subgraph AND a Hedera contract with zero difference in shape — and any other Hedera dApp using [`@zkward/hedera-graphql-adapter`](../../packages/hedera-graphql-adapter) can be added by pointing the tool at a new URL.

## Tools

### `vault_snapshot()`

No arguments. Returns pools from every backend under one array, plus per-backend metadata (latency, block, indexing status).

```
{
  "pools": [
    { "source": "studio", "chain": "sepolia", "tvlUsdc": 0, "memberCount": 0, ... },
    { "source": "hedera-adapter", "chain": "hedera-testnet", "tvlUsdc": 987.36, "memberCount": 1, ... }
  ],
  "totals": { "poolCount": 2, "totalTvlUsdc": 987.36 },
  "backends": [...]
}
```

### `vault_transactions({ limit? })`

Recent deposit/withdraw transactions merged across backends, sorted by timestamp desc. Default `limit: 20`, max 100.

### `subgraph_query({ endpoint, query, variables? })`

Escape hatch — raw GraphQL query against either `"studio"` or `"hedera"`. Same schema on both, so a query written against one runs on the other unchanged.

## Install + run locally

```bash
cd mcp/zkward-vaults
npm install
node index.js
```

The server speaks MCP over stdio — it stays alive waiting for an MCP client to connect. Use with Claude Desktop, Cursor, or any MCP-compatible LLM tool.

## Verify end-to-end (no MCP client needed)

```bash
node test-e2e.mjs
```

Spawns the server, sends `initialize` → `tools/list` → `tools/call vault_snapshot` → `tools/call attested_vault_snapshot` → `tools/call subgraph_query`, and asserts every response is well-formed JSON with real data. Passes 5/5 checks against live prod endpoints, including an HCS attestation anchored during the run. This is the fastest way for a judge to confirm the MCP server actually works.

## Register with Claude Desktop

Add to `~/.claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "zkward-vaults": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/zkward-vaults/index.js"]
    }
  }
}
```

Restart Claude Desktop. In a new chat, ask *"snapshot the vaults"* or *"what recent deposits happened across the AI vaults?"* — the model will call the MCP tools automatically.

## Register with Cursor

Same JSON shape in Cursor's MCP settings pane.

## Environment overrides

Both endpoints default to production URLs. Override for local dev or a fork:

```
ZKWARD_STUDIO_URL=https://api.studio.thegraph.com/query/.../my-fork
ZKWARD_HEDERA_URL=http://localhost:3000/api/subgraph/hedera
```

## Prize alignment

- **The Graph — Composable Subgraph** (Composable prize): one query pattern spans two indexing backends, exposed to AI agents as one tool.
- **The Graph — AI Continuity**: the MCP tool surface makes the subgraph "AI-native" — it's not just a REST endpoint judges have to know how to hit, it's a tool the model calls itself.

## Why this matters

Standard subgraphs are queried by dashboards and analytics tools written by humans. MCP puts the same query surface behind an AI-agent tool, which means:

1. An LLM agent can decide *when* to query the vault state (e.g., before executing a trade).
2. The same code that reads Sepolia via The Graph reads Hedera via our adapter — one schema, N backends, one AI tool.
3. Any future AI vault protocol that adopts the same schema gets the same MCP tool for free.

That's the "one query pattern across many protocols" test the composable / standardized track points at, delivered in the interface AI agents actually use.
