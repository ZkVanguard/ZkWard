# @zkward/hedera-graphql-adapter

**Serve any Hedera contract as a standardized GraphQL / subgraph endpoint.**

The Graph doesn't index Hedera. This library bridges the gap: point it at a contract, get a GraphQL endpoint whose query shape matches a Messari-style standardized subgraph on The Graph. All Graph-native tooling — MCP servers, playgrounds, GraphiQL, subgraph explorers — works over your Hedera contracts unchanged.

```
Hedera Mirror Node ─────►  hedera-graphql-adapter  ─────►  Standardized GraphQL
   (existing indexer)          (this library)             (Messari-shaped entities)
                                                          ↳ works in Graph MCP,
                                                            subgraph playgrounds,
                                                            any GraphQL client
```

- Reference deployment: [www.zkward.com/api/subgraph/hedera](https://www.zkward.com/api/subgraph/hedera)
- Repo path: [`packages/hedera-graphql-adapter/`](https://github.com/ZkVanguard/zkward-ethglobal/tree/main/packages/hedera-graphql-adapter)
- Design doc: [`DESIGN.md`](./DESIGN.md)

## Why this exists

- **Hedera Mirror Node** already indexes every contract event on Hedera for free, sub-second finality, no operator required. But it speaks REST/JSON.
- **The Graph ecosystem** speaks GraphQL and has years of tooling — subgraph MCP, playgrounds, standardized schemas — but doesn't index Hedera (verified 2026-09-07: [official networks registry](https://networks-registry.thegraph.com/TheGraphNetworksRegistry.json) covers 129 EVM chains, Hedera not among them).

This is the missing 200 lines of glue.

## Install

```bash
npm install @zkward/hedera-graphql-adapter graphql
# Optional — only if you enable HCS attestation of responses:
npm install @hashgraph/sdk
```

## 60-second quickstart — Next.js API route

```ts
// app/api/subgraph/vault/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createHederaGraphQLAdapter } from '@zkward/hedera-graphql-adapter';

const adapter = createHederaGraphQLAdapter({
  network: 'testnet',
  contract: '0xe7E6fEDce9d72D112137B631E8D51831D30729A9', // your ERC-4626 vault
  preset: 'erc4626',
});

export async function POST(request: NextRequest) {
  const body = await request.json();
  const result = await adapter.execute({
    query: body.query,
    variables: body.variables,
  });
  return NextResponse.json(result);
}
```

That's it. Now:

```bash
curl -s -X POST http://localhost:3000/api/subgraph/vault \
  -H 'content-type: application/json' \
  -d '{"query":"{ pools { id network totalNav memberCount } transactions(first: 5) { type actor amount timestamp } _meta { block { number } deployment } }"}'
```

Returns exactly the shape a Messari standardized-vault subgraph on Ethereum would return.

## What ships in the `erc4626` preset

Any contract with the standard events:

```solidity
event Deposited(address indexed member, uint256 amount, uint256 shares);
event Withdrawn(address indexed member, uint256 shares, uint256 amount);
```

...gets the full standardized query surface for free:

- `pool(id)` / `pools(first, where)`
- `transactions(first, orderBy, orderDirection, where)`
- `members(first)`
- `_meta { block, deployment, hasIndexingErrors }`

Storage reads (`totalShares`, `totalAssets`, `memberCount`) come from the contract via Mirror Node's `eth_call` bridge — no server-side state needed.

## Standalone Express example

```ts
import express from 'express';
import { createHederaGraphQLAdapter } from '@zkward/hedera-graphql-adapter';

const app = express();
app.use(express.json());

const adapter = createHederaGraphQLAdapter({
  network: 'testnet',
  contract: '0x...',
  preset: 'erc4626',
});

app.post('/graphql', async (req, res) => {
  const result = await adapter.execute({
    query: req.body.query,
    variables: req.body.variables,
  });
  res.json(result);
});

app.get('/graphql/sdl', (_req, res) => res.type('text/plain').send(adapter.getSchemaSDL()));

app.listen(4000, () => console.log('GraphQL up on :4000'));
```

## Optional — HCS attestation for AI-agent trust chains

When an AI agent will act on subgraph data ("TVL is $X, safe to deposit"), you may want a receipt of what the model saw. Enable HCS attestation:

```ts
const adapter = createHederaGraphQLAdapter({
  network: 'testnet',
  contract: '0x...',
  preset: 'erc4626',
  attestation: {
    enabled: true,
    topicId: '0.0.10393879',
    operatorId: process.env.HEDERA_OPERATOR_ID!,
    operatorKey: process.env.HEDERA_OPERATOR_KEY!,
  },
});

// Then per-request:
const result = await adapter.execute({
  query: '{ pools { id totalNav } }',
  attest: true,   // opt-in per call
});
// result.extensions._attestation = { txId, responseHash, finalityMs, explorerUrl, ... }
```

Consumer verifies: fetch the HCS message from Mirror Node, sha256 the response data, compare to `responseHash`. Match = untampered.

**Off by default.** Cost ≈ $0.0001 per attested query. Most standard read paths leave it off.

## Plugs into The Graph MCP tooling

The endpoint speaks GraphQL matching the standardized shape, so any subgraph MCP server can query it exactly like it queries a Studio-hosted subgraph:

```json
{
  "mcpServers": {
    "hedera-vaults": {
      "command": "node",
      "args": ["/path/to/mcp/index.js"],
      "env": {
        "SUBGRAPH_URL": "https://your-app.com/api/subgraph/vault"
      }
    }
  }
}
```

See [`../../mcp/zkward-vaults/`](../../mcp/zkward-vaults/) for our reference MCP that queries both a Studio subgraph AND this adapter as one unified tool surface.

## API

### `createHederaGraphQLAdapter(config)`

```ts
interface AdapterConfig {
  network: 'testnet' | 'mainnet';
  contract: string;                  // EVM address
  preset?: 'erc4626' | 'auto';       // 'custom' lands in v0.2
  attestation?: {                    // optional
    enabled: boolean;
    topicId: string;
    operatorId: string;
    operatorKey: string;
    network?: 'testnet' | 'mainnet';
  };
  mirrorNodeBase?: string;           // override for testing
}
```

Returns:

```ts
interface Adapter {
  execute<T>(input: { query, variables?, operationName?, attest? }): Promise<ExecuteResult<T>>;
  getSchemaSDL(): string;
  getConfig(): Readonly<AdapterConfig>;
}
```

## Roadmap (see DESIGN.md)

- **v0.1** (this release) — `erc4626` preset, HCS attestation, Next.js/Express recipes
- **v0.2** — `custom` preset (bring your own events/entities), multi-contract data sources
- **v0.3** — Historical replay from arbitrary start block, subgraph.yaml compatibility

## License

MIT. Contributions welcome — this is a small, focused library and it should stay that way.
