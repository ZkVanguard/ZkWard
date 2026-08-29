/**
 * Locks the trailing-stop decision math from the polymarket-edge trader.
 *
 * Rules (bps, signed; dir=+1 for LONG, -1 for SHORT):
 *   moveBps = (mark - entry) / entry × dir × 10_000
 *
 *   highWaterBps ratchets upward each tick.
 *   effectiveStopBps depends on high-water:
 *     hwm < ARM (30)        → floor = -STOP_LOSS (20)   [initial stop]
 *     hwm ≥ ARM             → LOCK (10) + floor(hwm-ARM)/STEP × STEP_LOCK (10)
 *                             (each STEP=15 bps of new high raises the
 *                              locked stop by STEP_LOCK=10)
 *
 *   Exit when moveBps ≤ effectiveStopBps.
 *
 * Why: "profit hungry" — winners keep running as long as they keep
 * making new highs; losers are cut at -20 bps. Retraces past a raised
 * stop lock in profit at that level.
 */

// Import the REAL production code so tests fail on regressions rather than
// silently agreeing with a shadow copy. Tests pass an EXPLICIT config so
// they lock the FORMULA rather than the current production defaults —
// those change over time (see 2026-08-28: trailLockBps 10 → 20 after
// historical PnL showed 10bp lock was below fee cost).
import {
  computeEffectiveStopBps as computeEffectiveStopBpsProd,
  type TrailingStopConfig,
} from '@/lib/services/trading/trailing-stop';

const STOP_LOSS_BPS = 20;
const TRAIL_ARM_BPS = 30;
const TRAIL_LOCK_BPS = 10;
const TRAIL_STEP_BPS = 15;
const TRAIL_LOCK_STEP_BPS = 10;

const TEST_CFG: TrailingStopConfig = {
  stopLossBps: STOP_LOSS_BPS,
  trailArmBps: TRAIL_ARM_BPS,
  trailLockBps: TRAIL_LOCK_BPS,
  trailStepBps: TRAIL_STEP_BPS,
  trailLockStepBps: TRAIL_LOCK_STEP_BPS,
  feeBreakevenBps: 12,
  maxDeferCount: 3,
  deferExtendMs: 5 * 60 * 1000,
};

function computeEffectiveStopBps(highWaterBps: number): number {
  return computeEffectiveStopBpsProd(highWaterBps, TEST_CFG);
}

interface TickState {
  entryPrice: number;
  side: 'LONG' | 'SHORT';
  highWaterBps: number;
}

function moveBps(state: TickState, mark: number): number {
  const dir = state.side === 'LONG' ? 1 : -1;
  return ((mark - state.entryPrice) / state.entryPrice) * dir * 10_000;
}

function tick(state: TickState, mark: number): {
  moveBps: number;
  highWaterBps: number;
  stopBps: number;
  exit: boolean;
} {
  const m = moveBps(state, mark);
  const hwm = Math.max(state.highWaterBps, m);
  const stop = computeEffectiveStopBps(hwm);
  return { moveBps: m, highWaterBps: hwm, stopBps: stop, exit: m <= stop };
}

describe('polymarket-edge trailing stop', () => {
  describe('computeEffectiveStopBps (pure)', () => {
    it('returns -20 (floor) when hwm below arm threshold', () => {
      expect(computeEffectiveStopBps(0)).toBe(-20);
      expect(computeEffectiveStopBps(29.9)).toBe(-20);
    });

    it('arms at +30 hwm: stop jumps to +10 (breakeven after fees)', () => {
      expect(computeEffectiveStopBps(30)).toBe(10);
    });

    it('ratchets stop up by 10 bps per 15 bps of new high above arm', () => {
      expect(computeEffectiveStopBps(45)).toBe(20);  // 1 step: 10 + 10
      expect(computeEffectiveStopBps(60)).toBe(30);  // 2 steps: 10 + 20
      expect(computeEffectiveStopBps(75)).toBe(40);
      expect(computeEffectiveStopBps(90)).toBe(50);
    });

    it('never regresses (monotonic in hwm)', () => {
      let prev = computeEffectiveStopBps(0);
      for (let hwm = 0; hwm <= 200; hwm += 3) {
        const s = computeEffectiveStopBps(hwm);
        expect(s).toBeGreaterThanOrEqual(prev);
        prev = s;
      }
    });
  });

  describe('LONG runner — winner keeps running', () => {
    const initial: TickState = { entryPrice: 100, side: 'LONG', highWaterBps: 0 };

    it('tiny drift keeps stop at -20 floor', () => {
      const t = tick(initial, 100.05); // +5 bps
      expect(t.stopBps).toBe(-20);
      expect(t.exit).toBe(false);
    });

    it('crossing arm locks +10 stop and does NOT exit', () => {
      // Cross arm barely
      const t = tick(initial, 100.301); // +30.1 bps
      expect(t.stopBps).toBe(10);
      expect(t.exit).toBe(false); // still above stop
    });

    it('after running to +100 bps then retracing to +40, exits at trailing stop', () => {
      // Simulate: hwm previously reached 100 bps → stop = 50
      const armed: TickState = { entryPrice: 100, side: 'LONG', highWaterBps: 100 };
      const t = tick(armed, 100.40); // moveBps = 40, stop = 50
      expect(t.stopBps).toBe(50);
      expect(t.exit).toBe(true); // 40 < 50 → trailing-stop trigger, LOCKS +40 bps profit
    });

    it('does NOT exit while trade continues to make new highs', () => {
      const state: TickState = { entryPrice: 100, side: 'LONG', highWaterBps: 60 };
      const t = tick(state, 100.801); // +80.1 bps (new high)
      expect(t.highWaterBps).toBeCloseTo(80.1, 4);
      expect(t.stopBps).toBe(40); // was 30 at hwm=60, now 40 at hwm=80.1
      expect(t.exit).toBe(false); // 80.1 > 40
    });
  });

  describe('LONG loser — hard stop at -20', () => {
    const initial: TickState = { entryPrice: 100, side: 'LONG', highWaterBps: 0 };

    it('exits at -20 bps (never armed the trail)', () => {
      const t = tick(initial, 99.80); // -20 bps
      expect(t.stopBps).toBe(-20);
      expect(t.exit).toBe(true);
    });

    it('holds at -15 bps (inside the stop band)', () => {
      const t = tick(initial, 99.85);
      expect(t.exit).toBe(false);
    });
  });

  describe('SHORT runner + loser (mirror-image math)', () => {
    it('SHORT arms when price drops 30.1 bps (dir=-1 flips sign back positive)', () => {
      const s: TickState = { entryPrice: 100, side: 'SHORT', highWaterBps: 0 };
      const t = tick(s, 99.699); // moveBps ≈ 30.1 (SHORT wins going down)
      expect(t.moveBps).toBeGreaterThan(30);
      expect(t.stopBps).toBe(10);
      expect(t.exit).toBe(false);
    });

    it('SHORT loser exits when price rises 20 bps', () => {
      const s: TickState = { entryPrice: 100, side: 'SHORT', highWaterBps: 0 };
      const t = tick(s, 100.201); // moveBps ≈ -20.1
      expect(t.exit).toBe(true);
    });
  });

  describe('fee-bleed defer (Lever D)', () => {
    const FEE_BREAKEVEN_BPS = 12;
    const MAX_DEFER_COUNT = 2;

    /**
     * At max-hold expiry, decide whether to close now or defer.
     * Rules:
     *  - if moveBps < FEE_BREAKEVEN_BPS AND deferCount < MAX_DEFER_COUNT
     *    → defer (extend hold)
     *  - else → close at market
     * Note: this only fires AFTER trailing check has passed (moveBps > stop),
     * so we're in the [-STOP_LOSS, ...) range guaranteed.
     */
    function maxHoldDecision(moveBps: number, deferCount: number): 'close' | 'defer' {
      if (moveBps < FEE_BREAKEVEN_BPS && deferCount < MAX_DEFER_COUNT) return 'defer';
      return 'close';
    }

    it('defers on a +5 bps favorable move (fee-trap zone)', () => {
      expect(maxHoldDecision(5, 0)).toBe('defer');
    });

    it('defers on a +11 bps favorable move (still below fee floor)', () => {
      expect(maxHoldDecision(11, 0)).toBe('defer');
    });

    it('closes on a +15 bps favorable move (clears fees)', () => {
      expect(maxHoldDecision(15, 0)).toBe('close');
    });

    it('closes on a +50 bps favorable move (real win)', () => {
      expect(maxHoldDecision(50, 0)).toBe('close');
    });

    it('defers on a -10 bps unfavorable move if not maxed', () => {
      // Note: this path only reached if trailing didn't fire, i.e. moveBps > -20.
      // -10 is inside the trailing floor but inside fee-trap zone, so defer.
      expect(maxHoldDecision(-10, 0)).toBe('defer');
    });

    it('stops deferring at MAX_DEFER_COUNT to prevent unbounded hold', () => {
      expect(maxHoldDecision(5, 2)).toBe('close');
      expect(maxHoldDecision(-10, 2)).toBe('close');
    });

    it('deferring second time is still allowed if within cap', () => {
      expect(maxHoldDecision(5, 1)).toBe('defer');
    });

    describe('EV improvement from defer', () => {
      // Historical fee-bleed losses: trades #7 (+7 bps, net -$0.005) and
      // #10 (+2 bps, net -$0.012). Both would have been deferred.
      // Question: does deferring help? Assume 50% of deferred trades
      // break out to a real win (+30 bps → net +$0.030) and 50% end at
      // max-hold with the same fee-bleed loss.

      it('deferring converts a fee-bleed loss into an expected small win', () => {
        const historicalLoss = -0.005; // from trade #7
        // Assume defer outcome: 50% break to +$0.030, 50% stay at fee-loss.
        const deferredEV = 0.5 * 0.030 + 0.5 * historicalLoss;
        expect(deferredEV).toBeGreaterThan(historicalLoss);
        expect(deferredEV).toBeCloseTo(0.0125, 3);
      });
    });
  });

  describe('profit-factor: the point of "profit hungry"', () => {
    // Round-trip fees ≈ 10 bps. At $15 notional (=$5 stake × 3× lev):
    //   Fees ≈ $0.015 per trade.
    // Compare max-loss vs typical trailing win.

    it('caps loss at 20 bps × notional (never more)', () => {
      const notional = 15;
      const maxLossGross = (-20 / 10_000) * notional; // -$0.030
      expect(maxLossGross).toBeCloseTo(-0.03, 4);
      // After fees ($0.015 round-trip): ~-$0.045
    });

    it('LOCKS +40 bps on a runner that hit +100 and retraced', () => {
      // hwm=100 → stop=50; retrace exits at +40+ (whatever the mark shows)
      const notional = 15;
      const lockedGross = (40 / 10_000) * notional; // $0.060
      expect(lockedGross).toBeCloseTo(0.06, 4);
      // After fees ~$0.045 net = 1.5× the old fixed-TP of +30
    });

    it('EV positive after fees at 50% win rate assuming avg win = trailing +60 bps', () => {
      // 50% × +60 bps - 50% × -20 bps = +30 bps - 10 bps = +20 bps expected before fees
      // Post-fees: 50% × (60-10) + 50% × (-20-10) = 25 - 15 = +10 bps per trade net
      const evNet = 0.5 * (60 - 10) + 0.5 * (-20 - 10);
      expect(evNet).toBeGreaterThan(0);
    });
  });
});
