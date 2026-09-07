/**
 * Live judge-facing status board. Runs every claim in the README's
 * "Judges — start here" block server-side and returns pass/fail per row
 * so a judge can hit ONE URL and see the whole submission is green.
 *
 * Every check hits the real network — Mirror Node, HCS topic, our own
 * live routes, the Studio subgraph, npm registry. No stubs. If a check
 * says green, the underlying evidence link (HashScan, Etherscan, npm)
 * proves it independently.
 *
 * GET /api/judges/status → { ok, passed, failed, checks: [...] }
 * Also renderable at /judges (see app/judges/page.tsx).
 */

import { NextRequest, NextResponse } from 'next/server';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

const VAULT = HEDERA_CONTRACT_ADDRESSES.testnet.communityPool.toLowerCase();
const AUDIT_TOPIC = '0.0.10393879';
const REGISTRY_TOPIC = '0.0.10401316';
const NPM_PACKAGE = '@zkward/hedera-graphql-adapter';
const STUDIO_ENDPOINT = 'https://api.studio.thegraph.com/query/1758819/zkward/v0.1.1';

interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  evidence?: string;
  link?: string;
  latencyMs: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; error: string | null; latencyMs: number }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { value, error: null, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - t0 };
  }
}

async function checkVault(): Promise<CheckResult> {
  const t = await timed(async () => {
    const r = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/contracts/${VAULT}`);
    if (!r.ok) throw new Error(`mirror ${r.status}`);
    const j = await r.json() as { contract_id?: string; runtime_bytecode?: string };
    if (!j.contract_id || !j.runtime_bytecode) throw new Error('missing contract fields');
    return j;
  });
  return {
    id: 'hedera-vault',
    label: 'Hedera SimpleUsdcVault deployed',
    ok: !!t.value,
    detail: t.value ? `contract_id ${t.value.contract_id}, bytecode ${t.value.runtime_bytecode?.length ?? 0} chars` : t.error ?? 'unknown',
    evidence: t.value?.contract_id,
    link: `https://hashscan.io/testnet/contract/${VAULT}`,
    latencyMs: t.latencyMs,
  };
}

async function checkAuditTopic(): Promise<CheckResult> {
  const t = await timed(async () => {
    const r = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/topics/${AUDIT_TOPIC}/messages?limit=1&order=desc`);
    if (!r.ok) throw new Error(`mirror ${r.status}`);
    const j = await r.json() as { messages?: Array<{ sequence_number?: number; consensus_timestamp?: string }> };
    const msg = j.messages?.[0];
    if (!msg?.sequence_number) throw new Error('no messages');
    return msg;
  });
  return {
    id: 'hcs-audit',
    label: 'HCS audit topic active',
    ok: !!t.value && (t.value.sequence_number ?? 0) > 0,
    detail: t.value ? `latest seq ${t.value.sequence_number} at ${t.value.consensus_timestamp}` : t.error ?? 'unknown',
    evidence: t.value?.sequence_number?.toString(),
    link: `https://hashscan.io/testnet/topic/${AUDIT_TOPIC}`,
    latencyMs: t.latencyMs,
  };
}

async function checkRegistry(): Promise<CheckResult> {
  const t = await timed(async () => {
    const r = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/topics/${REGISTRY_TOPIC}/messages?limit=1&order=asc`);
    if (!r.ok) throw new Error(`mirror ${r.status}`);
    const j = await r.json() as { messages?: Array<{ sequence_number?: number; message?: string }> };
    const msg = j.messages?.[0];
    if (!msg?.message) throw new Error('no DID doc');
    const decoded = Buffer.from(msg.message, 'base64').toString('utf8');
    const doc = JSON.parse(decoded);
    return { doc, seq: msg.sequence_number };
  });
  return {
    id: 'hcs-14-registry',
    label: 'HCS-14 agent registry published',
    ok: !!t.value?.doc?.agent_id,
    detail: t.value ? `agent_id ${t.value.doc.agent_id} v${t.value.doc.version}` : t.error ?? 'unknown',
    evidence: t.value?.doc?.agent_id,
    link: `https://hashscan.io/testnet/topic/${REGISTRY_TOPIC}`,
    latencyMs: t.latencyMs,
  };
}

async function checkX402Intent(origin: string): Promise<CheckResult> {
  const t = await timed(async () => {
    const r = await fetch(`${origin}/api/hedera/x402/signal-quality?asset=BTC`);
    if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
    const j = await r.json() as { intent?: { payTo?: string; facilitator?: string; maxAmountRequired?: string } };
    if (!j.intent?.payTo || !j.intent?.facilitator) throw new Error('intent shape invalid');
    return j.intent;
  });
  return {
    id: 'x402-intent',
    label: 'x402 endpoint returns 402 with valid intent',
    ok: !!t.value,
    detail: t.value ? `pays to ${t.value.payTo?.slice(0, 10)}… via ${t.value.facilitator}, ${t.value.maxAmountRequired} micros` : t.error ?? 'unknown',
    link: `${origin}/api/hedera/x402/signal-quality?asset=BTC`,
    latencyMs: t.latencyMs,
  };
}

async function checkX402Paid(origin: string): Promise<CheckResult> {
  const t = await timed(async () => {
    const r = await fetch(`${origin}/api/hedera/x402/signal-quality?asset=BTC`, { headers: { 'X-PAYMENT': 'dGVzdA==' } });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const j = await r.json() as { signal?: string; confidence?: number; hcs?: { txId?: string }; verification?: { mode?: string } };
    if (!j.signal || !j.hcs?.txId) throw new Error('missing signal or HCS receipt');
    return j;
  });
  return {
    id: 'x402-paid',
    label: 'x402 paid call executes + writes HCS receipt',
    ok: !!t.value,
    detail: t.value ? `signal ${t.value.signal} @ ${t.value.confidence}% conf, verification mode: ${t.value.verification?.mode}` : t.error ?? 'unknown',
    evidence: t.value?.hcs?.txId,
    link: t.value?.hcs?.txId ? `https://hashscan.io/testnet/transaction/${t.value.hcs.txId}` : undefined,
    latencyMs: t.latencyMs,
  };
}

async function checkA2A(origin: string): Promise<CheckResult> {
  const t = await timed(async () => {
    const r = await fetch(`${origin}/api/hedera/a2a/demo?asset=BTC&budget=500`);
    if (!r.ok) throw new Error(`http ${r.status}`);
    const j = await r.json() as { ok?: boolean; paid?: boolean; provider?: { id?: string }; data?: { signal?: string } };
    if (!j.ok || !j.paid) throw new Error(`ok=${j.ok} paid=${j.paid}`);
    return j;
  });
  return {
    id: 'a2a-roundtrip',
    label: 'A2A negotiation round-trip settles',
    ok: !!t.value,
    detail: t.value ? `provider ${t.value.provider?.id}, signal ${t.value.data?.signal}` : t.error ?? 'unknown',
    link: `${origin}/api/hedera/a2a/demo?asset=BTC&budget=500`,
    latencyMs: t.latencyMs,
  };
}

async function checkAdapterHealth(origin: string): Promise<CheckResult> {
  const t = await timed(async () => {
    const r = await fetch(`${origin}/api/subgraph/hedera/health`);
    if (!r.ok) throw new Error(`http ${r.status}`);
    const j = await r.json() as { ok?: boolean; probe?: { tvlUsdc?: number; memberCount?: number; metaBlockNumber?: number } };
    if (!j.ok) throw new Error('health reports not ok');
    return j;
  });
  return {
    id: 'adapter-health',
    label: 'Hedera GraphQL adapter live',
    ok: !!t.value,
    detail: t.value ? `TVL $${t.value.probe?.tvlUsdc?.toFixed(2)}, ${t.value.probe?.memberCount} members, mirror block ${t.value.probe?.metaBlockNumber}` : t.error ?? 'unknown',
    link: `${origin}/api/subgraph/hedera`,
    latencyMs: t.latencyMs,
  };
}

async function checkVerifiableGraphQL(origin: string): Promise<CheckResult> {
  const t = await timed(async () => {
    const attest = await fetch(`${origin}/api/subgraph/hedera?attest=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ pools { totalNav memberCount } }' }),
    });
    if (!attest.ok) throw new Error(`attest ${attest.status}`);
    const attestJson = await attest.json() as { extensions?: { _attestation?: { attested?: boolean; txId?: string; responseHash?: string } } };
    const att = attestJson.extensions?._attestation;
    if (!att?.attested || !att.txId) throw new Error('attestation missing');
    const verify = await fetch(`${origin}/api/subgraph/verify?txId=${encodeURIComponent(att.txId)}`);
    if (!verify.ok) throw new Error(`verify ${verify.status}`);
    const verifyJson = await verify.json() as { verified?: boolean; hcs?: { message?: { responseHash?: string } } };
    if (!verifyJson.verified) throw new Error('verify reports not verified');
    if (verifyJson.hcs?.message?.responseHash !== att.responseHash) throw new Error('hash mismatch');
    return { txId: att.txId, hash: att.responseHash };
  });
  return {
    id: 'verifiable-graphql',
    label: 'Verifiable GraphQL — attest + verify round-trip',
    ok: !!t.value,
    detail: t.value ? `hash ${t.value.hash?.slice(0, 16)}… anchored + verified in ${t.latencyMs}ms` : t.error ?? 'unknown',
    evidence: t.value?.txId,
    link: t.value?.txId ? `https://hashscan.io/testnet/transaction/${t.value.txId}` : undefined,
    latencyMs: t.latencyMs,
  };
}

async function checkStudioSubgraph(): Promise<CheckResult> {
  const t = await timed(async () => {
    const r = await fetch(STUDIO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ _meta { block { number } hasIndexingErrors } pools { id } }' }),
    });
    if (!r.ok) throw new Error(`studio ${r.status}`);
    const j = await r.json() as { data?: { _meta?: { block?: { number?: number }; hasIndexingErrors?: boolean }; pools?: unknown[] } };
    const meta = j.data?._meta;
    if (!meta) throw new Error('no _meta');
    if (meta.hasIndexingErrors) throw new Error('indexing errors');
    return { block: meta.block?.number ?? 0, poolCount: j.data?.pools?.length ?? 0 };
  });
  return {
    id: 'studio-subgraph',
    label: 'Graph Studio subgraph reachable',
    ok: !!t.value,
    detail: t.value ? `at Sepolia block ${t.value.block}, ${t.value.poolCount} pools indexed${t.value.poolCount === 0 ? ' (Sepolia CommunityPool dormant)' : ''}` : t.error ?? 'unknown',
    link: 'https://thegraph.com/studio/subgraph/zkward',
    latencyMs: t.latencyMs,
  };
}

async function checkNpmPackage(): Promise<CheckResult> {
  const t = await timed(async () => {
    const r = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}`);
    if (r.status === 404) return { published: false };
    if (!r.ok) throw new Error(`npm ${r.status}`);
    const j = await r.json() as { 'dist-tags'?: { latest?: string } };
    return { published: true, version: j['dist-tags']?.latest };
  });
  return {
    id: 'npm-package',
    label: 'npm package published',
    ok: !!t.value?.published,
    detail: t.value?.published ? `v${t.value.version} on npm` : 'not yet published — run `cd packages/hedera-graphql-adapter && npm publish`',
    link: t.value?.published ? `https://www.npmjs.com/package/${NPM_PACKAGE}` : undefined,
    latencyMs: t.latencyMs,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = new URL(req.url).origin;

  const checks = await Promise.all([
    checkVault(),
    checkAuditTopic(),
    checkRegistry(),
    checkX402Intent(origin),
    checkX402Paid(origin),
    checkA2A(origin),
    checkAdapterHealth(origin),
    checkVerifiableGraphQL(origin),
    checkStudioSubgraph(),
    checkNpmPackage(),
  ]);

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).map((c) => c.id);
  const ok = failed.length === 0;

  return NextResponse.json(
    {
      ok,
      passed,
      total: checks.length,
      failed,
      timestamp: new Date().toISOString(),
      checks,
      references: {
        readme: 'https://github.com/ZkVanguard/zkward-ethglobal#-judges--start-here',
        vault: `https://hashscan.io/testnet/contract/${VAULT}`,
        auditTopic: `https://hashscan.io/testnet/topic/${AUDIT_TOPIC}`,
        registryTopic: `https://hashscan.io/testnet/topic/${REGISTRY_TOPIC}`,
        studioSubgraph: 'https://thegraph.com/studio/subgraph/zkward',
        adapterPackage: `https://www.npmjs.com/package/${NPM_PACKAGE}`,
        pullRequests: {
          hederaHarness: 'https://github.com/hedera-dev/hedera-harness/pull/43',
          hederaCodeSnippets: 'https://github.com/hedera-dev/hedera-code-snippets/pull/52',
          graphSubgraphsSkills: 'https://github.com/graphprotocol/subgraphs-skills/pull/1',
        },
      },
    },
    { status: ok ? 200 : 207, headers: { 'Cache-Control': 'no-store' } },
  );
}
