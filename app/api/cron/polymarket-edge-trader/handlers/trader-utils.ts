/**
 * Small pure helpers shared across the polymarket-edge-trader handlers.
 *
 * Extracted from route.ts on 2026-08-10. Nothing side-effectful except
 * recordSkip (which writes cron_state for operator diagnostics).
 */
import { setCronState, getCronStateOr } from '@/lib/db/cron-state';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import type { BluefinPosition } from '@/lib/services/sui/BluefinService';
import type { AggregatedPrediction } from '@/lib/services/market-data/PredictionAggregatorService';
import {
  KEY_LAST_SKIP,
  KEY_STARVATION_STREAK,
  KEY_STARVATION_ALERT_FLAG,
  STARVATION_STREAK_THRESHOLD,
  STARVATION_ALERT_TTL_MS,
  TRADER_AUTO_TOPUP_ENABLED,
  TRADER_AUTO_TOPUP_MIN_MARGIN,
  TRADER_AUTO_TOPUP_TARGET_MARGIN,
} from './config';

export function quantize(qty: number, step: number): number {
  return Math.floor(qty / step) * step;
}

export function findActivePosition(
  positions: BluefinPosition[],
  symbol: string,
): BluefinPosition | undefined {
  return positions.find((p) => p.symbol === symbol && Number(p.size) > 0);
}

/** Map an aggregator recommendation to a hedge side. WAIT → null. */
export function recommendationToSide(
  rec: AggregatedPrediction['recommendation'],
): 'LONG' | 'SHORT' | null {
  if (rec.includes('SHORT')) return 'SHORT';
  if (rec.includes('LONG')) return 'LONG';
  return null;
}

export function isActionable(rec: AggregatedPrediction['recommendation']): boolean {
  return rec.startsWith('HEDGE_') || rec.startsWith('STRONG_');
}

export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Records why the current tick did not open a trade. Gives operators a
 * single lookup ("why is the trader idle?") without grepping serverless
 * logs across many invocations. Non-critical — never fails the tick.
 */
export async function recordSkip(action: string, reason: string): Promise<void> {
  try {
    await setCronState(KEY_LAST_SKIP, {
      at: Date.now(),
      action,
      reason,
    });
  } catch {
    /* non-critical — don't fail the tick because we couldn't record a diagnostic */
  }
}

/**
 * Track consecutive `no-collateral` skips and fire ONE actionable KILL
 * alert per 24h once the streak crosses STARVATION_STREAK_THRESHOLD
 * (~1 hour at the 5-min cron cadence). Solves the specific silent-
 * dormancy failure observed 2026-08-16 to 2026-08-28: trader skipped
 * 3411 consecutive ticks (~11 days) with `free=$0.00 < $7.50` while
 * signals showed SOL/XRP/DOGE longs at 72-87% confidence — no alert,
 * no operator visibility, no trades executed.
 *
 * Root cause of starvation is a Catch-22: BlueFin free collateral is
 * $0 because existing hedge positions lock all margin. The operator
 * needs to either (a) top up free collateral or (b) close a hedge to
 * unlock margin. The alert names both remediations so the fix is
 * obvious the moment it fires.
 *
 * Reset behaviour: any non-'no-collateral' skip (or a successful
 * trade) resets the streak — matches "starvation ended" semantics.
 * Alert flag uses same TTL pattern as stale-dust-flag so refactor
 * doesn't accidentally revert to permanent suppression.
 */
export async function trackStarvation(
  action: string,
  freeCollateralUsd: number,
): Promise<void> {
  try {
    if (action !== 'no-collateral') {
      // Streak broken — clear it. Don't touch the alert flag; it TTLs
      // on its own so a brief starvation window doesn't re-fire the
      // KILL alert twice within a day.
      await setCronState(KEY_STARVATION_STREAK, 0);
      return;
    }
    const streak = Number(await getCronStateOr<number>(KEY_STARVATION_STREAK, 0)) + 1;
    await setCronState(KEY_STARVATION_STREAK, streak);
    if (streak < STARVATION_STREAK_THRESHOLD) return;

    // Check TTL-bounded alert flag.
    const flaggedAt = Number(await getCronStateOr<number>(KEY_STARVATION_ALERT_FLAG, 0));
    if (flaggedAt > 0 && Date.now() - flaggedAt < STARVATION_ALERT_TTL_MS) return;

    await setCronState(KEY_STARVATION_ALERT_FLAG, Date.now());
    const hoursDormant = Math.round((streak * 5) / 60);

    // ── AUTO-REMEDIATION (env-gated) ──────────────────────────────────
    // Attempt to break the Catch-22 by moving admin spot USDC into the
    // BlueFin margin bank (swapping SUI → USDC first if spot is dry).
    // Uses the existing bluefinTreasury.autoTopUp which is bounded by
    // its own maxSwapSui + targetMargin caps. If it succeeds, the next
    // trader tick will see free ≥ min and open a real position; if it
    // fails, we still fire the Discord alert so the operator knows.
    let topUpResult: unknown = null;
    if (TRADER_AUTO_TOPUP_ENABLED) {
      try {
        const { bluefinTreasury } = await import('@/lib/services/sui/BluefinTreasuryService');
        topUpResult = await bluefinTreasury.autoTopUp({
          minMargin: TRADER_AUTO_TOPUP_MIN_MARGIN,
          targetMargin: TRADER_AUTO_TOPUP_TARGET_MARGIN,
          spotReserve: 1,
          swapFromSui: true,
        });
      } catch (e) {
        topUpResult = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    const topUpNote = TRADER_AUTO_TOPUP_ENABLED
      ? `\n🤖 Auto-topup attempted: ${JSON.stringify(topUpResult).slice(0, 200)}`
      : '\n💡 Enable TRADER_AUTO_TOPUP_ENABLED=1 to have this fixed autonomously (moves admin spot USDC → BlueFin margin bank, no external deposits needed).';

    await notifyDiscord(
      `🔴 Trader STARVED for ${hoursDormant}h+ (${streak} consecutive ticks, free=$${freeCollateralUsd.toFixed(2)}). ` +
      `Missing every signal opportunity. Unstick via ONE of:\n` +
      `  1. Fund BlueFin free collateral (deposit USDC to admin BlueFin account)\n` +
      `  2. Close an existing hedge to unlock its margin — check /api/admin/bluefin-debug for positions\n` +
      `Signals worth acting on: check agent-directives:by-asset in cron_state.` +
      topUpNote +
      `\nAlert suppressed 24h.`,
      'KILL',
      { streakTicks: streak, hoursDormant, freeCollateralUsd, topUpResult },
    ).catch(() => {
      /* Discord webhook failures shouldn't fail the tick — alert is
         diagnostic, not a control-plane action. */
    });
  } catch {
    /* All starvation tracking is non-critical — swallow errors */
  }
}
