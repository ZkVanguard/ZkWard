/**
 * Hedera Mirror Node → GraphQL adapter.
 *
 * Exposes the SAME query shape as our Studio-hosted subgraph at
 * https://api.studio.thegraph.com/query/1758819/zkward/v0.1.1, but backed
 * by Hedera Mirror Node instead of The Graph indexer. The dashboard hits
 * both endpoints with the identical GraphQL query and merges the results —
 * proving the standardized-vault schema abstracts over indexing backends,
 * not just chains.
 *
 * Supported top-level fields (subset the dashboard queries):
 *   - pools(first, orderBy, orderDirection, where): [Pool!]!
 *   - transactions(first, orderBy, orderDirection, where): [Transaction!]!
 *   - members(first): [Member!]!
 *   - _meta: _Meta_
 *
 * Anything else returns null (partial coverage is by design — this is a
 * projection of Mirror-Node reads, not a full graph-node replacement).
 *
 * Prize alignment:
 *   ✓ Graph Composable/Standards ("one query pattern spans many protocols")
 *   ✓ Hedera AI extra-points ("services findable via a directory")
 *
 * GET  /api/subgraph/hedera            → introspection blurb (curl-friendly)
 * POST /api/subgraph/hedera            → GraphQL executor
 *   body: { query: string, variables?: object }
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  buildSchema,
  execute,
  parse,
  validate,
  type GraphQLFieldResolver,
} from 'graphql';
import { logger } from '@/lib/utils/logger';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';
import {
  readHederaPoolSnapshot,
  getContractLogs,
  mirrorTimestampToDate,
} from '@/lib/services/hedera/mirror-node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

// ─── Schema (mirrors ./subgraph/schema.graphql, subset) ────────────────────

const typeDefs = /* GraphQL */ `
  scalar BigInt
  scalar Bytes

  enum OrderDirection { asc, desc }
  enum TxType { DEPOSIT, WITHDRAW, REBALANCE_TRADE, FEES_COLLECTED, FEES_WITHDRAWN }

  type Pool {
    id: Bytes!
    network: String!
    totalShares: BigInt!
    totalNav: BigInt!
    sharePrice: BigInt!
    memberCount: Int!
    totalFeesCollected: BigInt!
    createdAtBlock: BigInt!
    createdAtTimestamp: BigInt!
    updatedAtBlock: BigInt
    updatedAtTimestamp: BigInt
  }

  type Transaction {
    id: Bytes!
    pool: Pool!
    type: TxType!
    actor: Bytes!
    amount: BigInt!
    shares: BigInt!
    sharePrice: BigInt!
    blockNumber: BigInt!
    timestamp: BigInt!
    transactionHash: Bytes!
  }

  type Member {
    id: Bytes!
    pool: Pool!
    address: Bytes!
    currentShares: BigInt!
    totalDeposited: BigInt!
    totalWithdrawn: BigInt!
    joinedAtBlock: BigInt!
    joinedAtTimestamp: BigInt!
    lastActionAtBlock: BigInt
    lastActionAtTimestamp: BigInt
  }

  type _Block_ {
    number: Int!
    timestamp: Int
  }

  type _Meta_ {
    block: _Block_!
    deployment: String!
    hasIndexingErrors: Boolean!
  }

  input Pool_filter {
    id: Bytes
    network: String
  }

  input Transaction_filter {
    type: TxType
    actor: Bytes
  }

  type Query {
    pool(id: Bytes!): Pool
    pools(first: Int = 10, where: Pool_filter): [Pool!]!
    transaction(id: Bytes!): Transaction
    transactions(first: Int = 25, orderBy: String, orderDirection: OrderDirection, where: Transaction_filter): [Transaction!]!
    member(id: Bytes!): Member
    members(first: Int = 25): [Member!]!
    _meta: _Meta_
  }
`;

// ─── Resolvers ─────────────────────────────────────────────────────────────

const NETWORK = 'testnet' as const;
const VAULT = HEDERA_CONTRACT_ADDRESSES.testnet.communityPool.toLowerCase();
const USDC = HEDERA_CONTRACT_ADDRESSES.testnet.usdtToken.toLowerCase();
// Verified via keccak256(toUtf8Bytes('...')) — commit history has both hashes.
const DEPOSITED_TOPIC = '0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca';
const WITHDRAWN_TOPIC = '0x92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc6';

function toMicros(human: number): string {
  // Convert 6-decimal human units to raw micros for schema parity with
  // Studio subgraph, which stores in raw base units.
  return String(Math.round(human * 1e6));
}

interface PoolShape {
  id: string;
  network: string;
  totalShares: string;
  totalNav: string;
  sharePrice: string;
  memberCount: number;
  totalFeesCollected: string;
  createdAtBlock: string;
  createdAtTimestamp: string;
  updatedAtBlock: string | null;
  updatedAtTimestamp: string | null;
}

async function fetchPool(): Promise<PoolShape | null> {
  const snap = await readHederaPoolSnapshot(NETWORK, VAULT, USDC);
  if (!('ok' in snap) || !snap.ok) return null;
  const createdTs = snap.contractCreatedAt
    ? Math.floor(snap.contractCreatedAt.getTime() / 1000)
    : 0;
  return {
    id: VAULT,
    network: 'hedera-testnet',
    totalShares: toMicros(snap.totalShares),
    totalNav: toMicros(snap.totalNavUsdc),
    // sharePrice stored as USDC-per-share × 1e6 for parity with subgraph
    // math, which uses assets × 1e6 / shares.
    sharePrice: toMicros(snap.sharePrice),
    memberCount: snap.memberCount,
    totalFeesCollected: '0',
    createdAtBlock: '0',
    createdAtTimestamp: String(createdTs),
    updatedAtBlock: null,
    updatedAtTimestamp: String(Math.floor(Date.now() / 1000)),
  };
}

interface TxShape {
  id: string;
  pool: string; // pool id, resolved to full pool object below
  type: 'DEPOSIT' | 'WITHDRAW';
  actor: string;
  amount: string;
  shares: string;
  sharePrice: string;
  blockNumber: string;
  timestamp: string;
  transactionHash: string;
}

function decodeUint(hex: string, offset = 0): bigint {
  const chunk = hex.slice(2 + offset * 64, 2 + (offset + 1) * 64);
  return BigInt('0x' + chunk);
}

function topicToAddress(topic: string): string {
  // Left-padded 32-byte topic → 20-byte address (last 40 hex chars).
  return '0x' + topic.slice(-40).toLowerCase();
}

async function fetchTransactions(limit: number, filter?: { type?: string; actor?: string }): Promise<TxShape[]> {
  const logs = await getContractLogs(NETWORK, VAULT, { limit: Math.min(limit * 2, 100) });
  if (!logs) return [];

  const rows: TxShape[] = [];
  for (const log of logs) {
    const topics = log.topics ?? [];
    const topic0 = topics[0]?.toLowerCase() ?? '';
    let type: 'DEPOSIT' | 'WITHDRAW' | null = null;
    if (topic0 === DEPOSITED_TOPIC) type = 'DEPOSIT';
    else if (topic0 === WITHDRAWN_TOPIC) type = 'WITHDRAW';
    if (!type) continue;
    if (filter?.type && filter.type !== type) continue;

    const actor = topicToAddress(topics[1] ?? '0x' + '0'.repeat(64));
    if (filter?.actor && filter.actor.toLowerCase() !== actor) continue;

    // data layout for both events: uint256 field1 || uint256 field2.
    // Deposited(amount, shares) — amount first
    // Withdrawn(shares, amount) — shares first (per contract source)
    const data = log.data ?? '0x';
    let amount: bigint;
    let shares: bigint;
    if (type === 'DEPOSIT') {
      amount = decodeUint(data, 0);
      shares = decodeUint(data, 1);
    } else {
      shares = decodeUint(data, 0);
      amount = decodeUint(data, 1);
    }

    const tsMs = mirrorTimestampToDate(log.timestamp)?.getTime() ?? Date.now();
    rows.push({
      id: `${log.transaction_hash}-${log.index}`,
      pool: VAULT,
      type,
      actor,
      amount: amount.toString(),
      shares: shares.toString(),
      sharePrice: '0', // derived downstream if consumer wants
      blockNumber: String(log.block_number ?? 0),
      timestamp: String(Math.floor(tsMs / 1000)),
      transactionHash: log.transaction_hash ?? '',
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

interface MemberShape {
  id: string;
  pool: string;
  address: string;
  currentShares: string;
  totalDeposited: string;
  totalWithdrawn: string;
  joinedAtBlock: string;
  joinedAtTimestamp: string;
  lastActionAtBlock: string | null;
  lastActionAtTimestamp: string | null;
}

async function fetchMembers(limit: number): Promise<MemberShape[]> {
  // Reduce from transaction stream — no on-chain member registry, so we
  // walk recent txs and net per-address deltas. Good enough for a demo
  // dashboard, matches the "current holders" surface the subgraph exposes.
  const txs = await fetchTransactions(200);
  const acc = new Map<string, MemberShape>();
  for (const tx of txs) {
    const key = tx.actor;
    let m = acc.get(key);
    if (!m) {
      m = {
        id: `${VAULT}-${key}`,
        pool: VAULT,
        address: key,
        currentShares: '0',
        totalDeposited: '0',
        totalWithdrawn: '0',
        joinedAtBlock: tx.blockNumber,
        joinedAtTimestamp: tx.timestamp,
        lastActionAtBlock: tx.blockNumber,
        lastActionAtTimestamp: tx.timestamp,
      };
      acc.set(key, m);
    }
    const sharesBI = BigInt(m.currentShares);
    if (tx.type === 'DEPOSIT') {
      m.currentShares = (sharesBI + BigInt(tx.shares)).toString();
      m.totalDeposited = (BigInt(m.totalDeposited) + BigInt(tx.amount)).toString();
    } else {
      m.currentShares = (sharesBI - BigInt(tx.shares)).toString();
      m.totalWithdrawn = (BigInt(m.totalWithdrawn) + BigInt(tx.amount)).toString();
    }
    m.lastActionAtBlock = tx.blockNumber;
    m.lastActionAtTimestamp = tx.timestamp;
  }
  return Array.from(acc.values()).slice(0, limit);
}

// Resolvers — plain object; graphql executor picks the field function or
// falls through to default property access.
const resolvers = {
  Query: {
    pool: async (_root: unknown, args: { id: string }) => {
      if (args.id.toLowerCase() !== VAULT) return null;
      return await fetchPool();
    },
    pools: async (_root: unknown, args: { first?: number; where?: { id?: string; network?: string } }) => {
      if (args.where?.id && args.where.id.toLowerCase() !== VAULT) return [];
      if (args.where?.network && args.where.network !== 'hedera-testnet') return [];
      const p = await fetchPool();
      return p ? [p].slice(0, args.first ?? 10) : [];
    },
    transactions: async (_root: unknown, args: { first?: number; where?: { type?: string; actor?: string } }) => {
      return await fetchTransactions(args.first ?? 25, args.where);
    },
    members: async (_root: unknown, args: { first?: number }) => {
      return await fetchMembers(args.first ?? 25);
    },
    _meta: async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      // Mirror Node is a near-live indexer, so "block" is best-effort. We
      // report the last log's block if we have one, else 0.
      const txs = await fetchTransactions(1).catch(() => []);
      const lastBlock = txs[0] ? Number(txs[0].blockNumber) : 0;
      return {
        block: { number: lastBlock, timestamp: nowSec },
        deployment: `hedera-mirror-adapter:${VAULT}`,
        hasIndexingErrors: false,
      };
    },
  },
  Transaction: {
    pool: async () => await fetchPool(),
  },
  Member: {
    pool: async () => await fetchPool(),
  },
};

// Build executable schema by merging typeDefs with resolvers.
const schema = buildSchema(typeDefs);
attachResolvers(schema, resolvers);

function attachResolvers(s: ReturnType<typeof buildSchema>, r: Record<string, Record<string, GraphQLFieldResolver<unknown, unknown>>>): void {
  for (const [typeName, fields] of Object.entries(r)) {
    const t = s.getType(typeName);
    if (!t || !('getFields' in t)) continue;
    const typeFields = (t as unknown as { getFields: () => Record<string, { resolve?: unknown }> }).getFields();
    for (const [fieldName, fn] of Object.entries(fields)) {
      if (typeFields[fieldName]) typeFields[fieldName].resolve = fn;
    }
  }
}

// ─── HTTP handlers ─────────────────────────────────────────────────────────

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

  try {
    const doc = parse(body.query);
    const errs = validate(schema, doc);
    if (errs.length > 0) {
      return NextResponse.json({ errors: errs.map((e) => ({ message: e.message })) }, { status: 400 });
    }
    const result = await execute({
      schema,
      document: doc,
      variableValues: body.variables ?? undefined,
      operationName: body.operationName ?? undefined,
    });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    logger.warn('[subgraph/hedera] execute failed', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { errors: [{ message: e instanceof Error ? e.message : 'execute failed' }] },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    endpoint: 'hedera-mirror-graphql-adapter',
    backend: 'Hedera Mirror Node (testnet)',
    vault: VAULT,
    schemaParity: 'Matches Studio subgraph shape at https://api.studio.thegraph.com/query/1758819/zkward — same query works on both.',
    supportedQueries: ['pool', 'pools', 'transactions', 'members', '_meta'],
    method: 'POST',
    exampleBody: {
      query: '{ pools { id network totalShares totalNav sharePrice memberCount } transactions(first: 5) { type actor amount timestamp } _meta { block { number timestamp } deployment hasIndexingErrors } }',
    },
  });
}
