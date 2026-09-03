/**
 * SafeExecutionGuard per-chain volume-bucket isolation.
 *
 * Regression risk: if the daily-volume check reverts to a single global
 * counter, one hot chain would exhaust the cap for every other chain.
 * This test fails on that reintroduction.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
// Import the class, not the `getSafeExecutionGuard` getter. Another
// test file (agent-trade-guard-decisions.test.ts) module-mocks the
// getter with a stub missing resetState — bun runs tests in one
// process and that mock can bleed into ours if we use the getter.
import { SafeExecutionGuard } from '@/agents/core/SafeExecutionGuard';

describe('SafeExecutionGuard — per-chain daily volume', () => {
  beforeEach(() => {
    SafeExecutionGuard.getInstance().resetState();
  });

  it('tracks volume in independent chain buckets', () => {
    const guard = SafeExecutionGuard.getInstance();
    guard.addVolume(1_000_000, 'sui');
    guard.addVolume(2_000_000, 'hedera');
    guard.addVolume(500_000, 'sepolia');

    const status = guard.getStatus();
    expect(status.dailyVolumeByChain.sui).toBe(1_000_000);
    expect(status.dailyVolumeByChain.hedera).toBe(2_000_000);
    expect(status.dailyVolumeByChain.sepolia).toBe(500_000);
    // Legacy aggregate still reflects the sum.
    expect(status.dailyVolumeUSD).toBe(3_500_000);
  });

  it('caps EACH chain independently — Hedera filling its cap does not block SUI', async () => {
    const guard = SafeExecutionGuard.getInstance();
    const cap = guard.getStatus().limits.maxDailyVolumeUSD;
    guard.addVolume(cap, 'hedera');

    // SUI can still validate a normal-sized trade.
    const suiValidation = await guard.validateExecution({
      executionId: 'test-sui-1',
      agentId: 'test-agent',
      action: 'open_hedge',
      positionSizeUSD: 10_000,
      chain: 'sui',
    });
    expect(suiValidation.errors.filter(e => e.includes('Daily volume'))).toHaveLength(0);

    // Hedera should now be over-cap.
    const hederaValidation = await guard.validateExecution({
      executionId: 'test-hedera-1',
      agentId: 'test-agent',
      action: 'open_hedge',
      positionSizeUSD: 10_000,
      chain: 'hedera',
    });
    expect(hederaValidation.errors.some(e => e.includes('Daily volume'))).toBe(true);
    expect(hederaValidation.errors.some(e => e.includes("chain='hedera'"))).toBe(true);
  });

  it('legacy calls without chain charge the shared default bucket, leave named chains alone', () => {
    const guard = SafeExecutionGuard.getInstance();
    guard.addVolume(5_000_000); // no chain — legacy SUI-only caller
    guard.addVolume(1_000_000, 'hedera');

    const status = guard.getStatus();
    expect(status.dailyVolumeByChain.default).toBe(5_000_000);
    expect(status.dailyVolumeByChain.hedera).toBe(1_000_000);
    expect(status.dailyVolumeByChain.sui).toBeUndefined();
  });
});
