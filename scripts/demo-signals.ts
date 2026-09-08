/**
 * AI Decision Audit via GraphQL — signals resolver demo.
 *
 * Queries the v0.3 signals resolver on the deployed Hedera adapter,
 * prints each signal + its independently-verifiable HashScan link,
 * and confirms the source substrate (HCS audit topic).
 *
 * Same substrate the trader writes to at 5-min ticks, now read back
 * as first-class GraphQL entities. Every hcsSeq is verifiable on
 * HashScan without going through our servers.
 *
 * Run:
 *   bun run scripts/demo-signals.ts
 *   ASSET=ETH bun run scripts/demo-signals.ts       # filter by asset
 *   LIMIT=10 bun run scripts/demo-signals.ts        # cap
 */

const BASE_URL = (process.env.BASE_URL || 'https://www.zkward.com').replace(/\/$/, '');
const HEDERA_URL = `${BASE_URL}/api/subgraph/hedera`;
const ASSET = (process.env.ASSET || '').toUpperCase();
const LIMIT = Number(process.env.LIMIT || 12);
const TOPIC = '0.0.10393879';

interface Signal {
  id: string;
  asset: string;
  direction: string;
  confidence: number;
  source: string;
  timestamp: string;
  hcsSeq: number | null;
  hcsTxId: string | null;
}

interface Resp {
  data?: { signals?: Signal[] };
  errors?: Array<{ message: string }>;
}

function line(char = '─', len = 78): string { return char.repeat(len); }
function fmtAgo(sec: number): string {
  const minAgo = Math.round((Date.now() / 1000 - sec) / 60);
  if (minAgo < 60) return `${minAgo}m ago`;
  const hAgo = Math.round(minAgo / 60);
  return `${hAgo}h ago`;
}

async function main() {
  console.log(line('═'));
  console.log('  AI Decision Audit via GraphQL — v0.3 signals resolver');
  console.log(line('═'));
  console.log(`  Endpoint: ${HEDERA_URL}`);
  console.log(`  HCS topic (verifiable substrate): ${TOPIC}`);
  console.log(`  Filter: asset=${ASSET || 'any'}  limit=${LIMIT}`);
  console.log('');

  const query = `query($first: Int, $asset: String) {
    signals(first: $first, where: { asset: $asset }) {
      id
      asset
      direction
      confidence
      source
      timestamp
      hcsSeq
    }
  }`;
  const variables: Record<string, unknown> = { first: LIMIT };
  if (ASSET) variables.asset = ASSET;

  const t0 = Date.now();
  const r = await fetch(HEDERA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const elapsed = Date.now() - t0;
  const j = (await r.json()) as Resp;

  if (j.errors?.length) {
    console.error('  ERRORS:', j.errors.map((e) => e.message).join('; '));
    process.exit(1);
  }
  const signals = j.data?.signals ?? [];
  console.log(`  ${signals.length} signals in ${elapsed}ms`);
  console.log('');

  if (signals.length === 0) {
    console.log('  (no signals returned — check HCS_AUDIT_TOPIC_ID is set on the adapter)');
    process.exit(0);
  }

  console.log(line());
  console.log(`  ${'SEQ'.padEnd(6)} ${'ASSET'.padEnd(6)} ${'DIR'.padEnd(9)} ${'CONF'.padEnd(6)} ${'SOURCE'.padEnd(24)} ${'AGE'.padEnd(9)} HASHSCAN`);
  console.log(line());
  for (const s of signals) {
    const seq = String(s.hcsSeq ?? '?').padEnd(6);
    const asset = s.asset.padEnd(6);
    const dir = s.direction.padEnd(9);
    const conf = (s.confidence + '%').padEnd(6);
    const src = s.source.padEnd(24);
    const age = fmtAgo(Number(s.timestamp)).padEnd(9);
    const link = s.hcsSeq
      ? `hashscan.io/testnet/topic/${TOPIC}/message/${s.hcsSeq}`
      : '(none)';
    console.log(`  ${seq} ${asset} ${dir} ${conf} ${src} ${age} ${link}`);
  }
  console.log(line());
  console.log('');
  console.log('  Every row above is anchored on Hedera Consensus Service.');
  console.log('  Click any HashScan link — it works without going through our servers.');
  console.log(line('═'));
}

main().catch((e) => { console.error(e); process.exit(1); });
