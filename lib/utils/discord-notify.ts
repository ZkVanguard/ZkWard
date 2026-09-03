/**
 * Lightweight Discord webhook notifier.
 *
 * Reads `DISCORD_WEBHOOK_URL` from env. If the env var is not set the
 * function silently no-ops — making this safe to call from any code path
 * without breaking environments where Discord isn't configured.
 *
 * Failures are swallowed (logged at debug) — alerting must never break
 * the surrounding workflow.
 */

import { logger } from './logger';

export type NotifyLevel = 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'KILL';

const LEVEL_PREFIX: Record<NotifyLevel, string> = {
  INFO: 'ℹ️',
  WARN: '⚠️',
  ERROR: '❌',
  TRADE: '💱',
  KILL: '🛑',
};

export async function notifyDiscord(
  message: string,
  level: NotifyLevel = 'INFO',
  context?: Record<string, unknown>,
): Promise<void> {
  // Gap 8: also append to cron_state ring buffer so alert-response-loop
  // can act on patterns (3 KILL/hr → auto-shrink spot). Fire-and-forget
  // so a DB blip never breaks the Discord path or its caller.
  // Chain tag: if context.chain is a string, propagate it so the
  // response loop can scope halt rules to the emitting chain. Absent =
  // legacy SUI (backfill-safe).
  if (level === 'KILL' || level === 'ERROR' || level === 'WARN') {
    const chain = typeof context?.chain === 'string' ? context.chain : undefined;
    void appendAlertLog({ at: Date.now(), level, message, chain }).catch(() => {});
  }

  const url = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  if (!url) return;

  const ctx = context && Object.keys(context).length
    ? '\n```\n' + JSON.stringify(context, null, 2).slice(0, 1500) + '\n```'
    : '';
  const content = `${LEVEL_PREFIX[level]} **[${level}]** ${message}${ctx}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.debug('[notifyDiscord] webhook returned non-2xx', { status: res.status });
    }
  } catch (e) {
    logger.debug('[notifyDiscord] post failed (non-fatal)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

const ALERT_LOG_KEY = 'alert-log:ring-buffer';
const ALERT_LOG_MAX = 200;

interface AlertLogEntry {
  at: number;
  level: NotifyLevel;
  message: string;
  chain?: string;
}

async function appendAlertLog(entry: AlertLogEntry): Promise<void> {
  const { getCronState, setCronState } = await import('@/lib/db/cron-state');
  const existing = (await getCronState<AlertLogEntry[]>(ALERT_LOG_KEY).catch(() => null)) || [];
  const trimmed = [...existing, entry].slice(-ALERT_LOG_MAX);
  await setCronState(ALERT_LOG_KEY, trimmed);
}

export async function readAlertLog(): Promise<AlertLogEntry[]> {
  const { getCronState } = await import('@/lib/db/cron-state');
  return (await getCronState<AlertLogEntry[]>(ALERT_LOG_KEY).catch(() => null)) || [];
}
