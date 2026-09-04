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

// Exported for unit test coverage — bucketing is where subtle bugs hide.
export const _internal = { bucketNavSnapshots };
