/**
 * Subgraph client + queries — lock the two things that break silently
 * on the read-migration path:
 *   1. Failure modes (unreachable / GraphQL errors / bad shape) return
 *      null, not throw. Consumers depend on that to fall through to
 *      Aiven cleanly.
 *   2. JS-side bucketing produces the same shape/order that the
 *      Postgres date_trunc + AVG query produced. Off-by-one there
 *      means a chart of NaNs or a missing "today" tick.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { _internal } from '@/lib/graph/queries';

const { bucketNavSnapshots } = _internal;

const ORIGINAL_ENV = { ...process.env };
const originalFetch = global.fetch;

beforeEach(() => {
  jest.resetAllMocks?.();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  process.env.SUBGRAPH_URL = 'https://mock.subgraph.io/x/y';
  global.fetch = originalFetch;
});

describe('subgraphQuery — failure modes return null (not throw)', () => {
  it('returns null when SUBGRAPH_URL is unset', async () => {
    delete process.env.SUBGRAPH_URL;
    const { subgraphQuery } = await import('@/lib/graph/subgraph-client');
    const r = await subgraphQuery('{ x }');
    expect(r).toBeNull();
  });

  it('returns null when SUBGRAPH_URL is not https', async () => {
    process.env.SUBGRAPH_URL = 'http://insecure.example.com/x';
    const { subgraphQuery } = await import('@/lib/graph/subgraph-client');
    const r = await subgraphQuery('{ x }');
    expect(r).toBeNull();
  });

  it('returns null on non-2xx', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch;
    const { subgraphQuery } = await import('@/lib/graph/subgraph-client');
    const r = await subgraphQuery('{ x }');
    expect(r).toBeNull();
  });

  it('returns null on GraphQL errors', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'field x not found' }] }),
    })) as unknown as typeof fetch;
    const { subgraphQuery } = await import('@/lib/graph/subgraph-client');
    const r = await subgraphQuery('{ x }');
    expect(r).toBeNull();
  });

  it('returns null on missing data field', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const { subgraphQuery } = await import('@/lib/graph/subgraph-client');
    const r = await subgraphQuery('{ x }');
    expect(r).toBeNull();
  });

  it('returns null on fetch throw', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { subgraphQuery } = await import('@/lib/graph/subgraph-client');
    const r = await subgraphQuery('{ x }');
    expect(r).toBeNull();
  });

  it('returns data on happy path', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { hello: 'world' } }),
    })) as unknown as typeof fetch;
    const { subgraphQuery } = await import('@/lib/graph/subgraph-client');
    const r = await subgraphQuery<{ hello: string }>('{ hello }');
    expect(r).toEqual({ hello: 'world' });
  });
});

describe('bucketNavSnapshots — parity with Postgres date_trunc + AVG', () => {
  const raw = (tsSec: number, sharePrice1e18: string, nav6dec: string) => ({
    timestamp: String(tsSec),
    sharePrice: sharePrice1e18,
    totalNav: nav6dec,
  });

  it('returns empty for empty input', () => {
    expect(bucketNavSnapshots([], 'hour')).toEqual([]);
  });

  it('produces one bucket per hour, averages sharePrice + nav in-bucket', () => {
    // 2026-01-01T00:00:00Z = 1767225600
    const base = 1767225600;
    const rows = [
      raw(base + 0, '1000000000000000000', '10000000'),      // sp=1.0, nav=10.0
      raw(base + 1800, '1200000000000000000', '12000000'),    // sp=1.2, nav=12.0 — same hour
      raw(base + 3600, '1100000000000000000', '11000000'),    // sp=1.1, nav=11.0 — next hour
    ];
    const points = bucketNavSnapshots(rows, 'hour');
    expect(points).toHaveLength(2);
    expect(points[0].t).toBe('2026-01-01T00:00:00.000Z');
    expect(points[0].sharePrice).toBeCloseTo(1.1, 6);        // (1.0 + 1.2) / 2
    expect(points[0].navUsd).toBeCloseTo(11.0, 6);           // (10 + 12) / 2
    expect(points[1].t).toBe('2026-01-01T01:00:00.000Z');
    expect(points[1].sharePrice).toBeCloseTo(1.1, 6);
    expect(points[1].navUsd).toBeCloseTo(11.0, 6);
  });

  it('day bucket floors to UTC midnight', () => {
    const rows = [
      raw(1767225600, '1000000000000000000', '10000000'),                    // 2026-01-01T00
      raw(1767225600 + 12 * 3600, '2000000000000000000', '20000000'),       // 2026-01-01T12
      raw(1767225600 + 24 * 3600, '3000000000000000000', '30000000'),       // 2026-01-02T00
    ];
    const points = bucketNavSnapshots(rows, 'day');
    expect(points).toHaveLength(2);
    expect(points[0].t).toBe('2026-01-01T00:00:00.000Z');
    expect(points[0].sharePrice).toBeCloseTo(1.5, 6);
    expect(points[1].t).toBe('2026-01-02T00:00:00.000Z');
    expect(points[1].sharePrice).toBeCloseTo(3.0, 6);
  });

  it('normalizes 1e18 sharePrice + 6-decimal NAV to plain USD units', () => {
    const rows = [raw(1767225600, '1900000000000000000', '4500000000')]; // sp=1.9, nav=4500 USD
    const [p] = bucketNavSnapshots(rows, 'hour');
    expect(p.sharePrice).toBeCloseTo(1.9, 6);
    expect(p.navUsd).toBeCloseTo(4500, 6);
  });

  it('skips rows with non-finite timestamps (defensive)', () => {
    const rows = [
      { timestamp: 'not-a-number', sharePrice: '1000000000000000000', totalNav: '10000000' },
      raw(1767225600, '1000000000000000000', '10000000'),
    ];
    const points = bucketNavSnapshots(rows, 'hour');
    expect(points).toHaveLength(1);
  });

  it('keeps buckets in ascending time order', () => {
    const rows = [
      raw(1767225600 + 7200, '1500000000000000000', '15000000'),
      raw(1767225600 + 0, '1000000000000000000', '10000000'),
      raw(1767225600 + 3600, '2000000000000000000', '20000000'),
    ];
    const points = bucketNavSnapshots(rows, 'hour');
    expect(points.map((p) => p.t)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T01:00:00.000Z',
      '2026-01-01T02:00:00.000Z',
    ]);
  });
});
