/**
 * Per-chain halt: locks in cross-chain kill-switch isolation.
 *
 * Regression risk: if someone removes the per-chain lookup and hard-codes
 * SUI_AUTO_HEDGE_DISABLE again, a future Hedera/Sepolia halt would need
 * that env var set — meaning halting Hedera would halt SUI. This test
 * fails on that reintroduction.
 */
import { describe, it, expect } from '@jest/globals';
import { isChainAutoHedgeDisabled } from '@/lib/utils/chain-halt';

describe('isChainAutoHedgeDisabled', () => {
  it('honors per-chain kill switch', () => {
    expect(isChainAutoHedgeDisabled('hedera', { HEDERA_AUTO_HEDGE_DISABLE: '1' })).toBe(true);
    expect(isChainAutoHedgeDisabled('sepolia', { SEPOLIA_AUTO_HEDGE_DISABLE: '1' })).toBe(true);
    expect(isChainAutoHedgeDisabled('sui', { SUI_AUTO_HEDGE_DISABLE: '1' })).toBe(true);
  });

  it('does NOT halt other chains when only one chain is disabled (cross-chain isolation)', () => {
    const env = { HEDERA_AUTO_HEDGE_DISABLE: '1' };
    expect(isChainAutoHedgeDisabled('sui', env)).toBe(false);
    expect(isChainAutoHedgeDisabled('sepolia', env)).toBe(false);
    expect(isChainAutoHedgeDisabled('cronos', env)).toBe(false);
  });

  it('accepts new canonical env-flag shape for SUI', () => {
    expect(isChainAutoHedgeDisabled('sui', { SUI_AUTO_HEDGE_DISABLE: 'true' })).toBe(true);
    expect(isChainAutoHedgeDisabled('sui', { SUI_AUTO_HEDGE_DISABLE: 'yes' })).toBe(true);
    expect(isChainAutoHedgeDisabled('sui', { SUI_AUTO_HEDGE_DISABLE: 'on' })).toBe(true);
  });

  it('returns false for unset / empty / falsey values', () => {
    expect(isChainAutoHedgeDisabled('sui', {})).toBe(false);
    expect(isChainAutoHedgeDisabled('sui', { SUI_AUTO_HEDGE_DISABLE: '' })).toBe(false);
    expect(isChainAutoHedgeDisabled('sui', { SUI_AUTO_HEDGE_DISABLE: '0' })).toBe(false);
    expect(isChainAutoHedgeDisabled('sui', { SUI_AUTO_HEDGE_DISABLE: 'false' })).toBe(false);
  });

  it('returns false for empty chain name', () => {
    expect(isChainAutoHedgeDisabled('', { SUI_AUTO_HEDGE_DISABLE: '1' })).toBe(false);
  });

  it('is case-insensitive for chain name', () => {
    expect(isChainAutoHedgeDisabled('HEDERA', { HEDERA_AUTO_HEDGE_DISABLE: '1' })).toBe(true);
    expect(isChainAutoHedgeDisabled('Hedera', { HEDERA_AUTO_HEDGE_DISABLE: '1' })).toBe(true);
    expect(isChainAutoHedgeDisabled('  sui  ', { SUI_AUTO_HEDGE_DISABLE: '1' })).toBe(true);
  });
});
