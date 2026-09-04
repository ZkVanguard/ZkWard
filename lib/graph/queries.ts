/**
 * Typed queries against the Standardized Vault subgraph.
 *
 * Each function corresponds to a former Aiven SELECT — same input shape,
 * same output shape as far as the calling API route is concerned. That
 * means an endpoint migration is a swap-not-rewrite: read via this
 * module when SUBGRAPH_READS_ENABLED, fall back to the original SQL
 * otherwise.
 *
 * Every function returns null on subgraph failure so callers can
 * cleanly fall through to Postgres.
 */

import { subgraphQuery } from './subgraph-client';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface NavSnapshotRow {
  /** Bucket start ISO — for compat with the Postgres date_trunc bucketing. */
  t: string;
  sharePrice: number;
  navUsd: number;
}

// ─── NAV history ───────────────────────────────────────────────────────────

interface RawNavSnapshot {
  timestamp: string; // uint256 seconds as string
  sharePrice: string; // 1e18 fixed point
  totalNav: string;
}

interface NavSnapshotsResponse {
  navSnapshots: RawNavSnapshot[];
}

/**
 * Fetch NAV snapshots from the subgraph for a window, then bucket in JS
 * to match the Postgres `date_trunc + AVG` output shape.
 *
 * The subgraph returns raw per-tx snapshots; the Postgres query returned
 * bucket averages. We do the bucketing here so downstream consumers
 * don't need to know which backend served the data.
 */
export async function fetchNavHistoryFromSubgraph(args: {
  sinceSeconds: number; // unix seconds — floor of the window
  bucket: 'minute' | 'hour' | 'day';
  /** Cap raw row count to bound response. 10k covers >year at hourly cadence. */
  maxRawRows?: number;
}): Promise<NavSnapshotRow[] | null> {
  const query = /* GraphQL */ `
    query NavHistory($since: BigInt!, $first: Int!) {
      navSnapshots(
        first: $first
        orderBy: timestamp
        orderDirection: asc
        where: { timestamp_gt: $since }
      ) {
        timestamp
        sharePrice
        totalNav
      }
    }
  `;
  const first = Math.max(1, Math.min(args.maxRawRows ?? 10_000, 1000));
  // The Graph caps `first` at 1000 per query; loop with skip if we ever
  // need more than that. For a 60-day / hourly view that's ~1440 rows,
  // so we bump the cap and page for large windows only.
  const pages: RawNavSnapshot[] = [];
  let skip = 0;
  const target = args.maxRawRows ?? 10_000;
  while (pages.length < target) {
    const data = await subgraphQuery<NavSnapshotsResponse>(
      query.replace('$first: Int!', '$first: Int!, $skip: Int!').replace(
        'navSnapshots(\n        first: $first',
        'navSnapshots(\n        first: $first\n        skip: $skip',
      ),
      { since: String(args.sinceSeconds), first, skip },
    );
    if (!data) return null;
    const batch = data.navSnapshots ?? [];
    pages.push(...batch);
    if (batch.length < first) break; // no more pages
    skip += batch.length;
    if (skip > 50_000) break; // absolute safety cap
  }
  return bucketNavSnapshots(pages, args.bucket);
}

// ─── Bucketing (JS-side, mirrors Postgres date_trunc + AVG) ────────────────

const BUCKET_SEC: Record<'minute' | 'hour' | 'day', number> = {
  minute: 60,
  hour: 60 * 60,
  day: 60 * 60 * 24,
};

function bucketNavSnapshots(
  rows: RawNavSnapshot[],
  bucket: 'minute' | 'hour' | 'day',
): NavSnapshotRow[] {
  if (rows.length === 0) return [];
  const step = BUCKET_SEC[bucket];
  const acc = new Map<number, { spSum: number; navSum: number; n: number }>();
  for (const r of rows) {
    const ts = Number(r.timestamp);
    if (!Number.isFinite(ts)) continue;
    const bucketStart = Math.floor(ts / step) * step;
    // sharePrice is 1e18 fixed point in the subgraph; the Postgres impl
    // stored it as a plain decimal string. Normalize to plain number so
    // consumers see the same magnitude.
    const sp = Number(r.sharePrice) / 1e18;
    const nav = Number(r.totalNav) / 1e6; // USDT/USDC 6-decimal → USD
    const slot = acc.get(bucketStart) ?? { spSum: 0, navSum: 0, n: 0 };
    slot.spSum += sp;
    slot.navSum += nav;
    slot.n += 1;
    acc.set(bucketStart, slot);
  }
  return Array.from(acc.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStart, { spSum, navSum, n }]) => ({
      t: new Date(bucketStart * 1000).toISOString(),
      sharePrice: spSum / n,
      navUsd: navSum / n,
    }));
}

// ─── Hedges (open + closed lifecycle) ─────────────────────────────────────

export interface HedgeRow {
  id: string;                  // hedgeId from PoolHedgeOpened
  pairIndex: number;
  collateralAmount: number;    // normalized to plain USD
  leverage: number;
  isLong: boolean;
  status: 'OPEN' | 'CLOSED';
  realizedPnl: number | null;  // signed USD, null while OPEN
  openedAt: string;            // ISO
  closedAt: string | null;
  openReasonHash: string;
  closeReasonHash: string | null;
}

interface RawHedge {
  id: string;
  pairIndex: number;
  collateralAmount: string;
  leverage: string;
  isLong: boolean;
  status: 'OPEN' | 'CLOSED';
  realizedPnl: string | null;
  openReasonHash: string;
  closeReasonHash: string | null;
  openedAtTimestamp: string;
  closedAtTimestamp: string | null;
}

interface HedgesResponse {
  hedges: RawHedge[];
}

export async function fetchHedgesFromSubgraph(args?: {
  status?: 'OPEN' | 'CLOSED';
  first?: number;
  skip?: number;
}): Promise<HedgeRow[] | null> {
  const first = Math.max(1, Math.min(args?.first ?? 100, 1000));
  const skip = Math.max(0, args?.skip ?? 0);
  const whereClause = args?.status ? `where: { status: ${args.status} }` : '';
  const query = /* GraphQL */ `
    query Hedges($first: Int!, $skip: Int!) {
      hedges(
        first: $first
        skip: $skip
        orderBy: openedAtTimestamp
        orderDirection: desc
        ${whereClause}
      ) {
        id
        pairIndex
        collateralAmount
        leverage
        isLong
        status
        realizedPnl
        openReasonHash
        closeReasonHash
        openedAtTimestamp
        closedAtTimestamp
      }
    }
  `;
  const data = await subgraphQuery<HedgesResponse>(query, { first, skip });
  if (!data) return null;
  return data.hedges.map((h) => ({
    id: h.id,
    pairIndex: h.pairIndex,
    // 6-decimal USD normalization
    collateralAmount: Number(h.collateralAmount) / 1e6,
    leverage: Number(h.leverage),
    isLong: h.isLong,
    status: h.status,
    realizedPnl: h.realizedPnl != null ? Number(h.realizedPnl) / 1e6 : null,
    openedAt: new Date(Number(h.openedAtTimestamp) * 1000).toISOString(),
    closedAt: h.closedAtTimestamp
      ? new Date(Number(h.closedAtTimestamp) * 1000).toISOString()
      : null,
    openReasonHash: h.openReasonHash,
    closeReasonHash: h.closeReasonHash,
  }));
}

// ─── Pool transactions (DEPOSIT / WITHDRAW / FEES) ────────────────────────

export interface TransactionRow {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAW' | 'FEES_COLLECTED' | 'FEES_WITHDRAWN';
  actor: string;
  amount: number;              // USD
  shares: number;
  sharePrice: number;
  managementFeeAmount: number | null;
  performanceFeeAmount: number | null;
  timestamp: string;           // ISO
  txHash: string;
}

interface RawTransaction {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAW' | 'FEES_COLLECTED' | 'FEES_WITHDRAWN';
  actor: string;
  amount: string;
  shares: string;
  sharePrice: string;
  managementFeeAmount: string | null;
  performanceFeeAmount: string | null;
  timestamp: string;
  transactionHash: string;
}

interface TransactionsResponse {
  transactions: RawTransaction[];
}

export async function fetchPoolTransactionsFromSubgraph(args?: {
  type?: 'DEPOSIT' | 'WITHDRAW' | 'FEES_COLLECTED' | 'FEES_WITHDRAWN';
  actor?: string;              // 0x-address filter
  first?: number;
  skip?: number;
}): Promise<TransactionRow[] | null> {
  const first = Math.max(1, Math.min(args?.first ?? 50, 1000));
  const skip = Math.max(0, args?.skip ?? 0);
  const filters: string[] = [];
  if (args?.type) filters.push(`type: ${args.type}`);
  if (args?.actor) filters.push(`actor: "${args.actor.toLowerCase()}"`);
  const whereClause = filters.length ? `where: { ${filters.join(', ')} }` : '';
  const query = /* GraphQL */ `
    query Transactions($first: Int!, $skip: Int!) {
      transactions(
        first: $first
        skip: $skip
        orderBy: timestamp
        orderDirection: desc
        ${whereClause}
      ) {
        id
        type
        actor
        amount
        shares
        sharePrice
        managementFeeAmount
        performanceFeeAmount
        timestamp
        transactionHash
      }
    }
  `;
  const data = await subgraphQuery<TransactionsResponse>(query, { first, skip });
  if (!data) return null;
  return data.transactions.map((t) => ({
    id: t.id,
    type: t.type,
    actor: t.actor,
    amount: Number(t.amount) / 1e6,
    shares: Number(t.shares) / 1e18,
    sharePrice: Number(t.sharePrice) / 1e18,
    managementFeeAmount: t.managementFeeAmount != null ? Number(t.managementFeeAmount) / 1e6 : null,
    performanceFeeAmount: t.performanceFeeAmount != null ? Number(t.performanceFeeAmount) / 1e6 : null,
    timestamp: new Date(Number(t.timestamp) * 1000).toISOString(),
    txHash: t.transactionHash,
  }));
}

// ─── Pool state (latest snapshot + allocations) ───────────────────────────

export interface PoolStateRow {
  address: string;
  network: string;
  totalNav: number;
  totalShares: number;
  sharePrice: number;
  memberCount: number;
  totalFeesCollected: number;
  allocations: Array<{ assetIndex: number; targetBps: number }>;
}

interface RawPoolState {
  id: string;
  network: string;
  totalNav: string;
  totalShares: string;
  sharePrice: string;
  memberCount: number;
  totalFeesCollected: string;
  allocations: Array<{ assetIndex: number; targetBps: string }>;
}

interface PoolStateResponse {
  pool: RawPoolState | null;
}

export async function fetchPoolStateFromSubgraph(
  poolAddress: string,
): Promise<PoolStateRow | null> {
  const query = /* GraphQL */ `
    query PoolState($id: Bytes!) {
      pool(id: $id) {
        id
        network
        totalNav
        totalShares
        sharePrice
        memberCount
        totalFeesCollected
        allocations(orderBy: assetIndex, orderDirection: asc) {
          assetIndex
          targetBps
        }
      }
    }
  `;
  const data = await subgraphQuery<PoolStateResponse>(query, {
    id: poolAddress.toLowerCase(),
  });
  if (!data || !data.pool) return null;
  const p = data.pool;
  return {
    address: p.id,
    network: p.network,
    totalNav: Number(p.totalNav) / 1e6,
    totalShares: Number(p.totalShares) / 1e18,
    sharePrice: Number(p.sharePrice) / 1e18,
    memberCount: p.memberCount,
    totalFeesCollected: Number(p.totalFeesCollected) / 1e6,
    allocations: p.allocations.map((a) => ({
      assetIndex: a.assetIndex,
      targetBps: Number(a.targetBps),
    })),
  };
}

// ─── Member position (per-user aggregate) ─────────────────────────────────

export interface MemberPositionRow {
  address: string;
  currentShares: number;
  totalDeposited: number;
  totalWithdrawn: number;
  joinedAt: string;
  lastActionAt: string;
}

interface RawMember {
  address: string;
  currentShares: string;
  totalDeposited: string;
  totalWithdrawn: string;
  joinedAtTimestamp: string;
  lastActionAtTimestamp: string;
}

interface MemberResponse {
  member: RawMember | null;
}

export async function fetchMemberPositionFromSubgraph(
  poolAddress: string,
  memberAddress: string,
): Promise<MemberPositionRow | null> {
  const memberId = `${poolAddress.toLowerCase()}${memberAddress.slice(2).toLowerCase()}`;
  const query = /* GraphQL */ `
    query Member($id: Bytes!) {
      member(id: $id) {
        address
        currentShares
        totalDeposited
        totalWithdrawn
        joinedAtTimestamp
        lastActionAtTimestamp
      }
    }
  `;
  const data = await subgraphQuery<MemberResponse>(query, { id: memberId });
  if (!data || !data.member) return null;
  const m = data.member;
  return {
    address: m.address,
    currentShares: Number(m.currentShares) / 1e18,
    totalDeposited: Number(m.totalDeposited) / 1e6,
    totalWithdrawn: Number(m.totalWithdrawn) / 1e6,
    joinedAt: new Date(Number(m.joinedAtTimestamp) * 1000).toISOString(),
    lastActionAt: new Date(Number(m.lastActionAtTimestamp) * 1000).toISOString(),
  };
}

// Exported for unit test coverage — bucketing is where subtle bugs hide.
export const _internal = { bucketNavSnapshots };
