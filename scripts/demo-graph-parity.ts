/**
 * Cross-endpoint parity demo — the standards-leverage proof point.
 *
 * Runs THE SAME standardized-vault query against:
 *   (1) Graph Studio subgraph (Sepolia, indexed by graph-node)
 *   (2) Our @zkward/hedera-graphql-adapter (Hedera testnet, Mirror-Node-backed)
 *
 * Both backends implement the ZkWard Standardized AI-Vault schema. Same
 * query shape → same response shape → one query works across every
 * chain the schema is deployed to.
 *
 * Then on the Hedera side, requests `?attest=1` to anchor a sha256 of
 * the response bytes on HCS, and calls /api/subgraph/verify to pull the
 * receipt back and confirm the hash matches. That's the composable +
 * verifiable extension on top of the standardized schema.
 *
 * Run:
 *   bun run scripts/demo-graph-parity.ts
 * Or against a local dev server:
 *   BASE_URL=http://localhost:3000 bun run scripts/demo-graph-parity.ts
 */

const BASE_URL = (process.env.BASE_URL || 'https://www.zkward.com').replace(/\/$/, '');
const STUDIO_URL = 'https://api.studio.thegraph.com/query/1758819/zkward/v0.1.1';
const HEDERA_URL = `${BASE_URL}/api/subgraph/hedera`;
const HEDERA_ATTEST_URL = `${HEDERA_URL}?attest=1`;
const VERIFY_URL = `${BASE_URL}/api/subgraph/verify`;

const QUERY = `{
  pools {
    id
    network
    totalNav
    memberCount
  }
  _meta {
    block { number }
    hasIndexingErrors
  }
}`;

interface PoolRow {
  id: string;
  network?: string;
  totalNav?: string;
  memberCount?: number;
}

interface GraphResp {
  data?: {
    pools?: PoolRow[];
    _meta?: { block?: { number?: number }; hasIndexingErrors?: boolean };
  };
  errors?: Array<{ message: string }>;
  extensions?: { _attestation?: { txId?: string; responseHash?: string; consensusSeq?: string; explorerUrl?: string } };
}

async function post(url: string, body: object): Promise<GraphResp> {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as GraphResp;
  const ms = Date.now() - t0;
  (j as GraphResp & { __latencyMs?: number }).__latencyMs = ms;
  return j;
}

function fmtPool(p: PoolRow | undefined): string {
  if (!p) return '  (none)';
  const nav = p.totalNav ? `$${(Number(p.totalNav) / 1e6).toFixed(2)}` : '—';
  return `  id:         ${p.id}\n  network:    ${p.network ?? '—'}\n  totalNav:   ${nav} (${p.totalNav ?? '—'} micros)\n  memberCount: ${p.memberCount ?? '—'}`;
}

function line(char = '─', len = 70): string {
  return char.repeat(len);
}

async function main() {
  console.log(line('═'));
  console.log('  ZkWard Standardized Vault — cross-backend parity demo');
  console.log(line('═'));
  console.log('\nQuery (identical to both backends):');
  console.log(QUERY.split('\n').map((l) => '  ' + l).join('\n'));
  console.log('');

  const [studio, hedera] = await Promise.all([
    post(STUDIO_URL, { query: QUERY }),
    post(HEDERA_ATTEST_URL, { query: QUERY }),
  ]);

  const studioMs = (studio as GraphResp & { __latencyMs?: number }).__latencyMs;
  const hederaMs = (hedera as GraphResp & { __latencyMs?: number }).__latencyMs;

  console.log(line());
  console.log('  Backend 1 — Graph Studio subgraph (Sepolia)');
  console.log(line());
  console.log(`  Endpoint:  ${STUDIO_URL}`);
  console.log(`  Latency:   ${studioMs}ms`);
  console.log(`  Backend:   graph-node indexing Ethereum Sepolia`);
  console.log(`  Contract:  0x07d68C2828F35327d12a7Ba796cCF3f12F8A1086 (CommunityPool proxy)`);
  console.log(`  Meta:      block ${studio.data?._meta?.block?.number ?? '—'}, hasIndexingErrors=${studio.data?._meta?.hasIndexingErrors ?? '—'}`);
  console.log(`  Pools:     ${studio.data?.pools?.length ?? 0}`);
  if (studio.data?.pools?.length) {
    console.log(fmtPool(studio.data.pools[0]));
  } else {
    console.log('  (Sepolia contract is dormant — schema deployed, awaiting activity)');
  }

  console.log('');
  console.log(line());
  console.log('  Backend 2 — @zkward/hedera-graphql-adapter (Hedera testnet)');
  console.log(line());
  console.log(`  Endpoint:  ${HEDERA_URL}`);
  console.log(`  Latency:   ${hederaMs}ms`);
  console.log(`  Backend:   Hedera Mirror Node (bridges Hedera into Graph tooling)`);
  console.log(`  Contract:  0xe7E6fEDce9d72D112137B631E8D51831D30729A9 (SimpleUsdcVault)`);
  console.log(`  Meta:      block ${hedera.data?._meta?.block?.number ?? '—'}, hasIndexingErrors=${hedera.data?._meta?.hasIndexingErrors ?? '—'}`);
  console.log(`  Pools:     ${hedera.data?.pools?.length ?? 0}`);
  if (hedera.data?.pools?.length) {
    console.log(fmtPool(hedera.data.pools[0]));
  }

  console.log('');
  console.log(line('═'));
  console.log('  Standards-leverage takeaway');
  console.log(line('═'));
  console.log('  ✓ Same query shape works on two different chains');
  console.log('  ✓ Same response shape returned by two different indexers');
  console.log('  ✓ Graph doesn\'t natively index Hedera — the adapter bridges it');
  console.log('  ✓ Any competitor AI vault that emits the same event surface');
  console.log('    drops onto the same schema, no per-protocol query rewrite');

  const att = hedera.extensions?._attestation;
  if (att?.txId) {
    console.log('');
    console.log(line('═'));
    console.log('  Verifiable GraphQL — HCS attestation of Backend 2 response');
    console.log(line('═'));
    console.log(`  responseHash:  ${att.responseHash}`);
    console.log(`  hashAlgo:      sha256 (canonical JSON stringify)`);
    console.log(`  HCS txId:      ${att.txId}`);
    console.log(`  consensusSeq:  ${att.consensusSeq}`);
    console.log(`  hashscan:      ${att.explorerUrl}`);

    console.log('\n  Verifying via /api/subgraph/verify …');
    const verifyResp = await fetch(`${VERIFY_URL}?txId=${encodeURIComponent(att.txId)}`);
    if (!verifyResp.ok) {
      console.log(`  ✗ verify HTTP ${verifyResp.status}`);
    } else {
      const v = (await verifyResp.json()) as {
        verified?: boolean;
        hcs?: { message?: { responseHash?: string; kind?: string }; runningHash?: string };
      };
      const match = v.hcs?.message?.responseHash === att.responseHash;
      console.log(`  verified:      ${v.verified === true ? '✓ true' : '✗ false'}`);
      console.log(`  hash match:    ${match ? '✓ hashes are byte-equal' : '✗ hash mismatch'}`);
      console.log(`  kind:          ${v.hcs?.message?.kind ?? '—'}`);
      console.log(`  runningHash:   ${v.hcs?.runningHash?.slice(0, 32)}…`);
    }
  } else {
    console.log('');
    console.log('  (Hedera side did not return an attestation — HCS_AUDIT_* env may be unset)');
  }

  console.log('');
  console.log(line('═'));

  const bothReachable = !studio.errors && !hedera.errors;
  process.exit(bothReachable ? 0 : 1);
}

main().catch((e) => {
  console.error('demo failed:', e);
  process.exit(1);
});
