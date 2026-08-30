/**
 * BlueFin aggregator quote cache — 15s TTL Map + periodic cleanup.
 *
 * Extracted from BluefinAggregatorService (2026-08-30) to keep the
 * cache lifecycle self-contained. Callsites use the four exported
 * helpers instead of touching the internal Map directly.
 *
 * Deliberately SDK-free (no @bluefin-exchange/bluefin7k-aggregator-sdk
 * import) so jest can load it without the SDK's `getQuote.js` require-
 * chain running at module init. quoteSources() stays in the aggregator
 * file where the SDK is already resolved.
 */

import type { SwapQuoteResult } from '@/lib/types/bluefin-types';

interface QuoteCacheEntry {
  quote: SwapQuoteResult;
  expiresAt: number;
}

const QUOTE_CACHE_TTL_MS = 15_000;
const quoteCache = new Map<string, QuoteCacheEntry>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of quoteCache) {
      if (entry.expiresAt < now) quoteCache.delete(key);
    }
  }, 60_000);
  if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

/** Called on service construction — arms the periodic sweeper. */
export function initQuoteCache(): void {
  ensureCleanupTimer();
}

/** Graceful shutdown / serverless termination. */
export function stopQuoteCache(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  quoteCache.clear();
}

/**
 * Cache key — fixed-point precision to avoid float-drift collisions
 * on small amounts (0.000001 vs 0.0000010000001).
 */
export function getQuoteCacheKey(
  network: string,
  asset: string,
  amount: number,
  direction: 'forward' | 'reverse',
): string {
  return `${network}:${asset}:${amount.toFixed(6)}:${direction}`;
}

export function getCachedQuote(key: string): SwapQuoteResult | null {
  const entry = quoteCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    quoteCache.delete(key);
    return null;
  }
  return entry.quote;
}

export function setCachedQuote(key: string, quote: SwapQuoteResult): void {
  quoteCache.set(key, { quote, expiresAt: Date.now() + QUOTE_CACHE_TTL_MS });
}
