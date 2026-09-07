/**
 * Minimal Express server exposing a Hedera contract as GraphQL.
 * 30 lines including comments.
 *
 * Run:
 *   npm install express @zkward/hedera-graphql-adapter graphql
 *   npx tsx examples/minimal-express.ts
 *
 * Query:
 *   curl -sX POST http://localhost:4000/graphql \
 *     -H 'content-type: application/json' \
 *     -d '{"query":"{ pools { id totalNav memberCount } _meta { block { number } } }"}'
 */

import express from 'express';
import { createHederaGraphQLAdapter } from '@zkward/hedera-graphql-adapter';

const adapter = createHederaGraphQLAdapter({
  network: 'testnet',
  contract: process.env.VAULT_ADDRESS || '0xe7E6fEDce9d72D112137B631E8D51831D30729A9',
  preset: 'erc4626',
});

const app = express();
app.use(express.json());

app.post('/graphql', async (req, res) => {
  const result = await adapter.execute({
    query: req.body.query,
    variables: req.body.variables,
    attest: req.query.attest === '1',
  });
  res.json(result);
});

app.get('/graphql/sdl', (_req, res) => {
  res.type('text/plain').send(adapter.getSchemaSDL());
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`hedera-graphql-adapter live on :${port}`));
