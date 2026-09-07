/**
 * Health probe for the hedera-graphql-adapter reference deployment.
 *
 * Uptime monitors + judges can hit this to confirm the endpoint is live
 * without running a GraphQL query. Reports: adapter status, current pool
 * TVL, member count, Mirror Node round-trip latency, cache-hit inference
 * (fast responses = cache hit, slow = miss), package version.
 */

import { NextResponse } from 'next/server';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';
import { createHederaGraphQLAdapter } from '@zkward/hedera-graphql-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

// Reuse a fresh adapter per health request so cache stats reflect the
// hit path independently from user traffic.
const VAULT = HEDERA_CONTRACT_ADDRESSES.testnet.communityPool.toLowerCase();

interface HealthReport {
  ok: boolean;
  timestamp: string;
  reference: {
    package: string;
    endpoint: string;
    vault: string;
    network: 'testnet';
  };
  probe: {
    latencyMs: number;
    poolAvailable: boolean;
    metaBlockNumber: number | null;
    tvlUsdc: number | null;
    memberCount: number | null;
    cacheHit: boolean;    // heuristic: <100ms → cache hit
  };
  errors?: string[];
}

export async function GET(): Promise<NextResponse<HealthReport>> {
  const adapter = createHederaGraphQLAdapter({
    network: 'testnet',
    contract: VAULT,
    preset: 'erc4626',
  });

  const t0 = Date.now();
  const errors: string[] = [];
  let poolAvailable = false;
  let metaBlockNumber: number | null = null;
  let tvlUsdc: number | null = null;
  let memberCount: number | null = null;

  try {
    const result = await adapter.execute<{
      pools?: Array<{ totalNav?: string; memberCount?: number }>;
      _meta?: { block?: { number?: number } };
    }>({
      query: '{ pools { totalNav memberCount } _meta { block { number } } }',
    });

    if (result.errors?.length) {
      errors.push(...result.errors.map((e) => e.message));
    }
    const pool = result.data?.pools?.[0];
    if (pool) {
      poolAvailable = true;
      if (pool.totalNav) tvlUsdc = Number(pool.totalNav) / 1e6;
      if (pool.memberCount != null) memberCount = pool.memberCount;
    }
    metaBlockNumber = result.data?._meta?.block?.number ?? null;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const latencyMs = Date.now() - t0;
  const cacheHit = latencyMs < 100 && poolAvailable;
  const ok = poolAvailable && errors.length === 0;

  return NextResponse.json(
    {
      ok,
      timestamp: new Date().toISOString(),
      reference: {
        package: '@zkward/hedera-graphql-adapter',
        endpoint: 'https://www.zkward.com/api/subgraph/hedera',
        vault: VAULT,
        network: 'testnet',
      },
      probe: {
        latencyMs,
        poolAvailable,
        metaBlockNumber,
        tvlUsdc,
        memberCount,
        cacheHit,
      },
      ...(errors.length ? { errors } : {}),
    },
    {
      status: ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
