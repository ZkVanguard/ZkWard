/**
 * Contract lock for the probability calibrator.
 *
 * Regression risk: this module is what makes the EV gate see truthful
 * probabilities. If someone refactors the shrinkage formula or the
 * bucketing, the trader silently starts taking bad trades again.
 * These cases anchor:
 *   - bucket boundaries
 *   - no-history fallback (returns raw)
 *   - full shrinkage with lots of history
 *   - Bayesian mix at intermediate n
 *   - record → calibrate round-trip
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// In-memory cron_state fake before jest.mock.
const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  setCronState: async (k: string, v: unknown) => { state.set(k, v); },
  getCronStateOr: async <T,>(k: string, fallback: T): Promise<T> =>
    (state.has(k) ? (state.get(k) as T) : fallback),
}));

import { recordOutcome, calibrate, _bucketFor, _PRIOR_STRENGTH } from '@/lib/services/ai/probability-calibrator';

describe('probability calibrator', () => {
  beforeEach(() => { state.clear(); });

  describe('bucket boundaries', () => {
    it('buckets by decile', () => {
      expect(_bucketFor(0)).toBe(0);
      expect(_bucketFor(9.9)).toBe(0);
      expect(_bucketFor(10)).toBe(1);
      expect(_bucketFor(55)).toBe(5);
      expect(_bucketFor(74)).toBe(7);
      expect(_bucketFor(100)).toBe(9);
    });

    it('clamps out-of-range to 0..9', () => {
      expect(_bucketFor(-5)).toBe(0);
      expect(_bucketFor(999)).toBe(9);
    });
  });

  describe('calibrate — no history', () => {
    it('returns raw confidence when bucket is empty', async () => {
      const r = await calibrate({ asset: 'SOL', side: 'LONG', rawConfidencePct: 74 });
      expect(r.pCalibrated).toBeCloseTo(0.74);
      expect(r.pRaw).toBeCloseTo(0.74);
      expect(r.nHistory).toBe(0);
      expect(r.empiricalWinRate).toBe(null);
    });
  });

  describe('calibrate — Bayesian shrinkage', () => {
    it('shrinks toward empirical rate as n grows', async () => {
      // Seed 4 losses in the 70-80 bucket for SOL LONG.
      for (let i = 0; i < 4; i++) {
        await recordOutcome({ asset: 'SOL', side: 'LONG', openConfidencePct: 74, realizedPnl: -0.05 });
      }
      const r = await calibrate({ asset: 'SOL', side: 'LONG', rawConfidencePct: 74 });
      // Empirical: 0/4 = 0. Raw: 0.74. Prior: 10.
      // Expected: (4*0 + 10*0.74) / (4+10) = 7.4/14 = 0.5286
      expect(r.pCalibrated).toBeCloseTo((4 * 0 + _PRIOR_STRENGTH * 0.74) / (4 + _PRIOR_STRENGTH), 3);
      expect(r.nHistory).toBe(4);
      expect(r.empiricalWinRate).toBe(0);
    });

    it('converges to empirical rate with many samples', async () => {
      // 50 losses in 70-80 bucket, prior=10 gets swamped.
      for (let i = 0; i < 50; i++) {
        await recordOutcome({ asset: 'SOL', side: 'LONG', openConfidencePct: 74, realizedPnl: -0.05 });
      }
      const r = await calibrate({ asset: 'SOL', side: 'LONG', rawConfidencePct: 74 });
      // (50*0 + 10*0.74) / 60 = 0.1233 — very close to empirical 0
      expect(r.pCalibrated).toBeLessThan(0.15);
      expect(r.pCalibrated).toBeGreaterThan(0.10);
    });

    it('directly reproduces the 2026-08-28 SOL 70-80 bucket', async () => {
      // Historical: 17 trades, 2 wins → 12% actual win rate
      for (let i = 0; i < 2; i++) {
        await recordOutcome({ asset: 'SOL', side: 'LONG', openConfidencePct: 74, realizedPnl: +0.02 });
      }
      for (let i = 0; i < 15; i++) {
        await recordOutcome({ asset: 'SOL', side: 'LONG', openConfidencePct: 74, realizedPnl: -0.05 });
      }
      const r = await calibrate({ asset: 'SOL', side: 'LONG', rawConfidencePct: 74 });
      // Empirical: 2/17 ≈ 0.118. Raw: 0.74. Prior: 10.
      // Expected: (17*0.118 + 10*0.74) / 27 ≈ (2 + 7.4) / 27 ≈ 0.348
      expect(r.pCalibrated).toBeCloseTo(0.348, 2);
      // The gate that uses this: prior said 74% win, calibrator says 35% —
      // trades that would have passed EV gate at raw prob now fail it.
      // This is the fix that closes the biggest leak.
    });
  });

  describe('scoping', () => {
    it('does NOT bleed history across asset/side/bucket boundaries', async () => {
      // Poison SOL/LONG/74 with 20 losses
      for (let i = 0; i < 20; i++) {
        await recordOutcome({ asset: 'SOL', side: 'LONG', openConfidencePct: 74, realizedPnl: -0.05 });
      }
      // Different asset — should still return raw (no history)
      const r1 = await calibrate({ asset: 'BTC', side: 'LONG', rawConfidencePct: 74 });
      expect(r1.nHistory).toBe(0);
      expect(r1.pCalibrated).toBeCloseTo(0.74);
      // Different side — same
      const r2 = await calibrate({ asset: 'SOL', side: 'SHORT', rawConfidencePct: 74 });
      expect(r2.nHistory).toBe(0);
      // Different confidence bucket — same
      const r3 = await calibrate({ asset: 'SOL', side: 'LONG', rawConfidencePct: 65 });
      expect(r3.nHistory).toBe(0);
    });
  });
});
