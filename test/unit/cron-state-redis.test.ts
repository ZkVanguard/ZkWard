/**
 * Redis cron-state client — API-parity tests.
 *
 * These lock the public surface of `lib/db/cron-state-redis.ts` so a future
 * refactor cannot silently break the dual-write bridge in `lib/db/cron-state.ts`.
 *
 * We mock `@upstash/redis` with an in-memory shim so the tests run without
 * a live Redis. That's fine here — the goal is API shape, key namespacing,
 * ring-buffer semantics, and CAS/lock ordering, not to prove the Upstash
 * SDK works.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// ─── Minimal in-memory Redis shim ─────────────────────────────────────────
const store = new Map<string, unknown>();
const lists = new Map<string, unknown[]>();

const mockRedis = {
  get: jest.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
  set: jest.fn(async (k: string, v: unknown, opts?: { nx?: boolean; ex?: number }) => {
    if (opts?.nx && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  }),
  del: jest.fn(async (k: string) => {
    const had = store.delete(k);
    return had ? 1 : 0;
  }),
  mget: jest.fn(async (...keys: string[]) => keys.map(k => (store.has(k) ? store.get(k) : null))),
  scan: jest.fn(async (_cursor: number | string, opts: { match: string; count: number }) => {
    const prefix = opts.match.replace(/\*$/, '');
    const matches = Array.from(store.keys()).filter(k => k.startsWith(prefix));
    return [0, matches] as [number, string[]];
  }),
  lpush: jest.fn(async (k: string, v: unknown) => {
    const arr = lists.get(k) ?? [];
    arr.unshift(v);
    lists.set(k, arr);
    return arr.length;
  }),
  ltrim: jest.fn(async (k: string, start: number, stop: number) => {
    const arr = lists.get(k) ?? [];
    lists.set(k, arr.slice(start, stop + 1));
    return 'OK';
  }),
  lrange: jest.fn(async (k: string, start: number, stop: number) => {
    const arr = lists.get(k) ?? [];
    return arr.slice(start, stop + 1);
  }),
};

jest.mock('@upstash/redis', () => ({
  Redis: jest.fn().mockImplementation(() => mockRedis),
}));

const ORIGINAL_ENV = { ...process.env };
process.env.UPSTASH_REDIS_REST_URL = 'https://mock.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const redisImpl = require('@/lib/db/cron-state-redis');

beforeEach(() => {
  store.clear();
  lists.clear();
  jest.clearAllMocks();
  // Reset singleton so each test observes the mocked env fresh.
  redisImpl._resetRedisForTest();
});

describe('cron-state-redis — key/value parity', () => {
  it('round-trips a value with the namespaced key', async () => {
    await redisImpl.setCronState('poolNav:peak:sui-usdc-pool', 12345);
    expect(store.get('cs:poolNav:peak:sui-usdc-pool')).toBe(12345);
    const v = await redisImpl.getCronState<number>('poolNav:peak:sui-usdc-pool');
    expect(v).toBe(12345);
  });

  it('returns null for missing key (matches Postgres impl contract)', async () => {
    const v = await redisImpl.getCronState('never:written');
    expect(v).toBeNull();
  });

  it('getCronStateOr returns fallback when missing', async () => {
    const v = await redisImpl.getCronStateOr<number>('never:written', 42);
    expect(v).toBe(42);
  });

  it('deleteCronState removes the namespaced key', async () => {
    await redisImpl.setCronState('temp', 'x');
    await redisImpl.deleteCronState('temp');
    expect(store.has('cs:temp')).toBe(false);
  });

  it('getCronStateByPrefix strips the namespace on return', async () => {
    await redisImpl.setCronState('cron:lastRun:sui-cron', 100);
    await redisImpl.setCronState('cron:lastRun:hedera-cron', 200);
    await redisImpl.setCronState('poolNav:peak:sui', 999);
    const results = await redisImpl.getCronStateByPrefix<number>('cron:lastRun:');
    expect(results.size).toBe(2);
    expect(results.get('cron:lastRun:sui-cron')).toBe(100);
    expect(results.get('cron:lastRun:hedera-cron')).toBe(200);
    expect(results.has('poolNav:peak:sui')).toBe(false);
  });
});

describe('cron-state-redis — halt helpers', () => {
  it('setCronHalt writes both until and reason keys', async () => {
    const until = Date.now() + 60_000;
    await redisImpl.setCronHalt('trader', until, 'phantom rate breach');
    const halt = await redisImpl.getCronHalt('trader');
    expect(halt).not.toBeNull();
    expect(halt!.untilMs).toBe(until);
    expect(halt!.reason).toBe('phantom rate breach');
  });

  it('getCronHalt returns null for expired halt', async () => {
    const pastUntil = Date.now() - 1000;
    await redisImpl.setCronHalt('trader', pastUntil, 'old');
    const halt = await redisImpl.getCronHalt('trader');
    expect(halt).toBeNull();
  });

  it('getCronHalt returns null when never set', async () => {
    const halt = await redisImpl.getCronHalt('never-halted');
    expect(halt).toBeNull();
  });
});

describe('cron-state-redis — tryClaimCronRun (rate-limit + lock)', () => {
  it('first call within window claims successfully', async () => {
    const r = await redisImpl.tryClaimCronRun('sui-cron', 60_000, 1_000_000);
    expect(r.claimed).toBe(true);
    expect(r.lastRunMs).toBe(1_000_000);
  });

  it('second call inside min-interval is rate-limited', async () => {
    await redisImpl.tryClaimCronRun('sui-cron', 60_000, 1_000_000);
    const r2 = await redisImpl.tryClaimCronRun('sui-cron', 60_000, 1_030_000); // 30s later
    expect(r2.claimed).toBe(false);
    expect(r2.reason).toBe('rate-limit');
    expect(r2.lastRunMs).toBe(1_000_000);
  });

  it('call outside min-interval claims again', async () => {
    await redisImpl.tryClaimCronRun('sui-cron', 60_000, 1_000_000);
    const r2 = await redisImpl.tryClaimCronRun('sui-cron', 60_000, 1_070_000); // 70s later
    expect(r2.claimed).toBe(true);
    expect(r2.lastRunMs).toBe(1_070_000);
  });
});

describe('cron-state-redis — alert ring buffer (LIST-native)', () => {
  it('appendAlertLogRedis pushes and trims to max', async () => {
    for (let i = 0; i < 250; i++) {
      await redisImpl.appendAlertLogRedis({ at: i, level: 'WARN', message: `alert ${i}` });
    }
    const entries = await redisImpl.readAlertLogRedis<{ at: number }>();
    expect(entries).toHaveLength(200);
    // Oldest-first ordering (matches Postgres impl contract).
    // After 250 pushes with TRIM to 200, we keep entries 50..249; oldest kept is 50.
    expect(entries[0].at).toBe(50);
    expect(entries[199].at).toBe(249);
  });

  it('readAlertLogRedis returns empty when buffer is empty', async () => {
    const entries = await redisImpl.readAlertLogRedis();
    expect(entries).toEqual([]);
  });
});

describe('cron-state-redis — graceful degradation', () => {
  it('returns null / no-ops when Redis is unavailable', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    redisImpl._resetRedisForTest();

    const g = await redisImpl.getCronState('any');
    expect(g).toBeNull();
    await expect(redisImpl.setCronState('any', 1)).resolves.toBeUndefined();
    await expect(redisImpl.deleteCronState('any')).resolves.toBeUndefined();
    const claim = await redisImpl.tryClaimCronRun('any', 1000);
    expect(claim.claimed).toBe(false);
    expect(claim.reason).toBe('redis-unavailable');

    // Restore for downstream tests in same file
    process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.UPSTASH_REDIS_REST_URL ?? 'https://mock.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN ?? 'mock-token';
  });
});
