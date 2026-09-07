/**
 * Pull every message from the HCS audit topic and classify by kind.
 *
 * Proves the topic isn't a demo prop — three distinct attestation
 * flows write to it in production:
 *   (1) subgraph-query-attestation  — sha256 of GraphQL response bytes
 *   (2) hedge-projection           — trader pool NAV + open positions
 *   (3) x402 payment receipt        — pay-per-call inference settlement
 *
 * Run:
 *   bun run scripts/audit-hcs-attestations.ts
 * Or a different topic:
 *   TOPIC_ID=0.0.10401316 bun run scripts/audit-hcs-attestations.ts
 */

const TOPIC_ID = (process.env.TOPIC_ID || '0.0.10393879').trim();
const NETWORK = (process.env.HEDERA_NETWORK || 'testnet').trim();
const MIRROR = NETWORK === 'mainnet'
  ? 'https://mainnet.mirrornode.hedera.com/api/v1'
  : 'https://testnet.mirrornode.hedera.com/api/v1';

interface Msg {
  sequence_number: number;
  consensus_timestamp: string;
  message: string;
  running_hash: string;
}

interface Parsed {
  seq: number;
  ts: string;
  kind: string;
  preview: string;
  raw: Record<string, unknown>;
}

function classify(payload: Record<string, unknown>): { kind: string; preview: string } {
  if (typeof payload.kind === 'string') {
    if (payload.kind === 'subgraph-query-attestation') {
      const q = String(payload.queryPreview ?? '').replace(/\s+/g, ' ').slice(0, 60);
      return { kind: 'subgraph-query-attestation', preview: q };
    }
    if (payload.kind === 'hedge-projection') {
      const nav = (payload.poolNavUsd as number | undefined)?.toFixed?.(2) ?? '?';
      const positions = Array.isArray(payload.positions) ? payload.positions.length : 0;
      return { kind: 'hedge-projection', preview: `NAV $${nav} across ${positions} legs` };
    }
    return { kind: String(payload.kind), preview: JSON.stringify(payload).slice(0, 60) };
  }
  if (typeof payload.paid === 'boolean' && typeof payload.signal === 'string') {
    return {
      kind: 'x402-payment-receipt',
      preview: `${payload.asset ?? '?'} ${payload.signal} @ ${payload.confidence ?? '?'}%`,
    };
  }
  if (typeof payload.hcs_standard === 'number' && payload.hcs_standard === 14) {
    return {
      kind: 'hcs-14-agent-registration',
      preview: `${payload.name ?? '?'} v${payload.version ?? '?'}`,
    };
  }
  if (payload.event === 'topic-created') {
    return { kind: 'topic-genesis', preview: `topic created ${payload.ts}` };
  }
  return { kind: 'unknown', preview: JSON.stringify(payload).slice(0, 60) };
}

async function fetchAllMessages(): Promise<Msg[]> {
  const out: Msg[] = [];
  let next: string | null = `${MIRROR}/topics/${TOPIC_ID}/messages?limit=100&order=asc`;
  while (next) {
    const r = await fetch(next);
    if (!r.ok) throw new Error(`mirror ${r.status}`);
    const j = (await r.json()) as { messages?: Msg[]; links?: { next?: string | null } };
    if (j.messages) out.push(...j.messages);
    next = j.links?.next ? `https://testnet.mirrornode.hedera.com${j.links.next}` : null;
  }
  return out;
}

function line(char = '─', len = 74): string {
  return char.repeat(len);
}

async function main() {
  console.log(line('═'));
  console.log(`  HCS audit topic ${TOPIC_ID} (${NETWORK})`);
  console.log(line('═'));

  const messages = await fetchAllMessages();
  console.log(`  Total messages: ${messages.length}`);
  if (!messages.length) {
    console.log('  (no messages yet)');
    return;
  }

  const parsed: Parsed[] = messages.map((m) => {
    const raw = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8')) as Record<string, unknown>;
    const { kind, preview } = classify(raw);
    return { seq: m.sequence_number, ts: m.consensus_timestamp, kind, preview, raw };
  });

  const counts = parsed.reduce<Record<string, number>>((acc, p) => {
    acc[p.kind] = (acc[p.kind] ?? 0) + 1;
    return acc;
  }, {});

  console.log('\nBreakdown by kind:');
  for (const [kind, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(32)} ${String(n).padStart(4)}`);
  }

  console.log('\nMost recent 10 messages:');
  console.log(line());
  for (const p of parsed.slice(-10).reverse()) {
    const ago = Math.round((Date.now() / 1000 - Number(p.ts.split('.')[0])) / 60);
    console.log(`  #${String(p.seq).padStart(3)}  ${p.kind.padEnd(30)} ${ago}min ago  ${p.preview}`);
  }

  console.log('\nExplorer:');
  console.log(`  https://hashscan.io/${NETWORK}/topic/${TOPIC_ID}`);
  console.log(line('═'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
