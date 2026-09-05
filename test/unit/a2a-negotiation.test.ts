/**
 * A2A protocol + bus + negotiate — lock the four things a competitor
 * plugging in via HCS-14 will depend on:
 *
 *   1. Protocol shape validation (bus rejects malformed messages).
 *   2. foldState — the message stream reduces to the right terminal
 *      state, so operator dashboards read the right badge.
 *   3. Provider discovery cheapest-under-budget rule + reason strings
 *      (visible in the demo endpoint response).
 *   4. End-to-end negotiate — full happy path emits proposal →
 *      acceptance → settlement with correlationId preserved across
 *      every message and the trace retrievable.
 *
 * Fetch mocked in-process so the x402 leg inside settle doesn't touch
 * a real facilitator.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const originalFetch = global.fetch;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  jest.resetAllMocks?.();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
  global.fetch = originalFetch;
  const { _clearSubscribersForTest } = await import('@/lib/services/a2a/bus');
  _clearSubscribersForTest();
});

function mockSequence(responses: Array<{ status: number; body: unknown }>): void {
  let i = 0;
  global.fetch = jest.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
}

describe('protocol — isValidMessage + foldState', () => {
  it('rejects messages missing envelope fields', async () => {
    const { isValidMessage } = await import('@/lib/services/a2a/protocol');
    expect(isValidMessage({})).toBe(false);
    expect(isValidMessage({ id: 'x' })).toBe(false);
    expect(isValidMessage({
      id: 'x', correlationId: 'c', from: 'a', at: 1, kind: 'proposal',
    })).toBe(true);
    expect(isValidMessage({
      id: 'x', correlationId: 'c', from: 'a', at: 1, kind: 'unknown',
    })).toBe(false);
  });

  it('foldState resolves to the strongest terminal', async () => {
    const { foldState } = await import('@/lib/services/a2a/protocol');
    const base = { id: 'x', correlationId: 'c', from: 'a', at: 1, kind: 'proposal' as const };
    expect(foldState([])).toBe('open');
    expect(foldState([base])).toBe('open');
    expect(foldState([base, { ...base, id: 'y', kind: 'counter-proposal' } as never])).toBe('countered');
    expect(foldState([base, { ...base, id: 'z', kind: 'acceptance' } as never])).toBe('accepted');
    expect(foldState([base, { ...base, id: 'r', kind: 'rejection' } as never])).toBe('rejected');
    expect(foldState([base, { ...base, id: 's', kind: 'settlement' } as never])).toBe('settled');
    // Settlement wins over acceptance in a mixed stream.
    expect(foldState([
      base,
      { ...base, id: 'a', kind: 'acceptance' } as never,
      { ...base, id: 's', kind: 'settlement' } as never,
    ])).toBe('settled');
  });
});

describe('discoverProviders — cheapest-under-budget rule', () => {
  const REG = [
    { id: 'a', url: 'https://a', service: 'signal-quality' as const, priceMicros: '500', network: 'hedera-testnet' as const, operator: 'x', latencyP95Ms: 200 },
    { id: 'b', url: 'https://b', service: 'signal-quality' as const, priceMicros: '250', network: 'hedera-testnet' as const, operator: 'x', latencyP95Ms: 800 },
    { id: 'c', url: 'https://c', service: 'signal-quality' as const, priceMicros: '250', network: 'hedera-testnet' as const, operator: 'x', latencyP95Ms: 500 },
    { id: 'other-service', url: 'https://d', service: 'risk-assessment' as const, priceMicros: '10', network: 'hedera-testnet' as const, operator: 'x' },
  ];

  it('picks the cheapest affordable provider', async () => {
    const { discoverProviders } = await import('@/lib/services/a2a/provider-registry');
    const r = discoverProviders({ service: 'signal-quality', maxPriceMicros: '400', registry: REG });
    expect(r.provider?.id).toBe('c'); // 250 tie-broken by lower latency
  });

  it('breaks ties by lower p95 latency', async () => {
    const { discoverProviders } = await import('@/lib/services/a2a/provider-registry');
    const r = discoverProviders({ service: 'signal-quality', maxPriceMicros: '250', registry: REG });
    expect(r.provider?.id).toBe('c'); // 500ms beats 800ms at same price
  });

  it('returns null with reason when budget too low', async () => {
    const { discoverProviders } = await import('@/lib/services/a2a/provider-registry');
    const r = discoverProviders({ service: 'signal-quality', maxPriceMicros: '100', registry: REG });
    expect(r.provider).toBeNull();
    expect(r.reason).toContain('cheapest available');
  });

  it('returns null with reason when service has no providers', async () => {
    const { discoverProviders } = await import('@/lib/services/a2a/provider-registry');
    const r = discoverProviders({ service: 'trade-execution', maxPriceMicros: '10000', registry: REG });
    expect(r.provider).toBeNull();
    expect(r.reason).toContain("no providers for service 'trade-execution'");
  });
});

describe('bus — publish + subscribe + getTrace', () => {
  it('routes to exact-recipient subscribers', async () => {
    const { publish, subscribe } = await import('@/lib/services/a2a/bus');
    const received: string[] = [];
    subscribe('did:test:agent-a', (m) => { received.push('A'); void m; });
    subscribe('did:test:agent-b', (m) => { received.push('B'); void m; });
    await publish({
      id: '1', correlationId: 'c1', from: 'sender', to: 'did:test:agent-a', at: Date.now(),
      kind: 'proposal', service: 'signal-quality', params: {}, maxBudgetMicros: '100',
    });
    expect(received).toEqual(['A']);
  });

  it('trace round-trips through Redis fallback / in-memory', async () => {
    const { publish, getTrace, _resetTraceForTest } = await import('@/lib/services/a2a/bus');
    await _resetTraceForTest('trace-test-1');
    await publish({
      id: 'p', correlationId: 'trace-test-1', from: 'a', at: 1, kind: 'proposal',
      service: 'signal-quality', params: {}, maxBudgetMicros: '100',
    });
    await publish({
      id: 'a', correlationId: 'trace-test-1', from: 'b', at: 2, kind: 'acceptance',
      proposalId: 'p', provider: 'https://x', priceMicros: '100',
    });
    const trace = await getTrace('trace-test-1');
    expect(trace).not.toBeNull();
    expect(trace!.state).toBe('accepted');
    expect(trace!.messages).toHaveLength(2);
  });
});

describe('negotiateAndFetch — full round-trip', () => {
  it('emits proposal → acceptance → settlement on happy path', async () => {
    // x402 endpoint returns 402 then 200 (as always).
    mockSequence([
      {
        status: 402,
        body: {
          intent: {
            scheme: 'exact', network: 'hedera-testnet',
            maxAmountRequired: '100', currency: 'USDC',
            payTo: '0xpay', facilitator: 'https://fac',
            resource: 'https://provider/x',
          },
        },
      },
      { status: 200, body: { signal: 'BULLISH', confidence: 78, reasoning: 'test' } },
    ]);

    const { _resetBudgetForTest } = await import('@/lib/services/x402/budget');
    await _resetBudgetForTest('demo-executor');
    process.env.X402_DAILY_BUDGET_MICROS = '10000';

    const { negotiateAndFetch } = await import('@/lib/services/a2a/negotiate');
    const registry = [{
      id: 'test-provider', url: 'https://provider/x',
      service: 'signal-quality' as const, priceMicros: '100',
      network: 'hedera-testnet' as const, operator: 'x',
      latencyP95Ms: 200,
    }];
    const r = await negotiateAndFetch({
      requesterDid: 'did:test:demo#analyst',
      responderDid: 'did:test:demo#executor',
      service: 'signal-quality',
      params: { asset: 'BTC' },
      maxBudgetMicros: '500',
      registry,
      correlationId: 'happy-1',
    });

    expect(r.ok).toBe(true);
    expect(r.paid).toBe(true);
    expect(r.data?.signal).toBe('BULLISH');
    expect(r.provider?.id).toBe('test-provider');
    expect(r.trace).toBeDefined();
    expect(r.trace!.state).toBe('settled');
    const kinds = r.trace!.messages.map((m) => m.kind);
    expect(kinds).toEqual(['proposal', 'acceptance', 'settlement']);
  });

  it('rejects when no providers and budget too low', async () => {
    const { negotiateAndFetch } = await import('@/lib/services/a2a/negotiate');
    const registry = [{
      id: 'expensive', url: 'https://expensive/x',
      service: 'signal-quality' as const, priceMicros: '10000',
      network: 'hedera-testnet' as const, operator: 'x',
    }];
    const r = await negotiateAndFetch({
      requesterDid: 'did:test#analyst',
      responderDid: 'did:test#executor',
      service: 'signal-quality',
      params: { asset: 'BTC' },
      maxBudgetMicros: '100', // < 10000
      counterToleranceMicros: '0', // reject any counter
      registry,
      correlationId: 'reject-1',
    });
    expect(r.ok).toBe(false);
    expect(r.paid).toBe(false);
    expect(r.trace!.state).toBe('rejected');
  });
});
