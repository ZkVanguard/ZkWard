/**
 * Per-chain auto-hedge halt helper.
 *
 * Kill-switch convention: `<CHAIN>_AUTO_HEDGE_DISABLE=1`. Each chain
 * has its own env var so halting Hedera doesn't halt SUI, and vice
 * versa. The legacy `SUI_AUTO_HEDGE_DISABLE` name is still respected
 * for SUI so existing runbooks / on-call procedures keep working.
 *
 * Add a new chain: just set `<CHAIN>_AUTO_HEDGE_DISABLE=1` in Vercel
 * env. No code change needed — the helper reads dynamically.
 */

import { envFlag } from './env-flag';

export function isChainAutoHedgeDisabled(
  chain: string,
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  const upper = chain.trim().toUpperCase();
  if (!upper) return false;
  // Per-chain override — the canonical form going forward.
  if (envFlag(`${upper}_AUTO_HEDGE_DISABLE`, source)) return true;
  // Legacy SUI name kept for back-compat with existing docs / runbooks.
  if (upper === 'SUI' && envFlag('SUI_AUTO_HEDGE_DISABLE', source)) return true;
  return false;
}
