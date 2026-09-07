# hedera-graphql-adapter — design

## The problem

The Graph doesn't index Hedera (verified via the official networks
registry — 129 EVM chains supported, Hedera not among them). Every
Hedera dApp that wants "AI agent queries our contract state", "subgraph
playground for our users", "MCP tool that speaks to our contract", or
even just "GraphQL instead of REST" ends up hand-rolling a Mirror Node
client.

Meanwhile the Hedera Mirror Node already indexes every contract event
publicly, for free, with sub-second consensus timestamps. All the raw
material is there — nothing turns it into subgraph-shaped GraphQL.

## What this package is

A thin, dependency-light library that takes:

- a contract address on Hedera (testnet or mainnet),
- an event ABI (or one of a few common presets),
- (optionally) a resolver override or extended schema,

and returns a GraphQL executor you drop into any Node handler
(Next.js API route, Express, Hono, Fastify, serverless). Under the hood
it reads from Mirror Node, decodes event data, and folds the stream
into the standardized entity shape.

Query shape matches Messari's standardized-subgraphs conventions and
our own subgraph at Studio, so **the same query works against The Graph
(EVM chain) and this adapter (Hedera) unchanged**. That's the moat: one
schema, N indexing backends, N chains.

## Non-goals

- Not a full graph-node replacement. We only support event-derived
  entities — no view-function call handlers, no dynamic templates, no
  file data sources. If Mirror Node doesn't already index it, we don't
  either.
- Not opinionated about hosting. Ship it however you want.
- Not a caching layer. Mirror Node's own CDN + our thin per-request
  memoization is enough for demo scale; production callers layer
  Redis/Vercel Edge if they need it.

## Public API surface

```ts
import { createHederaGraphQLAdapter } from '@zkward/hedera-graphql-adapter';

const adapter = createHederaGraphQLAdapter({
  network: 'testnet',                 // 'testnet' | 'mainnet'
  contract: '0xe7E6…9A9',              // EVM address of the contract
  preset: 'erc4626',                  // 'erc4626' | 'custom' | omitted for auto
  // optional — only for 'custom':
  events: [
    { name: 'Transfer', signature: 'Transfer(address,address,uint256)', map: (log) => ({ ... }) },
  ],
  // optional Hedera-side extras:
  attestation: {
    enabled: true,                     // opt-in HCS attestation of responses
    topicId: '0.0.10393879',
    operatorId: process.env.HEDERA_OPERATOR_ID,
    operatorKey: process.env.HEDERA_OPERATOR_KEY,
  },
});

// Use with any HTTP server:
export async function POST(req: Request) {
  const body = await req.json();
  const { data, extensions } = await adapter.execute({
    query: body.query,
    variables: body.variables,
    attest: new URL(req.url).searchParams.get('attest') === '1',
  });
  return Response.json({ data, extensions });
}

// Or introspect the schema:
console.log(adapter.getSchemaSDL());
```

## Preset: `erc4626`

Built-in preset for standard ERC-4626 vault contracts. Maps:

| Contract event | Entity |
|---|---|
| `Deposited(address indexed, uint256, uint256)` | `Transaction { type: DEPOSIT }`, `Pool.totalNav +=`, `Pool.totalShares +=`, `Member` upsert |
| `Withdrawn(address indexed, uint256, uint256)` | `Transaction { type: WITHDRAW }`, `Pool.totalNav -=`, `Pool.totalShares -=`, `Member` upsert |

Supported queries (identical shape to Messari standardized-vaults):

- `pool(id)`, `pools(first, where)`
- `transactions(first, orderBy, orderDirection, where)`
- `members(first)`
- `_meta`

Anyone whose vault emits those two event signatures gets the whole
GraphQL surface for free.

## Preset: `custom`

For contracts with non-4626 events. Caller supplies an `events` array;
each entry has a name, canonical signature, and a `map(log)` function
that returns an entity write. Adapter still exposes `_meta` +
generic `logs(first, where)` even if the caller doesn't map anything.

## Preset: (auto)

If `preset` is omitted, the adapter tries to detect ERC-4626 via
`asset()` selector call. If it succeeds, applies `erc4626` preset. If
not, falls back to the generic `logs()` view. Zero-config for the
common case.

## Mirror Node coverage

We only rely on public Mirror Node REST endpoints:

- `GET /contracts/{addr}` — verify contract exists
- `GET /contracts/{addr}/results/logs?limit=…&topic0=…` — event stream
- `GET /contracts/{addr}/results` — general contract calls (fallback)
- `POST /contracts/call` (a.k.a. `eth_call` bridge) — for view functions
  when preset needs them (e.g. `totalAssets`, `totalShares`)

All read-only. No auth. Cost = zero HBAR.

## HCS attestation (opt-in)

When `attestation.enabled: true` AND the request opts in
(e.g. `?attest=1`), the adapter after executing:

1. Canonicalizes the response data (`stableStringify`, key-sorted).
2. Hashes it (sha256).
3. Submits a JSON message to the configured HCS topic containing
   `{ responseHash, queryPreview, attestedAt, indexer }`.
4. Attaches `extensions._attestation` with the tx id, sequence number,
   HashScan URL, and observed finality.

Any consumer can then independently pull the HCS message from Mirror
Node, hash the data field themselves, and confirm bit-perfect match.

This is optional — off by default — and useful primarily for AI-agent
trust chains where "what did the model see" matters. Standard dashboard
reads leave it off. Cost is real (~$0.0001/msg), so we don't attest by
default.

## Package layout

```
packages/hedera-graphql-adapter/
  package.json
  README.md
  DESIGN.md          (this file)
  src/
    index.ts         (public API — createHederaGraphQLAdapter)
    mirror.ts        (Mirror Node client — extracted from lib/services/hedera/mirror-node.ts)
    schema/
      shared.ts      (canonical typeDefs — Pool, Transaction, Member, _Meta_)
      erc4626.ts     (preset resolvers)
      custom.ts      (generic events preset)
    events.ts        (topic-hash decoder, log→entity fold)
    attestation.ts   (HCS submit + sha256)
    types.ts
  examples/
    minimal.ts       (drop-in Express server, 20 LOC)
    next-route.ts    (Next.js API route)
```

## Dependencies

- `graphql` — schema build + execute (peer)
- `@hashgraph/sdk` — only imported dynamically when attestation is enabled
- Nothing else. Mirror Node is fetch()'d directly, no Hedera SDK for reads.

## Publishing

- npm: `@zkward/hedera-graphql-adapter`
- GitHub: same repo, `packages/hedera-graphql-adapter/`
- Version: start at `0.1.0`
- License: MIT

## What this un-blocks

- Any Hedera dApp gets subgraph-shaped GraphQL in an hour instead of a week.
- The Graph MCP tool works over Hedera contracts via this adapter — extending
  its coverage from 129 chains to 130 without waiting for The Graph itself
  to add Hedera support.
- A path to standardization: if this becomes the reference impl, next step
  is a "Hedera Standardized Subgraph Schema" spec everyone can implement.

## What we deliberately punt

- Multi-contract data sources (subgraph.yaml equivalent) — v0.2.
- Templates / dynamic contract registration — v0.2.
- Historical replay from block 0 — Mirror Node only serves recent logs
  well; deep history needs a paginator we haven't written yet.
- Testnet ↔ mainnet URL selection is manual; we don't handle Hedera EVM
  aliases (0.0.x → 0x…) beyond a helper export.

Ship v0.1 with the ERC-4626 preset and the extraction. Anything above
is next-issue material.
