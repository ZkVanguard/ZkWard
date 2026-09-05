/**
 * Per-agent x402 budget tracker.
 *
 * Bounds how much any agent can spend on paid inference per day. Uses
 * Redis when available (via the cron-state-redis singleton), falls
 * back to an in-memory per-instance map otherwise — the fallback still
 * protects against runaway spend within a single Vercel instance, but
 * won't stop a cluster-wide over-spend the way Redis will.
 *
 * Keys are `x402:budget:<agentId>:<utcDate>`; values are microUSD spent.
 * Absolute per-day cap is `X402_DAILY_BUDGET_MICROS` (default $1.00 =
 * 1_000_000 micros).
 *
 * Called from lib/services/x402/client.ts around each paid request.
 */

import { logger } from '@/lib/utils/logger';

const DEFAULT_DAILY_CAP_MICROS = 1_000_000n; // $1.00 default

function getDailyCapMicros(): bigint {
  const raw = (process.env.X402_DAILY_BUDGET_MICROS || '').trim();
  if (!raw) return DEFAULT_DAILY_CAP_MICROS;
  try {
    const n = BigInt(raw);
    if (n <= 0n) return DEFAULT_DAILY_CAP_MICROS;
    return n;
  } catch {
    return DEFAULT_DAILY_CAP_MICROS;
  }
}

function utcDateKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

function budgetKey(agentId: string, date: string): string {
  return `x402:budget:${agentId}:${date}`;
}

// ─── In-memory fallback (per-instance, only used when Redis unavailable) ──

const memBuckets = new Map<string, bigint>();

function memRead(key: string): bigint {
  return memBuckets.get(key) ?? 0n;
}
function memWrite(key: string, next: bigint): void {
  memBuckets.set(key, next);
}

// ─── Redis-backed accounting ──────────────────────────────────────────────

async function readSpend(key: string): Promise<bigint> {
  try {
    const { getCronState } = await import('@/lib/db/cron-state-redis');
    const v = await getCronState<string>(key);
    if (v == null) return memRead(key);
    return BigInt(v);
  } catch {
    return memRead(key);
  }
}

async function writeSpend(key: string, next: bigint): Promise<void> {
  try {
    const { setCronState } = await import('@/lib/db/cron-state-redis');
    // Store as string to keep bigint-precision (Redis JSON would lose it).
    await setCronState(key, next.toString());
  } catch (e) {
    logger.warn('[x402/budget] Redis write failed — falling back to in-memory', {
      key, error: e instanceof Error ? e.message : String(e),
    });
  }
  // Always write to memory as a hot cache — the next read within the
  // same instance skips the Redis round-trip and returns the same value.
  memWrite(key, next);
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * True if the agent can afford the requested spend today.
 * Does NOT reserve — call recordSpend() only after the paid call succeeded.
 */
export async function checkBudget(agentId: string, requestedMicros: string): Promise<boolean> {
  const cap = getDailyCapMicros();
  const key = budgetKey(agentId, utcDateKey());
  const spent = await readSpend(key);
  const requested = BigInt(requestedMicros);
  return spent + requested <= cap;
}

/**
 * Record a successful paid call. Idempotent-ish — reads current,
 * increments, writes back. Under high concurrency two instances might
 * both read the same starting balance and slightly over-spend within
 * one tick; that's acceptable for the "budget cap" guarantee we're
 * offering (a soft ceiling, not an atomic invariant). If we need
 * atomic, add a Redis INCR path.
 */
export async function recordSpend(agentId: string, spentMicros: string): Promise<void> {
  const key = budgetKey(agentId, utcDateKey());
  const current = await readSpend(key);
  const next = current + BigInt(spentMicros);
  await writeSpend(key, next);
}

/** Introspection helper — used by /api/health, admin dashboards, tests. */
export async function getRemainingBudget(agentId: string): Promise<{
  capMicros: string;
  spentMicros: string;
  remainingMicros: string;
  dateKey: string;
}> {
  const cap = getDailyCapMicros();
  const dateKey = utcDateKey();
  const spent = await readSpend(budgetKey(agentId, dateKey));
  const remaining = cap > spent ? cap - spent : 0n;
  return {
    capMicros: cap.toString(),
    spentMicros: spent.toString(),
    remainingMicros: remaining.toString(),
    dateKey,
  };
}

/** Test-only: force-set a spend value to exercise cap-boundary logic. */
export async function chargeSpendForTest(agentId: string, micros: string): Promise<void> {
  const key = budgetKey(agentId, utcDateKey());
  await writeSpend(key, BigInt(micros));
}

/** Test-only: wipe the in-memory + (attempted) Redis bucket for an agent. */
export async function _resetBudgetForTest(agentId: string): Promise<void> {
  const key = budgetKey(agentId, utcDateKey());
  memBuckets.delete(key);
  try {
    const { deleteCronState } = await import('@/lib/db/cron-state-redis');
    await deleteCronState(key);
  } catch {
    /* ok */
  }
}
