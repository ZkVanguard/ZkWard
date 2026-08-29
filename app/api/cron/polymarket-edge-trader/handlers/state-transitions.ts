/**
 * Stateful helpers — every function here mutates cron_state and/or fires
 * Discord alerts. Extracted from route.ts on 2026-08-10.
 */
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { setCronState } from '@/lib/db/cron-state';
import { BluefinService } from '@/lib/services/sui/BluefinService';
import { evaluateKillSwitch } from '@/lib/services/trading/kill-switches';
import { recordOutcome as recordCalibrationOutcome } from '@/lib/services/ai/probability-calibrator';
import type { ActiveTrade } from '@/lib/services/trading/active-trade';
import type { SupportedAsset } from '@/lib/config/trader-assets';
import { utcDayKey } from './trader-utils';
import type { EdgeStats, DailyStats } from './types';
import {
  KEY_STATS,
  KEY_DAILY,
  KEY_HALTED_UNTIL,
  KEY_ACTIVE,
  MAX_CONSECUTIVE_LOSSES,
  MAX_DRAWDOWN_PCT,
  DAILY_LOSS_CAP_USD,
  BASE_STAKE_USD,
  HALT_DURATION_MS,
} from './config';

export async function closeWithRetry(bf: BluefinService, symbol: string) {
  const attempt = () =>
    bf.closeHedge({ symbol }).catch((e) => ({
      success: false,
      executionPrice: 0,
      fees: 0,
      error: errMsg(e),
    }));
  const first = await attempt();
  if (first && (first as { success?: boolean }).success) return first;
  // Brief backoff then retry once.
  await new Promise((r) => setTimeout(r, 1500));
  return attempt();
}

export function pickExitPrice(close: unknown, markPriceRaw: unknown, fallback: number): number {
  const exec = Number((close as { executionPrice?: number })?.executionPrice);
  if (Number.isFinite(exec) && exec > 0) return exec;
  const mark = Number(markPriceRaw);
  if (Number.isFinite(mark) && mark > 0) return mark;
  return fallback;
}

export async function applyOutcome(
  prev: EdgeStats,
  realizedUsd: number,
  asset: SupportedAsset,
): Promise<EdgeStats> {
  const perAsset = { ...(prev.perAsset || {}) };
  const cur = perAsset[asset] || { trades: 0, wins: 0, pnlUsd: 0 };
  perAsset[asset] = {
    trades: cur.trades + 1,
    wins: cur.wins + (realizedUsd > 0 ? 1 : 0),
    pnlUsd: cur.pnlUsd + realizedUsd,
  };

  const newTotal = prev.totalPnlUsd + realizedUsd;
  const next: EdgeStats = {
    trades: prev.trades + 1,
    wins: prev.wins + (realizedUsd > 0 ? 1 : 0),
    losses: prev.losses + (realizedUsd <= 0 ? 1 : 0),
    totalPnlUsd: newTotal,
    peakPnlUsd: Math.max(prev.peakPnlUsd, newTotal),
    consecutiveLosses: realizedUsd > 0 ? 0 : prev.consecutiveLosses + 1,
    lastUpdatedMs: Date.now(),
    perAsset,
  };
  await setCronState(KEY_STATS, next);
  return next;
}

export async function applyDaily(prev: DailyStats, realizedUsd: number): Promise<DailyStats> {
  const today = utcDayKey(Date.now());
  const base: DailyStats = prev.utcDayKey === today
    ? prev
    : { utcDayKey: today, pnlUsd: 0, trades: 0 };
  const next: DailyStats = {
    utcDayKey: base.utcDayKey,
    pnlUsd: base.pnlUsd + realizedUsd,
    trades: base.trades + 1,
  };
  await setCronState(KEY_DAILY, next);
  return next;
}

/**
 * Closing-exit helper. Consolidates the ~15-line pattern shared by all
 * closing exit branches (trailing-stop, signal-flip, max-hold, slippage
 * emergency close). NOT used by the "position vanished" branch because
 * that path books a stake-cap loss without a real BluFin close.
 *
 * Side effects (in order):
 *   1. bf.closeHedge (via closeWithRetry)
 *   2. applyOutcome (writes KEY_STATS)
 *   3. applyDaily   (writes KEY_DAILY)
 *   4. maybeHalt    (may write KEY_HALTED_UNTIL)
 *   5. setCronState(KEY_ACTIVE, null) — always LAST so a retry after
 *      partial failure still sees the active trade and re-attempts.
 */
export async function finalizeClosingExit(args: {
  bf: BluefinService;
  active: ActiveTrade;
  refPrice: number;
  safeStats: EdgeStats;
  daily: DailyStats;
  haltedUntil: number;
}): Promise<{
  exitPrice: number;
  fees: number;
  realized: number;
  newStats: EdgeStats;
  newDaily: DailyStats;
  halted: boolean;
}> {
  const close = await closeWithRetry(args.bf, args.active.symbol);
  const exitPrice = pickExitPrice(close, args.refPrice, args.active.entryPrice);
  const fees = Number((close as { fees?: number }).fees) || 0;
  const dir = args.active.side === 'LONG' ? 1 : -1;
  const realized = (exitPrice - args.active.entryPrice) * args.active.size * dir - fees;
  const newStats = await applyOutcome(args.safeStats, realized, args.active.asset);
  const newDaily = await applyDaily(args.daily, realized);
  const halted = await maybeHalt(newStats, newDaily, args.haltedUntil);
  // Feed the (asset, side, conf-bucket, outcome) tuple to the
  // probability calibrator. Next time this bucket has a signal, the EV
  // gate will see the empirically-shrunken probability instead of the
  // raw (often mis-calibrated) confidence. Non-critical — swallows on
  // error, never blocks the close finalisation.
  await recordCalibrationOutcome({
    asset: args.active.asset,
    side: args.active.side,
    openConfidencePct: args.active.confidence,
    realizedPnl: realized,
  });
  await setCronState(KEY_ACTIVE, null);
  return { exitPrice, fees, realized, newStats, newDaily, halted };
}

export async function maybeHalt(
  stats: EdgeStats,
  daily: DailyStats,
  currentHaltUntil: number,
): Promise<boolean> {
  const decision = evaluateKillSwitch(stats, daily, currentHaltUntil, {
    maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES,
    maxDrawdownPct: MAX_DRAWDOWN_PCT,
    dailyLossCapUsd: DAILY_LOSS_CAP_USD,
    baseStakeUsd: BASE_STAKE_USD,
    haltDurationMs: HALT_DURATION_MS,
  });
  if (decision.trip && decision.untilMs) {
    await setCronState(KEY_HALTED_UNTIL, decision.untilMs);
    logger.warn('[PolymarketEdge] KILL SWITCH TRIPPED — halting 24h', {
      reason: decision.detail,
      consecutiveLosses: stats.consecutiveLosses,
      drawdown: decision.drawdownPct,
      totalPnlUsd: stats.totalPnlUsd,
      dailyPnlUsd: daily.pnlUsd,
    });
    await notifyDiscord(`KILL SWITCH TRIPPED — halting 24h (${decision.detail})`, 'KILL', {
      totalPnlUsd: stats.totalPnlUsd,
      peakPnlUsd: stats.peakPnlUsd,
      dailyPnlUsd: daily.pnlUsd,
      consecutiveLosses: stats.consecutiveLosses,
    });
  }
  return decision.halted;
}
