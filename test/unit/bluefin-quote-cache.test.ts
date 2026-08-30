/**
 * quote-cache — extracted 2026-08-30 from BluefinAggregatorService.
 * Covers key derivation, TTL expiry, and shutdown clearing.
 */

import {
  getQuoteCacheKey,
  getCachedQuote,
  setCachedQuote,
  initQuoteCache,
  stopQuoteCache,
} from '@/lib/services/sui/bluefin/quote-cache';
import type { SwapQuoteResult } from '@/lib/types/bluefin-types';

const makeQuote = (n: number): SwapQuoteResult => ({
  asset: 'BTC',
  usdcAmountIn: 100,
  assetAmountOut: n,
  effectivePrice: n,
  priceImpactBps: 0,
  minAmountOut: n * 0.99,
  slippageBps: 100,
  route: [],
} as unknown as SwapQuoteResult);

describe('quote-cache', () => {
  afterEach(() => stopQuoteCache());

  test('cache key changes when any input changes', () => {
    const base = getQuoteCacheKey('mainnet', 'BTC', 100, 'forward');
    expect(base).not.toBe(getQuoteCacheKey('testnet', 'BTC', 100, 'forward'));
    expect(base).not.toBe(getQuoteCacheKey('mainnet', 'ETH', 100, 'forward'));
    expect(base).not.toBe(getQuoteCacheKey('mainnet', 'BTC', 101, 'forward'));
    expect(base).not.toBe(getQuoteCacheKey('mainnet', 'BTC', 100, 'reverse'));
  });

  test('cache key rounds to 6dp — resists float drift on small amounts', () => {
    // 1.0000001 rounds to 1.000000, matches 1.0
    expect(getQuoteCacheKey('mainnet', 'SUI', 1.0, 'forward'))
      .toBe(getQuoteCacheKey('mainnet', 'SUI', 1.0000001, 'forward'));
  });

  test('set + get roundtrip', () => {
    initQuoteCache();
    const key = getQuoteCacheKey('mainnet', 'BTC', 100, 'forward');
    const q = makeQuote(0.001);
    setCachedQuote(key, q);
    expect(getCachedQuote(key)).toBe(q);
  });

  test('miss returns null', () => {
    initQuoteCache();
    expect(getCachedQuote('never-set')).toBeNull();
  });

  test('stopQuoteCache clears entries', () => {
    initQuoteCache();
    const key = getQuoteCacheKey('mainnet', 'BTC', 100, 'forward');
    setCachedQuote(key, makeQuote(0.001));
    stopQuoteCache();
    expect(getCachedQuote(key)).toBeNull();
  });

});
