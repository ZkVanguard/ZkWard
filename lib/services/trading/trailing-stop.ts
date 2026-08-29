/**
 * Trailing-stop math for the polymarket-edge trader.
 *
 * Extracted from app/api/cron/polymarket-edge-trader/route.ts as a pure,
 * unit-testable module. The trader is designed to be "profit hungry":
 * winners must be allowed to compound, losers must be cut at a hard floor.
 *
 * Rule set (per tick, on the LIVE mark price vs entry, in signed bps):
 *   1. Initial stop-loss: exit at -STOP_LOSS_BPS. Hard floor.
 *   2. Once high-water >= TRAIL_ARM_BPS, arm the trailing stop by moving
 *      the effective stop from -STOP_LOSS_BPS to +TRAIL_LOCK_BPS.
 *   3. For every TRAIL_STEP_BPS the high-water climbs beyond TRAIL_ARM_BPS,
 *      raise the effective stop by TRAIL_LOCK_STEP_BPS.
 *   4. Exit whenever moveBps <= effective stop.
 *
 * Round-trip taker fees on BlueFin are ~10 bps, so TRAIL_LOCK_BPS = 10
 * guarantees at least breakeven-after-fees on any armed exit.
 *
 * ── Fee-bleed defer ────────────────────────────────────────────────────
 * If the max-hold expires with a modest favorable move (0..+FEE_BREAKEVEN),
 * closing at market realises a net loss even though the trade was
 * directionally correct. Defer the close by DEFER_EXTEND_MS so the next
 * tick either (a) sees the trade break out past FEE_BREAKEVEN_BPS
 * (real win), (b) sees the trailing stop fire (bounded loss/lock), or
 * (c) defers again up to MAX_DEFER_COUNT. Then close.
 */

export interface TrailingStopConfig {
  stopLossBps: number;
  trailArmBps: number;
  trailLockBps: number;
  trailStepBps: number;
  trailLockStepBps: number;
  feeBreakevenBps: number;
  maxDeferCount: number;
  deferExtendMs: number;
}

// trailLockBps raised 10 → 20 (2026-08-28) after historical outcome
// analysis showed avg observed win was $0.017 on $22 notional = 7.7 bps,
// which sits BELOW the 12 bps round-trip fee cost. Every "armed
// trailing-stop exit" was net-negative after fees. New floor of 20 bps
// guarantees +8 bps after fees on any armed exit (was -4 bps).
// trailArmBps raised 30 → 35 for symmetry — must climb enough to clear
// the new lock floor before the arm-lock reduces protection.
export const DEFAULT_TRAILING_STOP_CONFIG: TrailingStopConfig = {
  stopLossBps:      Number(process.env.POLYMARKET_EDGE_STOP_LOSS_BPS       || 20),
  trailArmBps:      Number(process.env.POLYMARKET_EDGE_TRAIL_ARM_BPS       || 35),
  trailLockBps:     Number(process.env.POLYMARKET_EDGE_TRAIL_LOCK_BPS      || 20),
  trailStepBps:     Number(process.env.POLYMARKET_EDGE_TRAIL_STEP_BPS      || 15),
  trailLockStepBps: Number(process.env.POLYMARKET_EDGE_TRAIL_LOCK_STEP_BPS || 10),
  feeBreakevenBps:  Number(process.env.POLYMARKET_EDGE_FEE_BREAKEVEN_BPS   || 12),
  maxDeferCount:    Number(process.env.POLYMARKET_EDGE_MAX_DEFER_COUNT     || 3),
  deferExtendMs:    5 * 60 * 1000,
};

/**
 * Compute the effective stop given the high-water mark. Pure function.
 * Signed bps: negative = stop below entry, positive = stop above entry.
 */
export function computeEffectiveStopBps(
  highWaterBps: number,
  cfg: TrailingStopConfig = DEFAULT_TRAILING_STOP_CONFIG,
): number {
  const floor = -cfg.stopLossBps;
  if (highWaterBps < cfg.trailArmBps) return floor;
  const stepsAbove = Math.floor((highWaterBps - cfg.trailArmBps) / cfg.trailStepBps);
  return cfg.trailLockBps + stepsAbove * cfg.trailLockStepBps;
}

/**
 * Should we defer a max-hold close because closing now would eat into
 * a small favorable move via fees?
 */
export function shouldDeferMaxHold(
  moveBps: number,
  deferCount: number,
  cfg: TrailingStopConfig = DEFAULT_TRAILING_STOP_CONFIG,
): boolean {
  return moveBps < cfg.feeBreakevenBps && deferCount < cfg.maxDeferCount;
}

/**
 * Convert a directional move on entry vs mark into bps.
 * dir = +1 for LONG (up = win), -1 for SHORT (down = win).
 */
export function computeMoveBps(
  entryPrice: number,
  markPrice: number,
  side: 'LONG' | 'SHORT',
): number {
  const dir = side === 'LONG' ? 1 : -1;
  return ((markPrice - entryPrice) / entryPrice) * dir * 10_000;
}
