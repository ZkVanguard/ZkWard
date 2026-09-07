/**
 * Hedera Mirror Node → GraphQL adapter — reference deployment.
 *
 * Thin route that mounts @zkward/hedera-graphql-adapter against our
 * SimpleUsdcVault. The heavy lifting (Mirror Node client, schema build,
 * event decoding, optional HCS attestation) lives in the package at
 * packages/hedera-graphql-adapter — so any Hedera dApp can drop the
 * same library into their own stack and get a subgraph endpoint.
 *
 * The Graph doesn't index Hedera; this library bridges the gap so all
 * Graph-native tooling (MCP, playgrounds, standardized queries) works
 * over Hedera contracts.
 *
 * Query pattern is identical to a Messari-style standardized subgraph
 * on The Graph — pools, transactions, members, _meta — so the same
 * client code works against either backend.
 *
 * Optional response attestation: pass `?attest=1` to have the server
 * anchor a sha256 of the response bytes on HCS. Off by default; useful
 * for AI-agent trust chains.
 *
 * GET  /api/subgraph/hedera            → introspection blurb (curl-friendly)
 * POST /api/subgraph/hedera            → GraphQL executor
 *   body: { query: string, variables?: object }
 *   query params: ?attest=1  → optional HCS attestation
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';
import { createHederaGraphQLAdapter } from '@zkward/hedera-graphql-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

// Module-scope singleton — reused across requests, no cold-start cost per call.
const VAULT = HEDERA_CONTRACT_ADDRESSES.testnet.communityPool.toLowerCase();

const adapter = createHederaGraphQLAdapter({
  network: 'testnet',
  contract: VAULT,
  preset: 'erc4626',
  attestation: {
    enabled: (process.env.HCS_AUDIT_ENABLED || '').trim() === '1',
    topicId: (process.env.HCS_AUDIT_TOPIC_ID || '').trim(),
    operatorId: (process.env.HEDERA_OPERATOR_ID || '').trim(),
    operatorKey: (process.env.HEDERA_OPERATOR_KEY || '').trim(),
  },
});

interface GraphQLBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: GraphQLBody;
  try {
    body = (await request.json()) as GraphQLBody;
  } catch {
    return NextResponse.json({ errors: [{ message: 'invalid json body' }] }, { status: 400 });
  }
  if (!body.query) {
    return NextResponse.json({ errors: [{ message: 'query required' }] }, { status: 400 });
  }

  const url = new URL(request.url);
  const wantAttest = url.searchParams.get('attest') === '1';

  try {
    const result = await adapter.execute({
      query: body.query,
      variables: body.variables,
      operationName: body.operationName,
      attest: wantAttest,
    });
    const status = result.errors && result.errors.length > 0 && !result.data ? 400 : 200;
    return NextResponse.json(result, {
      status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    logger.warn('[subgraph/hedera] adapter execute failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { errors: [{ message: e instanceof Error ? e.message : 'execute failed' }] },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    endpoint: 'hedera-graphql-adapter (reference deployment)',
    package: '@zkward/hedera-graphql-adapter',
    packageRepo: 'https://github.com/ZkVanguard/zkward-ethglobal/tree/main/packages/hedera-graphql-adapter',
    backend: 'Hedera Mirror Node (testnet)',
    vault: VAULT,
    schemaParity: 'Matches Studio subgraph at https://api.studio.thegraph.com/query/1758819/zkward — same query works on both.',
    supportedQueries: ['pool', 'pools', 'transactions', 'members', '_meta'],
    method: 'POST',
    exampleBody: {
      query: '{ pools { id network totalShares totalNav sharePrice memberCount } transactions(first: 5) { type actor amount timestamp } _meta { block { number timestamp } deployment hasIndexingErrors } }',
    },
    verifiableGraphQL: {
      description: 'Optional add-on. Append ?attest=1 to POST — response `extensions._attestation` contains a HCS tx id + sha256 of response bytes. Useful for AI-agent trust chains; off by default. Cost ≈ $0.0001 per attested query.',
      example: 'POST /api/subgraph/hedera?attest=1',
      verify: 'GET /api/subgraph/verify?txId=<attestation.txId> — pulls HCS receipt back',
    },
  });
}
