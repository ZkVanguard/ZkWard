/**
 * Extended subgraph queries — hedges, transactions, pool state, member.
 *
 * Locks the unit-normalization (bigint strings → plain USD numbers) and
 * the null-on-failure contract every consumer depends on. Off-by-one on
 * a decimal shift here would show up in the dashboard as pool values in
 * the wrong order of magnitude — worst kind of silent bug.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };
const originalFetch = global.fetch;

beforeEach(() => {
  jest.resetAllMocks?.();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  process.env.SUBGRAPH_URL = 'https://mock.subgraph.io/x/y';
  global.fetch = originalFetch;
});

function mockGraphResponse(data: unknown) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data }),
  })) as unknown as typeof fetch;
}

describe('fetchHedgesFromSubgraph', () => {
  it('normalizes 6-decimal collateral + PnL to plain USD', async () => {
    mockGraphResponse({
      hedges: [
        {
          id: '0xdeadbeef',
          pairIndex: 0,
          collateralAmount: '5000000000',   // 6-decimal → 5000 USD
          leverage: '3',
          isLong: true,
          status: 'OPEN',
          realizedPnl: null,
          openReasonHash: '0x00',
          closeReasonHash: null,
          openedAtTimestamp: '1767225600',
          closedAtTimestamp: null,
        },
        {
          id: '0xcafe',
          pairIndex: 1,
          collateralAmount: '2500000000',   // 2500 USD
          leverage: '2',
          isLong: false,
          status: 'CLOSED',
          realizedPnl: '-750000000',        // -750 USD
          openReasonHash: '0x11',
          closeReasonHash: '0x22',
          openedAtTimestamp: '1767225600',
          closedAtTimestamp: '1767229200',
        },
      ],
    });
    const { fetchHedgesFromSubgraph } = await import('@/lib/graph/queries');
    const rows = await fetchHedgesFromSubgraph();
    expect(rows).not.toBeNull();
    expect(rows!).toHaveLength(2);
    expect(rows![0].collateralAmount).toBeCloseTo(5000, 6);
    expect(rows![0].realizedPnl).toBeNull();
    expect(rows![0].closedAt).toBeNull();
    expect(rows![1].realizedPnl).toBeCloseTo(-750, 6);
    expect(rows![1].closedAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('returns null on subgraph failure (consumer falls back to DB)', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { fetchHedgesFromSubgraph } = await import('@/lib/graph/queries');
    const rows = await fetchHedgesFromSubgraph();
    expect(rows).toBeNull();
  });

  it('applies status filter in the GraphQL query', async () => {
    let capturedBody: unknown;
    global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
      capturedBody = init?.body ? JSON.parse(init.body) : null;
      return { ok: true, status: 200, json: async () => ({ data: { hedges: [] } }) };
    }) as unknown as typeof fetch;
    const { fetchHedgesFromSubgraph } = await import('@/lib/graph/queries');
    await fetchHedgesFromSubgraph({ status: 'OPEN' });
    expect((capturedBody as { query: string }).query).toContain('status: OPEN');
  });
});

describe('fetchPoolTransactionsFromSubgraph', () => {
  it('normalizes deposit amounts + share price', async () => {
    mockGraphResponse({
      transactions: [
        {
          id: '0xabc',
          type: 'DEPOSIT',
          actor: '0xf00',
          amount: '1000000000',          // 1000 USD (6-decimal)
          shares: '500000000000000000000', // 500 shares (1e18)
          sharePrice: '2000000000000000000', // 2.0 (1e18)
          managementFeeAmount: null,
          performanceFeeAmount: null,
          timestamp: '1767225600',
          transactionHash: '0xhash',
        },
      ],
    });
    const { fetchPoolTransactionsFromSubgraph } = await import('@/lib/graph/queries');
    const rows = await fetchPoolTransactionsFromSubgraph();
    expect(rows).not.toBeNull();
    expect(rows![0].amount).toBeCloseTo(1000, 6);
    expect(rows![0].shares).toBeCloseTo(500, 6);
    expect(rows![0].sharePrice).toBeCloseTo(2.0, 6);
  });

  it('normalizes fee amounts when present', async () => {
    mockGraphResponse({
      transactions: [
        {
          id: '0xfee',
          type: 'FEES_COLLECTED',
          actor: '0x00',
          amount: '5000000',              // 5 USD total
          shares: '0',
          sharePrice: '0',
          managementFeeAmount: '3000000', // 3 USD
          performanceFeeAmount: '2000000',// 2 USD
          timestamp: '1767225600',
          transactionHash: '0xf',
        },
      ],
    });
    const { fetchPoolTransactionsFromSubgraph } = await import('@/lib/graph/queries');
    const rows = await fetchPoolTransactionsFromSubgraph();
    expect(rows![0].managementFeeAmount).toBeCloseTo(3, 6);
    expect(rows![0].performanceFeeAmount).toBeCloseTo(2, 6);
  });

  it('lowercases actor filter for exact-match indexing', async () => {
    let captured: string | undefined;
    global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      captured = body?.query;
      return { ok: true, status: 200, json: async () => ({ data: { transactions: [] } }) };
    }) as unknown as typeof fetch;
    const { fetchPoolTransactionsFromSubgraph } = await import('@/lib/graph/queries');
    await fetchPoolTransactionsFromSubgraph({ actor: '0xABCDEF' });
    expect(captured).toContain('actor: "0xabcdef"');
  });
});

describe('fetchPoolStateFromSubgraph', () => {
  it('returns null when the pool entity is missing', async () => {
    mockGraphResponse({ pool: null });
    const { fetchPoolStateFromSubgraph } = await import('@/lib/graph/queries');
    const state = await fetchPoolStateFromSubgraph('0xdeadbeef');
    expect(state).toBeNull();
  });

  it('normalizes pool aggregates + allocations', async () => {
    mockGraphResponse({
      pool: {
        id: '0x07d68c2828f35327d12a7ba796ccf3f12f8a1086',
        network: 'sepolia',
        totalNav: '10000000000',         // 10k USD
        totalShares: '5000000000000000000000', // 5k shares
        sharePrice: '2000000000000000000',     // 2.0
        memberCount: 42,
        totalFeesCollected: '150000000',       // 150 USD
        allocations: [
          { assetIndex: 0, targetBps: '3000' },
          { assetIndex: 1, targetBps: '3000' },
          { assetIndex: 2, targetBps: '2000' },
          { assetIndex: 3, targetBps: '2000' },
        ],
      },
    });
    const { fetchPoolStateFromSubgraph } = await import('@/lib/graph/queries');
    const state = await fetchPoolStateFromSubgraph('0x07d68C2828F35327d12a7Ba796cCF3f12F8A1086');
    expect(state).not.toBeNull();
    expect(state!.totalNav).toBeCloseTo(10000, 6);
    expect(state!.totalShares).toBeCloseTo(5000, 6);
    expect(state!.sharePrice).toBeCloseTo(2.0, 6);
    expect(state!.memberCount).toBe(42);
    expect(state!.allocations).toHaveLength(4);
    expect(state!.allocations[0].targetBps).toBe(3000);
  });
});

describe('fetchMemberPositionFromSubgraph', () => {
  it('normalizes share balance + totals', async () => {
    mockGraphResponse({
      member: {
        address: '0xabc',
        currentShares: '1000000000000000000000', // 1000 shares
        totalDeposited: '500000000',              // 500 USD
        totalWithdrawn: '100000000',              // 100 USD
        joinedAtTimestamp: '1767225600',
        lastActionAtTimestamp: '1767229200',
      },
    });
    const { fetchMemberPositionFromSubgraph } = await import('@/lib/graph/queries');
    const pos = await fetchMemberPositionFromSubgraph('0xPOOL', '0xABC');
    expect(pos).not.toBeNull();
    expect(pos!.currentShares).toBeCloseTo(1000, 6);
    expect(pos!.totalDeposited).toBeCloseTo(500, 6);
    expect(pos!.totalWithdrawn).toBeCloseTo(100, 6);
  });

  it('returns null when member entity is missing', async () => {
    mockGraphResponse({ member: null });
    const { fetchMemberPositionFromSubgraph } = await import('@/lib/graph/queries');
    const pos = await fetchMemberPositionFromSubgraph('0xPOOL', '0xABC');
    expect(pos).toBeNull();
  });
});
