/**
 * Contract lock for BluefinHedgeResult failure constructors.
 *
 * The `code` field is the machine-readable branch key that callers use
 * (sui-hedge-reconcile checks `result.code === 'DUST_LOCKED'` before
 * suppressing retries). If a code drifts, dust-flag suppression breaks.
 * These 4 cases anchor the exact shape each constructor produces.
 */
import { describe, it, expect } from '@jest/globals';
import {
  dustLocked,
  dustRisk,
  belowMinQty,
  belowMinQtySnapped,
  silentReject,
} from '@/lib/services/sui/bluefin/hedge-result';

describe('BluefinHedgeResult constructors', () => {
  it('dustLocked — populates code, dust, preCloseSize (the sui-hedge-reconcile contract)', () => {
    const r = dustLocked('h1', 'ETH-PERP', 0.009277, 0.01, {
      positionSize: 0.009277, minQty: 0.01, stepSize: 0.01, stepMultiples: 0.9277,
    });
    expect(r.success).toBe(false);
    expect(r.code).toBe('DUST_LOCKED');
    expect(r.hedgeId).toBe('h1');
    expect(r.preCloseSize).toBe(0.009277);
    expect(r.dust?.minQty).toBe(0.01);
    expect(r.error).toContain('dust-locked at venue level');
  });

  it('dustRisk — bypass hint appears in the error message', () => {
    const r = dustRisk('h1', 'ETH-PERP', 0.011, 0.01, 0.01);
    expect(r.code).toBe('DUST_RISK');
    expect(r.error).toContain('BLUEFIN_ALLOW_DUST_RISK_OPEN=1');
    expect(r.dust?.stepMultiples).toBeCloseTo(1.1);
  });

  it('belowMinQty — no dust field, just size + minQty', () => {
    const r = belowMinQty('h1', 'BTC-PERP', 0.0005, 0.001);
    expect(r.code).toBe('BELOW_MIN_QTY');
    expect(r.dust).toBeUndefined();
    expect(r.error).toContain('0.0005');
    expect(r.error).toContain('0.001');
  });

  it('belowMinQtySnapped — mentions both pre and post-snap sizes', () => {
    const r = belowMinQtySnapped('h1', 'ETH-PERP', 0.014, 0.01, 0.02);
    expect(r.code).toBe('BELOW_MIN_QTY_SNAPPED');
    expect(r.error).toContain('0.014');
    expect(r.error).toContain('0.01');
    expect(r.error).toContain('0.02');
  });

  it('silentReject — code + preCloseSize + postCloseSize + rawResponse (TTL-suppress contract)', () => {
    // sui-hedge-reconcile branches on code === 'SILENT_REJECT' to set
    // the shared stale-dust-flag with a 24h TTL. If this code drifts,
    // the loop falls through to the generic-WARN branch and floods
    // Discord hourly (exact prod bug on hedge #190).
    const raw = { orderHash: 'abcdef1234567890', filledQty: '0' };
    const r = silentReject('h1', 'ETH-PERP', 'abcdef1234567890', 0.012457, 0.012451, raw);
    expect(r.success).toBe(false);
    expect(r.code).toBe('SILENT_REJECT');
    expect(r.hedgeId).toBe('h1');
    expect(r.orderId).toBe('abcdef1234567890');
    expect(r.preCloseSize).toBe(0.012457);
    expect(r.postCloseSize).toBe(0.012451);
    expect(r.error).toContain('did not shrink');
    expect(r.error).toContain('preSize=0.012457');
    expect(r.error).toContain('postSize=0.012451');
    expect(r.error).toContain('free-collateral shortfall');
    expect(r.rawResponse).toBe(raw);
  });

  it('every failure result carries a timestamp', () => {
    const raw = { orderHash: 'x' };
    for (const r of [
      dustLocked('h', 'ETH-PERP', 0.009, 0.01, { positionSize: 0.009, minQty: 0.01, stepSize: 0.01, stepMultiples: 0.9 }),
      dustRisk('h', 'ETH-PERP', 0.011, 0.01, 0.01),
      belowMinQty('h', 'BTC-PERP', 0.0005, 0.001),
      belowMinQtySnapped('h', 'ETH-PERP', 0.014, 0.01, 0.02),
      silentReject('h', 'ETH-PERP', 'x', 0.01, 0.0099, raw),
    ]) {
      expect(r.timestamp).toBeGreaterThan(0);
      expect(r.success).toBe(false);
    }
  });
});
