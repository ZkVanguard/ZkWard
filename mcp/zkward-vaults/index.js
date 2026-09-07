#!/usr/bin/env node
/**
 * ZkWard AI-Vaults MCP server.
 *
 * Exposes one query pattern that spans multiple indexing backends:
 *   - The Graph Studio (Sepolia subgraph) via api.studio.thegraph.com
 *   - Hedera Mirror Node adapter at zkward.com/api/subgraph/hedera
 *
 * Both endpoints share the same standardized AI-vault schema
 * (Pool / Transaction / Member / _Meta_). An AI agent connected to
 * this MCP server can query one tool and get merged results across
 * both venues — the composable / cross-protocol story in tool form.
 *
 * Tools exposed (all read-only, no signing):
 *   - vault_snapshot           — merged pool list, no args
 *   - vault_transactions       — merged recent txs, { limit? }
 *   - subgraph_query           — raw GraphQL, { endpoint, query, variables? }
 *
 * Install: cd mcp/zkward-vaults && npm install
 * Test:    node index.js  (stdio, wait for MCP client)
 * Register with Claude Desktop / Cursor: see README.md
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Endpoint configuration ────────────────────────────────────────────────

const STUDIO_URL =
  process.env.ZKWARD_STUDIO_URL ||
  'https://api.studio.thegraph.com/query/1758819/zkward/v0.1.1';
const HEDERA_URL =
  process.env.ZKWARD_HEDERA_URL ||
  'https://www.zkward.com/api/subgraph/hedera';

// ─── GraphQL helper ────────────────────────────────────────────────────────

async function runQuery(endpoint, query, variables) {
  const t0 = Date.now();
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  if (!r.ok) {
    return { errors: [{ message: `HTTP ${r.status} from ${endpoint}` }], elapsedMs: Date.now() - t0 };
  }
  const j = await r.json();
  return { ...j, elapsedMs: Date.now() - t0 };
}

// ─── Tool implementations ──────────────────────────────────────────────────

const SNAPSHOT_QUERY = `{
  pools(first: 10) {
    id
    network
    totalShares
    totalNav
    sharePrice
    memberCount
    totalFeesCollected
  }
  _meta {
    block { number timestamp }
    deployment
    hasIndexingErrors
  }
}`;

const TX_QUERY = `query($first: Int) {
  transactions(first: $first, orderBy: "timestamp", orderDirection: desc) {
    id
    type
    actor
    amount
    shares
    timestamp
    transactionHash
  }
}`;

function normalizeMicros(v) {
  if (v == null) return 0;
  return Number(v) / 1e6;
}

async function vaultSnapshot() {
  const [studio, hedera] = await Promise.all([
    runQuery(STUDIO_URL, SNAPSHOT_QUERY),
    runQuery(HEDERA_URL, SNAPSHOT_QUERY),
  ]);

  const pools = [];
  for (const [source, url, resp] of [
    ['studio', STUDIO_URL, studio],
    ['hedera-adapter', HEDERA_URL, hedera],
  ]) {
    const rawPools = resp?.data?.pools ?? [];
    for (const p of rawPools) {
      pools.push({
        source,
        endpoint: url,
        chain: p.network,
        vaultAddress: p.id,
        tvlUsdc: normalizeMicros(p.totalNav),
        totalShares: normalizeMicros(p.totalShares),
        sharePriceUsdc: normalizeMicros(p.sharePrice),
        memberCount: p.memberCount ?? 0,
        totalFeesCollectedUsdc: normalizeMicros(p.totalFeesCollected),
      });
    }
  }

  const totalTvl = pools.reduce((sum, p) => sum + p.tvlUsdc, 0);

  return {
    fetchedAt: new Date().toISOString(),
    pools,
    totals: {
      poolCount: pools.length,
      totalTvlUsdc: totalTvl,
    },
    backends: [
      { name: 'The Graph Studio', endpoint: STUDIO_URL, elapsedMs: studio?.elapsedMs ?? null, meta: studio?.data?._meta ?? null },
      { name: 'Hedera Mirror Node adapter', endpoint: HEDERA_URL, elapsedMs: hedera?.elapsedMs ?? null, meta: hedera?.data?._meta ?? null },
    ],
  };
}

async function vaultTransactions(limit = 20) {
  const first = Math.max(1, Math.min(100, Number(limit) || 20));
  const [studio, hedera] = await Promise.all([
    runQuery(STUDIO_URL, TX_QUERY, { first }),
    runQuery(HEDERA_URL, TX_QUERY, { first }),
  ]);

  const merged = [];
  for (const [source, resp] of [
    ['studio', studio],
    ['hedera-adapter', hedera],
  ]) {
    const rows = resp?.data?.transactions ?? [];
    for (const t of rows) {
      merged.push({
        source,
        type: t.type,
        actor: t.actor,
        amountUsdc: normalizeMicros(t.amount),
        shares: normalizeMicros(t.shares),
        timestamp: Number(t.timestamp || 0),
        transactionHash: t.transactionHash,
      });
    }
  }
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return {
    fetchedAt: new Date().toISOString(),
    count: merged.length,
    transactions: merged.slice(0, first),
    backends: {
      studio: { elapsedMs: studio?.elapsedMs ?? null, errors: studio?.errors ?? null },
      hedera: { elapsedMs: hedera?.elapsedMs ?? null, errors: hedera?.errors ?? null },
    },
  };
}

async function subgraphQuery(endpointName, query, variables) {
  const endpoint = endpointName === 'studio' ? STUDIO_URL
    : endpointName === 'hedera' ? HEDERA_URL
    : null;
  if (!endpoint) {
    return { error: 'endpoint must be "studio" or "hedera"' };
  }
  const resp = await runQuery(endpoint, query, variables);
  return { endpoint, ...resp };
}

// ─── MCP server wiring ─────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'zkward-vaults-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const TOOLS = [
  {
    name: 'vault_snapshot',
    description:
      'Merged snapshot of every AI-vault indexed across ALL backends (Studio subgraph + Hedera Mirror Node adapter). Returns { pools, totals, backends }. No arguments — proves the "one query spans many protocols" pattern.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'vault_transactions',
    description:
      'Recent deposit / withdraw transactions merged across every backend, ordered by timestamp desc. Use for "what happened lately in the vault ecosystem" questions.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Max rows to return (default 20).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'subgraph_query',
    description:
      'Escape hatch — run a raw GraphQL query against either backend. Same schema on both endpoints, so a query written against one runs on the other unchanged.',
    inputSchema: {
      type: 'object',
      required: ['endpoint', 'query'],
      properties: {
        endpoint: {
          type: 'string',
          enum: ['studio', 'hedera'],
          description: '"studio" = api.studio.thegraph.com … zkward, "hedera" = zkward.com/api/subgraph/hedera',
        },
        query: { type: 'string', description: 'GraphQL query string.' },
        variables: { type: 'object', description: 'Optional variables map.' },
      },
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let payload;
    switch (name) {
      case 'vault_snapshot':
        payload = await vaultSnapshot();
        break;
      case 'vault_transactions':
        payload = await vaultTransactions(args.limit);
        break;
      case 'subgraph_query':
        payload = await subgraphQuery(args.endpoint, args.query, args.variables);
        break;
      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error calling ${name}: ${e instanceof Error ? e.message : String(e)}` }],
    };
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr note so a human running this manually knows it's alive.
console.error(`[zkward-vaults-mcp] ready. studio=${STUDIO_URL} hedera=${HEDERA_URL}`);
