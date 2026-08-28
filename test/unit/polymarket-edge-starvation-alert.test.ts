/**
 * Contract lock for trackStarvation — the trader's silent-dormancy alarm.
 *
 * Regression risk: prior code path skipped with 'no-collateral' silently
 * for 3411 consecutive ticks (~11 days) while signals showed multiple
 * strong opportunities. If a refactor drops the TTL-suppressed KILL
 * alert, the same failure recurs invisibly.
 *
 * Tests use an in-memory cron_state mock so we can drive many ticks
 * quickly without touching Postgres. The alert fires exactly once
 * across the streak (idempotent within TTL) and re-arms after the flag
 * has TTL'd.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// In-memory cron_state fake — must be declared before jest.mock so the
// factory can close over it.
const state = new Map<string, unknown>();
const discordCalls: Array<{ msg: string; level: string; ctx: unknown }> = [];

jest.mock('@/lib/db/cron-state', () => ({
  setCronState: async (k: string, v: unknown) => { state.set(k, v); },
  getCronStateOr: async <T,>(k: string, fallback: T): Promise<T> =>
    (state.has(k) ? (state.get(k) as T) : fallback),
  CronKeys: { polymarketEdgeHaltedUntil: 'polymarket-edge:halted-until' },
}));

jest.mock('@/lib/utils/discord-notify', () => ({
  notifyDiscord: async (msg: string, level: string, ctx: unknown) => {
    discordCalls.push({ msg, level, ctx });
  },
}));

// Import AFTER mocks so the module resolves against the fakes.
import { trackStarvation } from '@/app/api/cron/polymarket-edge-trader/handlers/trader-utils';
import {
  KEY_STARVATION_STREAK,
  KEY_STARVATION_ALERT_FLAG,
  STARVATION_STREAK_THRESHOLD,
  STARVATION_ALERT_TTL_MS,
} from '@/app/api/cron/polymarket-edge-trader/handlers/config';

describe('trackStarvation — trader silent-dormancy alarm', () => {
  beforeEach(() => {
    state.clear();
    discordCalls.length = 0;
  });

  it('does not fire before the streak threshold', async () => {
    for (let i = 0; i < STARVATION_STREAK_THRESHOLD - 1; i++) {
      await trackStarvation('no-collateral', 0);
    }
    expect(state.get(KEY_STARVATION_STREAK)).toBe(STARVATION_STREAK_THRESHOLD - 1);
    expect(discordCalls).toHaveLength(0);
  });

  it('fires ONE KILL alert exactly when streak crosses threshold', async () => {
    for (let i = 0; i < STARVATION_STREAK_THRESHOLD; i++) {
      await trackStarvation('no-collateral', 0);
    }
    expect(discordCalls).toHaveLength(1);
    expect(discordCalls[0].level).toBe('KILL');
    expect(discordCalls[0].msg).toMatch(/STARVED/);
    expect(discordCalls[0].msg).toMatch(/Fund BlueFin/);
    expect(discordCalls[0].msg).toMatch(/Close an existing hedge/);
  });

  it('suppresses subsequent alerts within TTL (never spams Discord)', async () => {
    for (let i = 0; i < STARVATION_STREAK_THRESHOLD; i++) {
      await trackStarvation('no-collateral', 0);
    }
    expect(discordCalls).toHaveLength(1);
    // Continue starving for another 200 ticks — no additional alerts.
    for (let i = 0; i < 200; i++) {
      await trackStarvation('no-collateral', 0);
    }
    expect(discordCalls).toHaveLength(1);
  });

  it('re-arms after alert flag TTLs (retries daily on persistent starvation)', async () => {
    for (let i = 0; i < STARVATION_STREAK_THRESHOLD; i++) {
      await trackStarvation('no-collateral', 0);
    }
    expect(discordCalls).toHaveLength(1);
    // Rewind the flag 25h into the past — past 24h TTL.
    state.set(KEY_STARVATION_ALERT_FLAG, Date.now() - STARVATION_ALERT_TTL_MS - 60_000);
    await trackStarvation('no-collateral', 0);
    expect(discordCalls).toHaveLength(2);
  });

  it('resets streak on any non-starvation action', async () => {
    for (let i = 0; i < STARVATION_STREAK_THRESHOLD - 1; i++) {
      await trackStarvation('no-collateral', 0);
    }
    expect(state.get(KEY_STARVATION_STREAK)).toBe(STARVATION_STREAK_THRESHOLD - 1);
    await trackStarvation('proceed', 15);
    expect(state.get(KEY_STARVATION_STREAK)).toBe(0);
  });

  it('KILL message includes the actual free-collateral value for diagnosis', async () => {
    for (let i = 0; i < STARVATION_STREAK_THRESHOLD - 1; i++) {
      await trackStarvation('no-collateral', 0.04);
    }
    await trackStarvation('no-collateral', 0.04);
    expect(discordCalls[0].msg).toMatch(/free=\$0\.04/);
  });
});
