/**
 * Run: node index.mjs
 *
 * Loads the sibling subgraph.yaml, constructs an adapter routed at Hedera
 * Mirror Node, and prints live pool state + a recent transaction.
 *
 * The manifest is a real subgraph.yaml that WOULD deploy to Graph Studio
 * if The Graph indexed Hedera. Since it doesn't, this loader routes the
 * same declaration to Mirror Node instead — the query shape is identical.
 */

import { fromSubgraphYaml } from '@zkward/hedera-graphql-adapter';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, 'subgraph.yaml');

const adapter = fromSubgraphYaml(manifestPath);

console.log('━'.repeat(70));
console.log('  fromSubgraphYaml demo — Hedera testnet SimpleUsdcVault');
console.log('  manifest:', manifestPath);
console.log('━'.repeat(70));

const result = await adapter.execute({
  query: `{
    pools { id network totalNav memberCount sharePrice }
    transactions(first: 3, orderBy: "timestamp", orderDirection: desc) {
      type actor amount timestamp
    }
    _meta { block { number } deployment hasIndexingErrors }
  }`,
});

if (result.errors?.length) {
  console.error('errors:', result.errors);
  process.exit(1);
}

const pool = result.data.pools[0];
console.log(`\n  Pool ${pool.id}`);
console.log(`    network:      ${pool.network}`);
console.log(`    totalNav:     $${(Number(pool.totalNav) / 1e6).toFixed(2)}`);
console.log(`    memberCount:  ${pool.memberCount}`);
console.log(`    sharePrice:   ${(Number(pool.sharePrice) / 1e6).toFixed(6)}`);

console.log(`\n  Recent transactions:`);
for (const tx of result.data.transactions) {
  const amt = (Number(tx.amount) / 1e6).toFixed(2);
  const ago = Math.round((Date.now() / 1000 - Number(tx.timestamp)) / 3600);
  console.log(`    ${tx.type.padEnd(8)} $${amt.padEnd(8)} by ${tx.actor.slice(0, 10)}…  ${ago}h ago`);
}

console.log(`\n  _meta:`);
console.log(`    block:  ${result.data._meta.block.number}`);
console.log(`    errors: ${result.data._meta.hasIndexingErrors}`);
console.log('━'.repeat(70));
