/**
 * Contract lock for the SKIP_STRONG_SIGNALS gate.
 *
 * Historical outcome data (2026-08-28, 22 real trades):
 *   HEDGE_LONG (moderate):    3 trades, 100% win, +$0.07 PnL
 *   STRONG_HEDGE_LONG:       16 trades,  13% win, -$0.34 PnL
 *
 * Inverse-strength phenomenon: "STRONG" signals fade in this market.
 * Gate is default ON — if a refactor drops the check, this test fails
 * and the trader immediately starts losing money on strong signals
 * again.
 */
import { describe, it, expect } from '@jest/globals';
import { isActionable } from '@/app/api/cron/polymarket-edge-trader/handlers/trader-utils';

describe('isActionable — SKIP_STRONG_SIGNALS gate (default ON)', () => {
  it('accepts moderate HEDGE_LONG / HEDGE_SHORT signals', () => {
    expect(isActionable('HEDGE_LONG')).toBe(true);
    expect(isActionable('HEDGE_SHORT')).toBe(true);
  });

  it('SKIPS STRONG_HEDGE_LONG / STRONG_HEDGE_SHORT by default', () => {
    // Default POLYMARKET_EDGE_SKIP_STRONG_SIGNALS=on (envFlagOnByDefault)
    expect(isActionable('STRONG_HEDGE_LONG')).toBe(false);
    expect(isActionable('STRONG_HEDGE_SHORT')).toBe(false);
  });

  it('rejects LIGHT_HEDGE_* (never actionable regardless of gate)', () => {
    expect(isActionable('LIGHT_HEDGE_LONG')).toBe(false);
    expect(isActionable('LIGHT_HEDGE_SHORT')).toBe(false);
  });

  it('rejects WAIT / any non-HEDGE recommendation', () => {
    expect(isActionable('WAIT')).toBe(false);
    expect(isActionable('' as never)).toBe(false);
  });
});
